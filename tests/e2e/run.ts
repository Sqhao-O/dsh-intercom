/**
 * dsh-intercom e2e driver (`pnpm test:e2e`). Not part of `pnpm test`: it boots
 * REAL dsh processes against mock LLM servers, so it needs a built lib/ and
 * takes seconds rather than milliseconds.
 *
 * M2 cross-process scenario:
 *   1. Two mock LLM servers, one per process (positional request sequences are
 *      per server): the planner mock scripts `intercom({action:"send"})` for
 *      the first turn and plain text afterwards; the worker mock scripts
 *      `intercom({action:"ask"})` for its first (relay-woken) turn.
 *   2. A per-run scratch DSH_HOME under tests/e2e/.tmp — shared by BOTH dsh
 *      child processes, because broker discovery is keyed by the intercom
 *      state dir (the first process auto-spawns the broker, the second
 *      connects to it). The real ~/.dsh is never touched.
 *   3. A generated patch overlay disables the headless one-shot runner and the
 *      LLM session titler (it would consume mock sequence entries), then
 *      inserts dsh-intercom (compiled lib/) and the scenario plugin.
 *   4. Proc A (planner) and proc B (worker) run concurrently; after B exits
 *      with PASS, proc B2 (worker relaunch, same session id/alias/cwd) runs
 *      against the same DSH_HOME and receives the queued mailbox message.
 *
 * Each runner prints `[e2e:<role>] PASS` and exits 0; this driver mirrors
 * child output and fails on any non-zero exit or missing PASS.
 *
 * Windows-safe: the dsh bin is resolved from `npm root -g` (or $DSH_BIN) and
 * spawned through process.execPath.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import type { MockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(E2E_DIR, "..", "..");
const TMP_DIR = join(E2E_DIR, ".tmp");
const RUN_ID = Date.now().toString(36);
const DSH_HOME = join(TMP_DIR, `dsh-home-${RUN_ID}`);
const CHILD_TIMEOUT_MS = 150_000;

function resolveDshBin(): string {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // npm is a .cmd shim on Windows; route through the shell so it resolves.
  const globalRoot = execFileSync("npm root -g", {
    encoding: "utf8",
    shell: true,
  }).trim();
  return join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

interface ChildResult {
  code: number | null;
  output: string;
}

interface ChildHandle {
  proc: ChildProcess;
  done: Promise<ChildResult>;
  /** Resolves once the child prints the marker; rejects if it exits first. */
  waitFor(marker: string): Promise<void>;
}

/**
 * Spawn one dsh process; `done` resolves when it exits (killed on timeout).
 * Callers must stagger concurrent FIRST boots of a fresh DSH_HOME: dsh's
 * profile preparation materializes symlinks under <DSH_HOME>/profiles and is
 * not safe against two processes doing it at the same instant (EEXIST).
 */
function runDsh(
  bin: string,
  patchPath: string,
  role: "planner" | "worker",
  phase: "main" | "reconnect",
  mock: MockLlmServer,
): ChildHandle {
  const proc = spawn(
    process.execPath,
    [bin, "--profile", "headless", "--patch", patchPath],
    {
      env: {
        ...process.env,
        DSH_HOME,
        DEEPSEEK_BASE_URL: mock.baseURL,
        DEEPSEEK_API_KEY: "e2e-mock-key",
        E2E_ROLE: role,
        E2E_PHASE: phase,
        DSH_INTERCOM_ASK_TIMEOUT_MS: "60000",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const chunks: string[] = [];
  const markerWaiters: Array<{
    marker: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const onChunk = (chunk: Buffer) => {
    const text = String(chunk);
    chunks.push(text);
    for (let index = markerWaiters.length - 1; index >= 0; index -= 1) {
      if (chunks.join("").includes(markerWaiters[index]!.marker)) {
        markerWaiters[index]!.resolve();
        markerWaiters.splice(index, 1);
      }
    }
  };
  proc.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    onChunk(chunk);
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    onChunk(chunk);
  });

  const done = new Promise<ChildResult>((resolvePromise) => {
    const killer = setTimeout(() => {
      proc.kill();
      resolvePromise({ code: null, output: chunks.join("") });
    }, CHILD_TIMEOUT_MS);
    proc.on("exit", (exitCode) => {
      clearTimeout(killer);
      for (const waiter of markerWaiters.splice(0)) {
        waiter.reject(
          new Error(`process exited before printing ${waiter.marker}`),
        );
      }
      resolvePromise({ code: exitCode, output: chunks.join("") });
    });
  });

  return {
    proc,
    done,
    waitFor: (marker) =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        if (chunks.join("").includes(marker)) {
          resolvePromise();
          return;
        }
        markerWaiters.push({
          marker,
          resolve: resolvePromise,
          reject: rejectPromise,
        });
      }),
  };
}

function assertPass(label: string, result: ChildResult): void {
  assert.ok(
    result.code !== null,
    `${label}: dsh process timed out after ${CHILD_TIMEOUT_MS}ms`,
  );
  assert.equal(result.code, 0, `${label}: dsh process exited non-zero`);
  assert.ok(
    result.output.includes("PASS"),
    `${label}: scenario did not report PASS`,
  );
  console.log(`[e2e] driver: ${label} exited 0 with PASS`);
}

/** Best-effort cleanup of the auto-spawned broker keyed to the scratch home. */
async function killScratchBroker(): Promise<void> {
  try {
    const pid = Number.parseInt(
      await readFile(join(DSH_HOME, "intercom", "broker.pid"), "utf8"),
      10,
    );
    if (Number.isFinite(pid)) process.kill(pid);
  } catch {
    // No broker (or already gone) — nothing to do.
  }
}

async function main(): Promise<void> {
  const pluginEntry = join(REPO_ROOT, "lib", "src", "index.js");
  assert.ok(
    existsSync(pluginEntry),
    "lib/src/index.js missing — run `pnpm build` first",
  );

  const plannerMock = await startMockLlmServer({
    port: 0,
    sequence: ["tool_call_success", "success"],
    repeatLast: true,
    toolName: "intercom",
    toolArguments: JSON.stringify({
      action: "send",
      to: "worker",
      message: "hello from planner",
    }),
    successText: "planner mock ack",
  });
  const workerMock = await startMockLlmServer({
    port: 0,
    sequence: ["tool_call_success", "success"],
    repeatLast: true,
    toolName: "intercom",
    toolArguments: JSON.stringify({
      action: "ask",
      to: "planner",
      message: "what is the status?",
    }),
    successText: "worker mock ack",
  });

  const children: ChildProcess[] = [];
  try {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(DSH_HOME, { recursive: true });

    const patchPath = join(TMP_DIR, `e2e-${RUN_ID}.patch.yml`);
    const patch = `# Generated by tests/e2e/run.ts — scratch headless profile overlay.
# The LLM titler would consume mock sequence entries; the one-shot runner
# requires a task positional. The e2e runner plugin drives the scenario itself.
- id: session-title-llm
  disabled: true
- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true

- insert:
    - id: dsh-intercom
      name: '${pathToFileURL(pluginEntry).href}'
    - id: dsh-intercom-e2e
      name: '${pathToFileURL(join(E2E_DIR, "runner-plugin.mjs")).href}'
`;
    await writeFile(patchPath, patch);

    const bin = resolveDshBin();

    // Phase 1: planner (A) and worker (B) in two separate dsh processes
    // sharing the scratch DSH_HOME (and therefore the socket broker). A boots
    // first: concurrent first-boots of a fresh DSH_HOME race in dsh's profile
    // preparation, so B starts once A's runner plugin is up.
    const procA = runDsh(bin, patchPath, "planner", "main", plannerMock);
    children.push(procA.proc);
    await procA.waitFor("[e2e:planner] agent created");

    const procB = runDsh(bin, patchPath, "worker", "main", workerMock);
    children.push(procB.proc);

    const resultB = await procB.done;
    assertPass("worker (proc B)", resultB);

    // Phase 2: relaunch the worker against the same DSH_HOME; the broker
    // flushes the queued mailbox message. The planner is still alive and
    // waits for the worker to re-register before passing.
    const procB2 = runDsh(bin, patchPath, "worker", "reconnect", workerMock);
    children.push(procB2.proc);

    const [resultA, resultB2] = await Promise.all([procA.done, procB2.done]);
    assertPass("planner (proc A)", resultA);
    assertPass("worker relaunch (proc B2)", resultB2);

    console.log("[e2e] driver: cross-process scenario complete");
  } finally {
    for (const child of children) child.kill();
    await killScratchBroker();
    await plannerMock.close();
    await workerMock.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[e2e] driver failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
