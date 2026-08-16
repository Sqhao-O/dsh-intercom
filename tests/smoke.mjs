// Smoke test for the compiled broker artifact (run `pnpm build` first).
//
// Spawns `node lib/broker/broker.js` with DSH_HOME pointed at a temp dir,
// connects two compiled lib/broker/client.js clients, registers two sessions,
// sends a message from one to the other, and asserts receipt. Cleans up the
// broker process and the temp dir on exit.
//
// Usage: node tests/smoke.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const brokerPath = path.join(repoRoot, "lib", "broker", "broker.js");
const dshHome = mkdtempSync(path.join(tmpdir(), "dsh-intercom-smoke-"));

// Client modules resolve the broker address from DSH_HOME at connect time.
process.env.DSH_HOME = dshHome;

const broker = spawn(process.execPath, [brokerPath], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ["ignore", "pipe", "pipe"],
});

let brokerStdout = "";
let brokerStderr = "";
broker.stdout.on("data", (chunk) => (brokerStdout += chunk.toString()));
broker.stderr.on("data", (chunk) => (brokerStderr += chunk.toString()));

async function waitForBrokerReady() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (brokerStdout.includes("Intercom broker started")) return;
    if (broker.exitCode !== null) {
      throw new Error(
        `Broker exited early (code ${broker.exitCode})\n${brokerStderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Broker startup timed out\nstdout:\n${brokerStdout}\nstderr:\n${brokerStderr}`,
  );
}

function registration(name) {
  return {
    name,
    cwd: repoRoot,
    model: "smoke-test",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

async function main() {
  await waitForBrokerReady();

  const { IntercomClient } = await import(
    pathToFileURL(path.join(repoRoot, "lib", "broker", "client.js")).href
  );

  const alice = new IntercomClient();
  const bob = new IntercomClient();
  const bobMessages = [];

  try {
    await alice.connect(registration("smoke-alice"), "smoke-alice");
    await bob.connect(registration("smoke-bob"), "smoke-bob");
    bob.on("message", (from, message) => bobMessages.push({ from, message }));

    const sessions = await alice.listSessions();
    const names = sessions.map((session) => session.name).toSorted();
    assert.deepEqual(
      names,
      ["smoke-alice", "smoke-bob"],
      "both sessions should be registered",
    );

    const result = await alice.send("smoke-bob", { text: "hello from alice" });
    assert.equal(
      result.delivered,
      true,
      `send should be delivered, got ${JSON.stringify(result)}`,
    );

    const deadline = Date.now() + 5_000;
    while (bobMessages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      bobMessages.length,
      1,
      "bob should have received exactly one message",
    );
    assert.equal(bobMessages[0].message.content.text, "hello from alice");
    assert.equal(bobMessages[0].from.name, "smoke-alice");
  } finally {
    await Promise.all([
      alice.disconnect().catch(() => undefined),
      bob.disconnect().catch(() => undefined),
    ]);
  }

  console.log(
    "smoke test passed: compiled broker delivered a message between two compiled clients",
  );
}

try {
  await main();
} finally {
  if (broker.exitCode === null) broker.kill("SIGTERM");
  rmSync(dshHome, { recursive: true, force: true });
}
