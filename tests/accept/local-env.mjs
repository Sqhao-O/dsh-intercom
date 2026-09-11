/**
 * Real-environment acceptance (`pnpm test:accept`). NOT part of `pnpm test`:
 * boots a REAL `dsh web` server against the CURRENT DSH_HOME (default: the
 * real ~/.dsh) where dsh-intercom is already installed into the web profile
 * (`dsh plugin --profile web add github:Sqhao-O/dsh-intercom`), and verifies
 * the plugin end to end in the user's actual environment:
 *   1. the intercom tool is registered and the bundled dsh-intercom skill is
 *      listed by the profile's skill registry (probe),
 *   2. the probe's accept-planner-* / accept-worker-* agents are named via
 *      the tool, the broker auto-spawns under the real ~/.dsh/intercom
 *      (broker.pid) and planner's intercom list shows the worker,
 *   3. panel wiring on the real web server: GET /intercom/roster lists both
 *      sessions, POST /intercom/send (planner → worker) lands in the worker's
 *      durable session log with source kind "intercom" and wakes it, and a
 *      non-local `from` is rejected with 400,
 *   4. worker → planner ask/reply through the real tool pipeline (the ask
 *      blocks across the broker until the reply action unblocks it),
 *   5. the browser half is served at /plugins/dsh-intercom/client.js.
 *
 * Safety contract:
 *   - All LLM traffic goes to the repo mock server via child-process env
 *     (DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY=test) — no real model API call,
 *     and ~/.dsh/settings.yaml is never touched.
 *   - The ONLY real-profile modification is one appended probe row in the web
 *     profile's cordis.patch.yml. The original bytes are copied to
 *     cordis.patch.yml.accept-backup first and restored byte-identical
 *     (sha256-verified) in cleanup, including on SIGINT/SIGTERM.
 *   - Probe session ids are unique per run (accept-*-<ts>); they persist
 *     under ~/.dsh/sessions/ and are listed at the end.
 *   - The acceptance-spawned dsh web process is stopped at the end; the
 *     broker self-exits when idle (its state dir is the plugin's own).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

const ACCEPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUN_TS = Date.now().toString(36);
const PLANNER_ID = `accept-planner-${RUN_TS}`;
const WORKER_ID = `accept-worker-${RUN_TS}`;
const RELAY_BODY = `real-env-accept-${RUN_TS}`;
const ASK_BODY = `accept-ask-${RUN_TS}`;
const REPLY_BODY = `accept-reply-${RUN_TS}`;
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PATCH_PATH = join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
const BACKUP_PATH = `${PATCH_PATH}.accept-backup`;
const BROKER_PID_PATH = join(DSH_HOME, "intercom", "broker.pid");
const BOOT_TIMEOUT_MS = 150_000;
const OVERALL_TIMEOUT_MS = 240_000;
const out = (line) => process.stdout.write(`[accept] ${line}\n`);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // npm is a .cmd shim on Windows; route through the shell so it resolves.
  const globalRoot = execFileSync("npm root -g", {
    encoding: "utf8",
    shell: true,
  }).trim();
  return join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** Boot `dsh web` on an OS-assigned port; parse the URL line from stdout. */
function bootWeb(bin, mockBaseURL) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [bin, "web", "--port", "0"], {
      env: {
        ...process.env,
        DEEPSEEK_BASE_URL: mockBaseURL,
        DEEPSEEK_API_KEY: "test",
        NO_COLOR: "1",
        ACCEPT_PLANNER_ID: PLANNER_ID,
        ACCEPT_WORKER_ID: WORKER_ID,
        ACCEPT_RELAY_BODY: RELAY_BODY,
        ACCEPT_ASK_BODY: ASK_BODY,
        ACCEPT_REPLY_BODY: REPLY_BODY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const waiters = new Set();
    const handle = {
      proc,
      baseURL: "",
      output: () => output,
      waitFor: (marker) =>
        new Promise((resolveMarker, rejectMarker) => {
          if (output.includes(marker)) {
            resolveMarker();
          } else {
            waiters.add({
              marker,
              resolve: resolveMarker,
              reject: rejectMarker,
            });
          }
        }),
    };
    const onExit = (code) => {
      const error = new Error(
        `dsh web exited early (${code}):\n${output.slice(-4000)}`,
      );
      for (const waiter of waiters) {
        waiters.delete(waiter);
        waiter.reject(error);
      }
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };
    const onChunk = (chunk) => {
      output += String(chunk);
      process.stdout.write(String(chunk));
      const match = /dsh web: (http:\/\/\S+)/.exec(output);
      if (match && !settled) {
        settled = true;
        handle.baseURL = match[1];
        resolvePromise(handle);
      }
      for (const waiter of waiters) {
        if (output.includes(waiter.marker)) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    const killer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error("dsh web did not print its URL in time"));
    }, BOOT_TIMEOUT_MS);
    proc.on("exit", (code) => {
      clearTimeout(killer);
      onExit(code);
    });
  });
}

/** Poll a JSON endpoint until the predicate accepts the payload. */
async function pollJson(url, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        const body = await res.json();
        if (predicate(body)) return body;
        lastError = new Error(`predicate not met: ${JSON.stringify(body)}`);
      } else {
        lastError = new Error(`GET ${url} → ${res.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out polling ${url}: ${lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main() {
  assert.ok(
    existsSync(
      join(
        DSH_HOME,
        "profiles",
        "web",
        "node_modules",
        "dsh-intercom",
        "lib",
        "src",
        "index.js",
      ),
    ),
    `dsh-intercom is not installed into the web profile under ${DSH_HOME} — ` +
      "run `dsh plugin --profile web add github:Sqhao-O/dsh-intercom` first",
  );
  const bin = resolveDshBin();
  out(`DSH_HOME=${DSH_HOME}`);
  out(`dsh bin=${bin}`);
  out(`run ids: planner=${PLANNER_ID} worker=${WORKER_ID}`);

  // Back up the real profile patch (byte-exact) before touching it; restore
  // is synchronous so SIGINT/SIGTERM handlers can run it too.
  const hadPatch = existsSync(PATCH_PATH);
  const originalPatch = hadPatch ? readFileSync(PATCH_PATH) : null;
  const originalHash = originalPatch ? sha256(originalPatch) : null;
  if (originalPatch) copyFileSync(PATCH_PATH, BACKUP_PATH);
  let restored = false;
  const restorePatch = () => {
    if (restored) return;
    restored = true;
    if (originalPatch) {
      writeFileSync(PATCH_PATH, originalPatch);
      const nowHash = sha256(readFileSync(PATCH_PATH));
      assert.equal(
        nowHash,
        originalHash,
        `patch restore hash mismatch — original backup is at ${BACKUP_PATH}`,
      );
      rmSync(BACKUP_PATH, { force: true });
      out(
        `cordis.patch.yml restored byte-identical (sha256 ${originalHash.slice(0, 16)}…)`,
      );
    } else {
      rmSync(PATCH_PATH, { force: true });
      out("cordis.patch.yml removed (the profile had none before this run)");
    }
  };

  const mock = await startMockLlmServer({
    port: 0,
    sequence: ["success"],
    repeatLast: true,
    successText: "accept ack",
  });
  let web;
  const cleanup = () => {
    try {
      web?.proc.kill();
    } catch {
      // Already gone.
    }
    restorePatch();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      out(`caught ${signal} — cleaning up`);
      cleanup();
      void mock.close().finally(() => process.exit(1));
    });
  }
  const overall = setTimeout(() => {
    out(`FAIL overall timeout (${OVERALL_TIMEOUT_MS / 1000}s) — cleaning up`);
    cleanup();
    void mock.close().finally(() => process.exit(1));
  }, OVERALL_TIMEOUT_MS);

  try {
    // The probe row is the ONLY modification to real profile state.
    const probeUrl = pathToFileURL(join(ACCEPT_DIR, "probe.mjs")).href;
    const separator =
      originalPatch && !originalPatch.toString("utf8").endsWith("\n")
        ? "\n"
        : "";
    const probeRow =
      `${separator}\n# Temporary row added by tests/accept/local-env.mjs — ` +
      `removed on exit (original restored byte-identical).\n- insert:\n` +
      `    - id: dsh-intercom-accept-probe\n      name: '${probeUrl}'\n`;
    writeFileSync(
      PATCH_PATH,
      Buffer.concat([
        originalPatch ?? Buffer.alloc(0),
        Buffer.from(probeRow, "utf8"),
      ]),
    );
    out("probe row appended to the web profile patch (backup taken)");

    web = await bootWeb(bin, mock.baseURL);
    out(`web server up: ${web.baseURL}`);

    // 1. Tool + skill registration inside the real profile.
    await web.waitFor("[accept-probe] assert1 ok");
    out(
      "PASS 1/5 — intercom tool registered and dsh-intercom skill listed (real web profile)",
    );

    // 2. Named probe agents + broker auto-spawn + cross-session list.
    await web.waitFor("[accept-probe] ready:");
    await web.waitFor("[accept-probe] assert2 ok");
    assert.ok(
      existsSync(BROKER_PID_PATH),
      `broker.pid missing at ${BROKER_PID_PATH} — broker did not auto-spawn`,
    );
    out(
      "PASS 2/5 — probe agents named via the tool; broker auto-spawned " +
        "(~/.dsh/intercom/broker.pid); planner list shows the worker",
    );

    // 3. Panel wiring: roster, send (relay + wake), and the 400 rejection.
    const roster = await pollJson(
      `${web.baseURL}/intercom/roster`,
      (body) =>
        body.transport === "broker" &&
        body.sessions?.some((session) => session.id === PLANNER_ID) &&
        body.sessions?.some((session) => session.id === WORKER_ID),
    );
    const plannerSender = roster.senders.find(
      (sender) => sender.id === PLANNER_ID,
    );
    assert.ok(plannerSender, "planner missing from the roster senders list");
    const sendRes = await fetch(`${web.baseURL}/intercom/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: plannerSender.id,
        to: "worker",
        message: RELAY_BODY,
      }),
    });
    const sendBody = await sendRes.json();
    assert.equal(sendRes.status, 200, `send → ${sendRes.status}`);
    assert.equal(sendBody.delivered, true, "send not delivered");
    await web.waitFor("[accept-probe] assert3 ok");
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
    out(
      "PASS 3/5 — roster lists both sessions; panel send relayed into the " +
        "worker's session log (source kind intercom) and woke it; non-local from → 400",
    );

    // 4. ask/reply between the two real-env sessions through the tool.
    await web.waitFor("[accept-probe] assert4 ok");
    out(
      "PASS 4/5 — worker ask blocked across the real broker and unblocked " +
        "with the planner's reply text",
    );

    // 5. The browser half on the real web server.
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
    out(
      "PASS 5/5 — client.js served at /plugins/dsh-intercom/client.js on the real web server",
    );

    out("PASS — all 5 real-environment assertions hold");
  } finally {
    clearTimeout(overall);
    cleanup();
    await mock.close();
    out(
      `probe sessions created (persist under ~/.dsh/sessions/): ${PLANNER_ID}, ${WORKER_ID}`,
    );
  }
}

main().catch((error) => {
  console.error(
    `[accept] FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
