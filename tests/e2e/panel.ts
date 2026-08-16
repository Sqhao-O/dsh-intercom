/**
 * Web UI panel e2e (`pnpm test:panel`). Not part of `pnpm test`: it boots a
 * REAL `dsh web` server against a mock LLM with dsh-intercom link-installed
 * into a scratch DSH_HOME, and verifies the panel's full wiring:
 *   1. `dsh plugin --profile web add link:<checkout>` composes the bundle.
 *   2. The browser half is served at /plugins/dsh-intercom/client.js and
 *      appears in the index.html __DSH_BOOT__ graph (the dsh.client scan).
 *   3. GET /intercom/roster lists the probe's planner/worker sessions through
 *      the broker (the settings-section panel's data source).
 *   4. POST /intercom/send delivers a real broker message from the planner to
 *      the worker (asserted in the worker's durable session log by the probe).
 *
 * The probe plugin is inserted through the scratch profile's user patch layer
 * (`dsh web` accepts no --patch flag). The real ~/.dsh is never touched.
 *
 * Windows-safe: the dsh bin is resolved from `npm root -g` (or $DSH_BIN).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(E2E_DIR, "..", "..");
const TMP_DIR = join(E2E_DIR, ".tmp");
const RUN_ID = Date.now().toString(36);
const DSH_HOME = join(TMP_DIR, `panel-home-${RUN_ID}`);
const CHILD_TIMEOUT_MS = 150_000;
const out = (line: string) => process.stdout.write(`[panel] ${line}\n`);

function resolveDshBin(): string {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // npm is a .cmd shim on Windows; route through the shell so it resolves.
  const globalRoot = execFileSync("npm root -g", {
    encoding: "utf8",
    shell: true,
  }).trim();
  return join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** Run the dsh CLI to completion with the scratch DSH_HOME. */
function runDshCli(bin: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, DSH_HOME, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    const killer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`dsh ${args.join(" ")} timed out`));
    }, CHILD_TIMEOUT_MS);
    proc.on("exit", (code) => {
      clearTimeout(killer);
      if (code === 0) resolvePromise(chunks.join(""));
      else
        rejectPromise(
          new Error(
            `dsh ${args.join(" ")} exited ${code}:\n${chunks.join("")}`,
          ),
        );
    });
  });
}

interface WebHandle {
  proc: ChildProcess;
  baseURL: string;
  output: () => string;
  waitFor(marker: string): Promise<void>;
}

/** Boot `dsh web` on an OS-assigned port; parse the URL line from stdout. */
function bootWeb(bin: string, mockBaseURL: string): Promise<WebHandle> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [bin, "web", "--port", "0"], {
      env: {
        ...process.env,
        DSH_HOME,
        DEEPSEEK_BASE_URL: mockBaseURL,
        DEEPSEEK_API_KEY: "panel-e2e-mock-key",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    const markerWaiters: Array<{ marker: string; resolve: () => void }> = [];
    const onChunk = (chunk: Buffer) => {
      const text = String(chunk);
      chunks.push(text);
      process.stdout.write(text);
      const match = /dsh web: (http:\/\/\S+)/.exec(chunks.join(""));
      if (match) {
        resolvePromise({
          proc,
          baseURL: match[1]!,
          output: () => chunks.join(""),
          waitFor: (marker) =>
            new Promise<void>((resolveMarker) => {
              if (chunks.join("").includes(marker)) resolveMarker();
              else markerWaiters.push({ marker, resolve: resolveMarker });
            }),
        });
      }
      for (const waiter of markerWaiters.splice(0)) {
        if (chunks.join("").includes(waiter.marker)) waiter.resolve();
      }
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    const killer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error("dsh web did not print its URL in time"));
    }, CHILD_TIMEOUT_MS);
    proc.on("exit", (code) => {
      clearTimeout(killer);
      rejectPromise(
        new Error(`dsh web exited early (${code}):\n${chunks.join("")}`),
      );
    });
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} → ${res.status}`);
  return res.json();
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
  assert.ok(
    existsSync(join(REPO_ROOT, "lib", "src", "index.js")),
    "lib/src/index.js missing — run `pnpm build` first",
  );
  assert.ok(
    existsSync(join(REPO_ROOT, "client.js")),
    "client.js (browser half) missing",
  );

  const mock = await startMockLlmServer({
    port: 0,
    sequence: ["success"],
    repeatLast: true,
    successText: "panel probe ack",
  });
  let web: WebHandle | undefined;
  try {
    await rm(DSH_HOME, { recursive: true, force: true });
    await mkdir(DSH_HOME, { recursive: true });
    const bin = resolveDshBin();

    // 1. Install the checkout into the web profile (the link: flow; the
    //    github:/tarball flows compose identically — install-preview covers
    //    the tarball, dod-install covers github:).
    await runDshCli(bin, [
      "plugin",
      "--profile",
      "web",
      "add",
      `link:${REPO_ROOT}`,
    ]);
    out("link: install composed into the web profile");

    // 2. Insert the probe plugin through the profile's user patch layer.
    const userPatchPath = join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
    await writeFile(
      userPatchPath,
      `# Generated by tests/e2e/panel.ts — scratch web profile user layer.
# The titler would consume mock sequence entries; the probe drives agents.
- id: session-title-llm
  disabled: true

- insert:
    - id: dsh-intercom-panel-probe
      name: '${pathToFileURL(join(E2E_DIR, "panel-probe.mjs")).href}'
`,
    );

    // 3. Boot the web server and wait for the probe's two named sessions.
    web = await bootWeb(bin, mock.baseURL);
    out(`web server up: ${web.baseURL}`);
    await web.waitFor("[panel-probe] ready:");
    out("probe created and named planner + worker");

    // 4. The browser half must be served and wired into the boot graph.
    const clientRes = await fetch(
      `${web.baseURL}/plugins/dsh-intercom/client.js`,
    );
    assert.equal(clientRes.status, 200, "client.js not served");
    const clientSource = await clientRes.text();
    assert.ok(
      clientSource.includes("__ModuleLoader__.load") &&
        clientSource.includes("settings.section"),
      "served client.js is not the dsh-intercom browser half",
    );
    const indexHtml = await (await fetch(`${web.baseURL}/`)).text();
    const bootMatch = /window\.__DSH_BOOT__ = (\{[\s\S]*?\})<\/script>/.exec(
      indexHtml,
    );
    assert.ok(bootMatch, "index.html has no __DSH_BOOT__ manifest");
    const boot = JSON.parse(bootMatch[1]!) as {
      entries: Array<{ id: string }>;
    };
    assert.ok(
      boot.entries.some((entry) => entry.id === "dsh-intercom"),
      "boot graph does not list the dsh-intercom client entry",
    );
    out("client bundle served and present in the boot graph");

    // 5. The roster endpoint (the settings-section panel's data source).
    const roster = (await fetchJson(`${web.baseURL}/intercom/roster`)) as {
      enabled: boolean;
      transport: string;
      sessions: Array<{ id: string; name: string | null; local: boolean }>;
      senders: Array<{ id: string; name: string | null }>;
    };
    assert.equal(roster.enabled, true, "roster reports disabled");
    assert.equal(roster.transport, "broker", "roster not on the broker");
    const names = roster.sessions.map((session) => session.name);
    assert.ok(
      names.includes("planner") && names.includes("worker"),
      `roster missing probe sessions: ${JSON.stringify(names)}`,
    );
    const planner = roster.senders.find((sender) => sender.name === "planner");
    assert.ok(planner, "planner missing from the senders list");
    out("roster endpoint lists planner + worker through the broker");

    // 6. The send endpoint: a real broker send from the planner, landing in
    //    the worker's session log (probe asserts the relay).
    const sendRes = await fetch(`${web.baseURL}/intercom/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: planner.id,
        to: "worker",
        message: "panel-send-check",
      }),
    });
    const sendBody = (await sendRes.json()) as { delivered?: boolean };
    assert.equal(sendRes.status, 200, `send → ${sendRes.status}`);
    assert.equal(sendBody.delivered, true, "send not delivered");
    await web.waitFor("[panel-probe] relay delivered");
    out("panel send crossed the broker into the worker's session log");

    // 7. Input validation: sending from a non-local session is rejected.
    const badRes = await fetch(`${web.baseURL}/intercom/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "not-a-local-session",
        to: "worker",
        message: "x",
      }),
    });
    assert.equal(badRes.status, 400, `bad from → ${badRes.status}`);
    out("send from a non-local session is rejected (400)");

    out("PASS");
  } finally {
    web?.proc.kill();
    await killScratchBroker();
    await mock.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[panel] FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
