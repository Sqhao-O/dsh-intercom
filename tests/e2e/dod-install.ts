/**
 * Final Definition-of-Done e2e (`pnpm test:dod`). Not part of `pnpm test`:
 * this is the real acceptance — install the plugin from the pushed GitHub
 * repo exactly as a user/agent would, into a fresh scratch DSH_HOME, then
 * prove two sessions coordinate through the INSTALLED package.
 *
 *   1. Fresh scratch DSH_HOME (unique per run, under tests/e2e/.tmp).
 *   2. `dsh plugin --profile web add github:Sqhao-O/dsh-intercom` as a child
 *      process. Two environment realities are encoded:
 *      - pnpm resolves the `github:` shorthand via SSH (git@github.com:…);
 *        this machine reaches github.com:443 but not :22, so the child env
 *        carries a git url.insteadOf rewrite (GIT_CONFIG_*) — the same
 *        rewrite a user behind such a firewall would configure once.
 *      - pnpm ≥10 blocks a git dep's `prepare` script behind
 *        onlyBuiltDependencies. The M4 package.json has no `prepare`, so
 *        post-M4 installs are clean; while the pushed HEAD still has one,
 *        the script follows the CLI's own hint (append the allowlist to the
 *        profile's pnpm-workspace.yaml) and re-runs — exactly what the DoD
 *        prompt flow would do.
 *   3. `dsh --profile web --dump-config` must list the dsh-intercom row.
 *   4. Two headless dsh processes (mock LLMs, no API key) share the scratch
 *      DSH_HOME; the patch inserts the INSTALLED package's lib/src/index.js
 *      (from profiles/web/node_modules — not the repo checkout). planner
 *      sends "dod-check" to worker (assert: relay in the worker log + the
 *      worker woke), worker asks planner and receives the scripted reply.
 *   5. PASS summary.
 *
 * Windows-safe: the dsh bin is resolved from `npm root -g` (or $DSH_BIN) and
 * spawned through process.execPath.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import type { MockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(E2E_DIR, ".tmp");
const RUN_ID = Date.now().toString(36);
const DSH_HOME = join(TMP_DIR, `dod-home-${RUN_ID}`);
const INSTALL_TIMEOUT_MS = 300_000; // git fetch can be slow
const CHILD_TIMEOUT_MS = 150_000;

const out = (line: string) => process.stdout.write(`[dod] ${line}\n`);

function resolveDshBin(): string {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // npm is a .cmd shim on Windows; route through the shell so it resolves.
  const globalRoot = execFileSync("npm root -g", {
    encoding: "utf8",
    shell: true,
  }).trim();
  return join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

/**
 * Child env for git-invoking processes: rewrite SSH github URLs to HTTPS.
 * pnpm's `github:` shorthand resolves to git@github.com:… (SSH, port 22);
 * where that port is blocked the rewrite is the difference between a timeout
 * and a successful install. Harmless where SSH works.
 */
const GIT_URL_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
};

interface CliResult {
  code: number | null;
  output: string;
}

function runDshCli(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        ...GIT_URL_ENV,
        DSH_HOME,
        DEEPSEEK_API_KEY: "dod-mock-key",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    const killer = setTimeout(() => {
      proc.kill();
      resolvePromise({
        code: null,
        output: `${chunks.join("")}\n[timed out after ${timeoutMs}ms]`,
      });
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(killer);
      resolvePromise({ code, output: chunks.join("") });
    });
  });
}

/** Step 2: the real install command, with the CLI-hint allowlist fallback. */
async function installFromGithub(bin: string): Promise<void> {
  const args = [
    "plugin",
    "--profile",
    "web",
    "add",
    "github:Sqhao-O/dsh-intercom",
  ];
  // github.com reachability from this network is intermittently flaky
  // (schannel handshake resets); the allowlist branch runs at most once.
  const MAX_ATTEMPTS = 4;
  let allowlisted = false;
  let result: CliResult | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await runDshCli(bin, args, INSTALL_TIMEOUT_MS);
    if (result.code === 0) {
      break;
    }
    if (!allowlisted && result.output.includes("onlyBuiltDependencies")) {
      // The CLI's own hint: allow the git dep's prepare script, then re-run.
      // (Only needed while the pushed HEAD still carries a prepare script;
      // the M4 package.json dropped it precisely so this branch goes away.)
      out("pnpm blocked the git dep's prepare script — applying the CLI hint");
      await appendFile(
        join(DSH_HOME, "profiles", "web", "pnpm-workspace.yaml"),
        'onlyBuiltDependencies:\n  - "dsh-intercom"\n',
      );
      allowlisted = true;
      continue;
    }
    if (
      /schannel|unable to access|Could not read from remote|Connection timed out|Connection reset|Failed to connect/i.test(
        result.output,
      ) &&
      attempt < MAX_ATTEMPTS
    ) {
      out(`install attempt ${attempt} hit a network error; retrying`);
      continue;
    }
    break;
  }
  assert.equal(
    result?.code,
    0,
    `dsh plugin add github: failed:\n${result?.output ?? "no attempt ran"}`,
  );
  out("github: install succeeded");
}

interface ChildResult {
  code: number | null;
  output: string;
}

interface ChildHandle {
  proc: ChildProcess;
  done: Promise<ChildResult>;
  waitFor(marker: string): Promise<void>;
}

/**
 * Spawn one dsh process; `done` resolves when it exits (killed on timeout).
 * Stagger concurrent FIRST boots of a fresh DSH_HOME: dsh's profile
 * preparation is not safe against two simultaneous first boots (EEXIST).
 */
function runDsh(
  bin: string,
  patchPath: string,
  role: "planner" | "worker",
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
        DEEPSEEK_API_KEY: "dod-mock-key",
        E2E_ROLE: role,
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
      new Promise<void>((resolvePromise2, rejectPromise) => {
        if (chunks.join("").includes(marker)) {
          resolvePromise2();
          return;
        }
        markerWaiters.push({
          marker,
          resolve: resolvePromise2,
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
  out(`${label} exited 0 with PASS`);
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
  const plannerMock = await startMockLlmServer({
    port: 0,
    sequence: ["tool_call_success", "success"],
    repeatLast: true,
    toolName: "intercom",
    toolArguments: JSON.stringify({
      action: "send",
      to: "worker",
      message: "dod-check",
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
      message: "dod-question",
    }),
    successText: "worker mock ack",
  });

  const children: ChildProcess[] = [];
  try {
    // 1. Fresh scratch DSH_HOME.
    await rm(DSH_HOME, { recursive: true, force: true });
    await mkdir(DSH_HOME, { recursive: true });
    const bin = resolveDshBin();

    // 2. Install from GitHub exactly as a user/agent would.
    await installFromGithub(bin);

    // 3. The web profile's composed config must list the plugin row.
    const dump = await runDshCli(
      bin,
      ["--profile", "web", "--dump-config"],
      CHILD_TIMEOUT_MS,
    );
    assert.equal(dump.code, 0, `dump-config failed:\n${dump.output}`);
    assert.ok(
      dump.output.includes("dsh-intercom"),
      "dump-config does not list dsh-intercom",
    );
    out("dump-config lists the dsh-intercom row");

    // 4. Two dsh processes over the INSTALLED package (not the repo checkout).
    const installedEntry = join(
      DSH_HOME,
      "profiles",
      "web",
      "node_modules",
      "dsh-intercom",
      "lib",
      "src",
      "index.js",
    );
    assert.ok(
      existsSync(installedEntry),
      `installed plugin entry missing at ${installedEntry}`,
    );
    out("installed package contains the compiled entry");

    const patchPath = join(TMP_DIR, `dod-${RUN_ID}.patch.yml`);
    await writeFile(
      patchPath,
      `# Generated by tests/e2e/dod-install.ts — scratch headless profile overlay.
# The LLM titler would consume mock sequence entries; the one-shot runner
# requires a task positional. The DoD runner plugin drives the scenario itself.
- id: session-title-llm
  disabled: true
- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true

- insert:
    - id: dsh-intercom
      name: '${pathToFileURL(installedEntry).href}'
    - id: dsh-intercom-dod
      name: '${pathToFileURL(join(E2E_DIR, "dod-runner.mjs")).href}'
`,
    );

    const procA = runDsh(bin, patchPath, "planner", plannerMock);
    children.push(procA.proc);
    await procA.waitFor("[dod:planner] agent created");

    const procB = runDsh(bin, patchPath, "worker", workerMock);
    children.push(procB.proc);

    const [resultA, resultB] = await Promise.all([procA.done, procB.done]);
    assertPass("planner", resultA);
    assertPass("worker", resultB);

    // 5. Summary.
    out("PASS — installed from github:, composed in the web profile, and");
    out("      planner→worker send + worker→planner ask/reply verified across");
    out("      two dsh processes through the installed package.");
  } finally {
    for (const child of children) child.kill();
    await killScratchBroker();
    await plannerMock.close();
    await workerMock.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[dod] FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
