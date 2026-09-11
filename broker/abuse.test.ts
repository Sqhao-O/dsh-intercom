/**
 * Malformed-frame / abuse tests against a real broker spawned from TypeScript
 * source via `node --import tsx` (same harness as broker/extension.test.ts),
 * each test with its own scratch DSH_HOME.
 *
 * Asserts the vendored broker's actual defensive behavior (see framing.ts and
 * broker.ts): a malformed frame, a protocol violation, or an exhausted
 * per-connection rate-limit token bucket destroys ONLY the offending
 * connection — the broker process stays alive and keeps serving legit clients.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionRegistration } from "../types.ts";
import { IntercomClient } from "./client.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath } from "./paths.ts";

const repoDir = process.cwd();

function registration(name: string): SessionRegistration {
  return {
    name,
    cwd: "/test",
    model: "test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

async function startBroker(
  homeDir: string,
): Promise<ChildProcessWithoutNullStreams> {
  const broker = spawn(
    process.execPath,
    ["--import", "tsx", path.join(repoDir, "broker", "broker.ts")],
    {
      cwd: repoDir,
      env: { ...process.env, DSH_HOME: homeDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Broker startup timed out")),
      15_000,
    );
    broker.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    broker.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Broker exited before startup (${code ?? signal})`));
    });
  });
  await ready;
  return broker;
}

async function stopBroker(
  broker: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (broker.exitCode !== null || broker.signalCode !== null) return;
  broker.kill("SIGTERM");
  const exited = await Promise.race([
    once(broker, "exit").then(() => true),
    new Promise<false>((resolve) => setTimeout(resolve, 2000, false)),
  ]);
  if (exited) return;
  // Escalate so a wedged broker can never hang the test file.
  broker.kill("SIGKILL");
  await once(broker, "exit").catch(() => undefined);
}

interface RawProbe {
  socket: net.Socket;
  messages: unknown[];
  errors: Error[];
  /** Resolves true when the broker closes the connection. */
  closed: Promise<boolean>;
}

/** Connect a raw socket to the broker under the given scratch home. */
async function connectRaw(homeDir: string): Promise<RawProbe> {
  const socket = net.connect(getBrokerSocketPath(process.platform, homeDir));
  await once(socket, "connect");
  const messages: unknown[] = [];
  const errors: Error[] = [];
  socket.on(
    "data",
    createMessageReader(
      (msg) => messages.push(msg),
      (error) => errors.push(error),
    ),
  );
  // The broker destroys abusive connections with an error attached, which
  // surfaces client-side as ECONNRESET — record it instead of letting the
  // unhandled 'error' event kill the test.
  socket.on("error", (error) => errors.push(error));
  // events.once rejects when 'error' fires before 'close', but a reset
  // connection is still a closed connection for these assertions.
  const closed = once(socket, "close").then(
    () => true,
    () => true,
  );
  return { socket, messages, errors, closed };
}

/** Race the connection close against a timeout; true = broker hung up. */
async function awaitsClosed(
  probe: RawProbe,
  timeoutMs = 3000,
): Promise<boolean> {
  return Promise.race([
    probe.closed,
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

/**
 * Liveness assertion: a fresh raw connection can run the pre-register health
 * probe, and a real client can still register and exchange a message with a
 * second client.
 */
async function assertBrokerAlive(homeDir: string): Promise<void> {
  const health = await connectRaw(homeDir);
  try {
    writeMessage(health.socket, { type: "health", requestId: "alive-check" });
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !health.messages.some(
        (msg) =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: unknown }).type === "health_ok",
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      health.messages.some(
        (msg) =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: unknown }).type === "health_ok",
      ),
      "broker did not answer the health probe",
    );
  } finally {
    health.socket.destroy();
  }

  const first = new IntercomClient();
  const second = new IntercomClient();
  try {
    await first.connect(registration("alive-a"));
    await second.connect(registration("alive-b"));
    const received = once(second, "message");
    const sent = await first.send(second.sessionId!, { text: "still alive" });
    assert.equal(sent.delivered, true);
    const [, message] = (await received) as [
      unknown,
      { content: { text: string } },
    ];
    assert.equal(message.content.text, "still alive");
  } finally {
    await first.disconnect().catch(() => undefined);
    await second.disconnect().catch(() => undefined);
  }
}

/** Write a frame manually (raw length prefix + payload, no JSON encoding). */
function writeRawFrame(
  socket: net.Socket,
  payload: Buffer,
  declaredLength = payload.length,
): void {
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(declaredLength, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

test(
  "malformed frames and protocol violations kill only the offending connection",
  { concurrency: false, timeout: 60_000 },
  async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-abuse-"));
    const previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = homeDir;
    const broker = await startBroker(homeDir);
    try {
      // 1. A frame whose payload is not JSON: parse failure destroys the socket.
      // (The broker reports the reason via destroy(error), not a frame, so the
      // client just sees the connection die.)
      const garbage = await connectRaw(homeDir);
      writeRawFrame(garbage.socket, Buffer.from("this is not json", "utf8"));
      assert.equal(
        await awaitsClosed(garbage),
        true,
        "garbage JSON payload: connection should be closed",
      );

      // 2. A truncated length prefix is tolerated mid-stream (partial reads are
      // normal), then the unregistered-connection timeout reaps the socket.
      const truncated = await connectRaw(homeDir);
      truncated.socket.write(Buffer.from([0, 0]));
      assert.equal(
        await awaitsClosed(truncated, 250),
        false,
        "a partial header alone must not kill the connection",
      );
      assert.equal(
        await awaitsClosed(truncated, 3000),
        true,
        "registration timeout should reap the stalled connection",
      );

      // 3. A declared frame length beyond the 1 MiB cap destroys the socket
      // before any payload is read.
      const oversized = await connectRaw(homeDir);
      writeRawFrame(oversized.socket, Buffer.alloc(0), 0x7fffffff);
      assert.equal(
        await awaitsClosed(oversized),
        true,
        "oversized frame: connection should be closed",
      );

      // 4. Valid JSON that fails protocol validation (register with a
      // non-string cwd): handler throws, the reader reports, socket destroyed.
      const invalidRegister = await connectRaw(homeDir);
      writeMessage(invalidRegister.socket, {
        type: "register",
        session: { ...registration("bad"), cwd: 123 },
      });
      assert.equal(
        await awaitsClosed(invalidRegister),
        true,
        "invalid register: connection should be closed",
      );

      // 5. Out-of-order protocol: anything but register/health before register.
      const outOfOrder = await connectRaw(homeDir);
      writeMessage(outOfOrder.socket, { type: "list", requestId: "early" });
      assert.equal(
        await awaitsClosed(outOfOrder),
        true,
        "list before register: connection should be closed",
      );

      // 6. Unknown message type after a successful register.
      const unknown = await connectRaw(homeDir);
      writeMessage(unknown.socket, {
        type: "register",
        sessionId: "abuse-unknown",
        session: registration("abuse-unknown"),
      });
      const registeredDeadline = Date.now() + 3000;
      while (
        Date.now() < registeredDeadline &&
        !unknown.messages.some(
          (msg) =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: unknown }).type === "registered",
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        unknown.messages.some(
          (msg) =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: unknown }).type === "registered",
        ),
        "raw client failed to register",
      );
      writeMessage(unknown.socket, { type: "frobnicate" });
      assert.equal(
        await awaitsClosed(unknown),
        true,
        "unknown message type: connection should be closed",
      );

      // After all of the above, the broker still serves legit clients.
      await assertBrokerAlive(homeDir);
    } finally {
      await stopBroker(broker);
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

test(
  "per-connection rate limit kicks in under a message flood",
  { concurrency: false, timeout: 60_000 },
  async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-flood-"));
    const previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = homeDir;
    const broker = await startBroker(homeDir);
    try {
      const flood = await connectRaw(homeDir);
      writeMessage(flood.socket, {
        type: "register",
        sessionId: "abuse-flood",
        session: registration("abuse-flood"),
      });
      const registeredDeadline = Date.now() + 3000;
      while (
        Date.now() < registeredDeadline &&
        !flood.messages.some(
          (msg) =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: unknown }).type === "registered",
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Token bucket: capacity 240, refill 120/s (broker.ts). 400 list
      // requests in one burst exhaust it well before refill matters. The
      // broker then writes an "error" frame and immediately destroys the
      // socket — the frame races the destroy, so the only reliable
      // client-side signal is the connection closing.
      for (let index = 0; index < 400; index += 1) {
        writeMessage(flood.socket, {
          type: "list",
          requestId: `flood-${index}`,
        });
      }
      assert.equal(
        await awaitsClosed(flood, 5000),
        true,
        "rate-limited connection should be closed",
      );
      const rateLimitFrame = flood.messages.find(
        (msg) =>
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: unknown }).type === "error" &&
          /rate limit exceeded/i.test(
            String((msg as { error?: unknown }).error),
          ),
      );
      if (rateLimitFrame) {
        assert.match(
          String((rateLimitFrame as { error: unknown }).error),
          /rate limit exceeded/i,
        );
      }

      // Throttling one connection does not affect the broker.
      await assertBrokerAlive(homeDir);
    } finally {
      await stopBroker(broker);
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
);
