/**
 * Integration tests against a real broker, ported and adapted from
 * pi-intercom's `intercom.integration.test.ts` (see NOTICE).
 *
 * Part A exercises the vendored broker/client modules directly (stable IDs,
 * ask edges, mailbox redelivery rules, presence coalescing) — the broker runs
 * from TypeScript source via `node --import tsx` (tsx is a dev dependency),
 * like broker/extension.test.ts. Parts exercising non-vendored pi modules (the
 * pi extension harness, subagent supervisor, tmux panes, TUI overlays,
 * extension bus) are dropped; the dsh plugin side is covered in Part B, which
 * runs OUR tool + BrokerTransport against the same real broker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { IntercomConfig } from "../src/config.ts";
import { SessionRegistry } from "../src/registry.ts";
import { createIntercomTool } from "../src/tool.ts";
import { BrokerTransport } from "../src/transport/broker.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { Message, SessionInfo } from "../types.ts";

const repoDir = process.cwd();
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-home-"));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = sharedHomeDir;
const { IntercomClient } = await import("../broker/client.ts");
process.on("exit", () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

type Client = InstanceType<typeof IntercomClient>;

/**
 * Spawns the broker from source as a DIRECT child (`node --import tsx`)
 * rather than through the tsx CLI wrapper. The wrapper sits between the test
 * and the broker, and on unix a wedged wrapper can swallow SIGTERM while the
 * broker grandchild lingers without ever listening — CI hung for hours on
 * exactly that. A direct child answers SIGTERM itself, and stopBroker
 * escalates to SIGKILL so teardown can never wait forever.
 */
function spawnBroker(): { broker: ChildProcess; brokerLog: () => string } {
  const broker = spawn(
    process.execPath,
    ["--import", "tsx", path.join(repoDir, "broker", "broker.ts")],
    {
      cwd: repoDir,
      env: { ...process.env, DSH_HOME: sharedHomeDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let captured = "";
  const remember = (chunk: Buffer) => {
    captured = (captured + chunk.toString()).slice(-8192);
    // TEMPORARY debug tee for the CI hang investigation — removed with the
    // debug-unix-hang job.
    const teePath = process.env.DSH_INTERCOM_TEST_TEE;
    if (teePath) {
      appendFileSync(teePath, chunk);
    }
  };
  (broker.stdout as NodeJS.ReadableStream | null)?.on("data", remember);
  (broker.stderr as NodeJS.ReadableStream | null)?.on("data", remember);
  return { broker, brokerLog: () => captured };
}

async function waitForBrokerExit(
  broker: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (broker.exitCode !== null || broker.signalCode !== null) {
    return true;
  }
  return Promise.race([
    once(broker, "exit").then(() => true),
    new Promise<false>((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function stopBroker(broker: ChildProcess): Promise<void> {
  if (await waitForBrokerExit(broker, 0)) return;
  broker.kill("SIGTERM");
  if (await waitForBrokerExit(broker, 2000)) return;
  broker.kill("SIGKILL");
  await waitForBrokerExit(broker, 2000);
}

async function waitForBrokerReady(
  broker: ChildProcess,
  brokerLog: () => string,
): Promise<void> {
  const stdout = (broker as ChildProcess & { stdout?: unknown }).stdout;
  if (!stdout || typeof (stdout as { on?: unknown }).on !== "function") {
    throw new Error("Broker stdout is unavailable");
  }
  const out = stdout as NodeJS.ReadableStream;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Broker startup timed out; broker output:\n${brokerLog()}`),
      );
    }, 10_000);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Broker exited before startup (code=${code}, signal=${signal}); broker output:\n${brokerLog()}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      out.off("data", onData);
      broker.off("exit", onExit);
    };
    out.on("data", onData);
    broker.once("exit", onExit);
  });
}

async function setupClients() {
  const { broker, brokerLog } = spawnBroker();

  try {
    await waitForBrokerReady(broker, brokerLog);
    const planner = new IntercomClient();
    const orchestrator = new IntercomClient();

    await planner.connect(registration("planner"));
    await orchestrator.connect(registration("orchestrator"));

    return {
      planner,
      orchestrator,
      cleanup: async () => {
        await planner.disconnect().catch(() => undefined);
        await orchestrator.disconnect().catch(() => undefined);
        await stopBroker(broker);
      },
    };
  } catch (error) {
    await stopBroker(broker);
    throw error;
  }
}

function registration(name: string, cwd: string = repoDir) {
  return {
    name,
    cwd,
    model: "test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
}

async function connectRawRegistered(sessionId: string, name: string) {
  const net = await import("node:net");
  const { getBrokerSocketPath } = await import("../broker/paths.ts");
  const { createMessageReader, writeMessage } =
    await import("../broker/framing.ts");
  const socket = net.connect(getBrokerSocketPath());
  await once(socket, "connect");
  const registered = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Raw register timed out")),
      2000,
    );
    const reader = createMessageReader((msg) => {
      if (
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        msg.type === "registered"
      ) {
        clearTimeout(timeout);
        socket.off("data", reader);
        resolve();
      }
    }, reject);
    socket.on("data", reader);
  });
  writeMessage(socket, {
    type: "register",
    sessionId,
    session: registration(name),
  });
  await registered;
  return { socket, writeMessage };
}

async function waitForSessionId(
  client: Client,
  sessionId: string,
): Promise<SessionInfo> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find(
      (candidate) => candidate.id === sessionId,
    );
    if (session) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(
    `Timed out waiting for ${sessionId}; saw ${JSON.stringify(sessions.map((session) => session.id))}`,
  );
}

async function waitForNoSessionId(
  client: Client,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (
      !(await client.listSessions()).some(
        (candidate) => candidate.id === sessionId,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${sessionId} to leave`);
}

// ---------------------------------------------------------------------------
// Part A: vendored broker/client behavior (ported from pi-intercom).
// ---------------------------------------------------------------------------

test(
  "broker accepts caller supplied stable IDs across reconnect",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const worker = new IntercomClient();

    try {
      await worker.connect(registration("stable-worker"), "stable-session-id");
      assert.equal(worker.sessionId, "stable-session-id");
      await waitForSessionId(planner, "stable-session-id");
      await worker.disconnect();
      await waitForNoSessionId(planner, "stable-session-id");

      const reconnected = new IntercomClient();
      await reconnected.connect(
        registration("stable-worker"),
        "stable-session-id",
      );
      assert.equal(reconnected.sessionId, "stable-session-id");
      await waitForSessionId(planner, "stable-session-id");
      await reconnected.disconnect();
    } finally {
      await worker.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker resolves unique short IDs and rejects ambiguous prefixes",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const first = new IntercomClient();
    const second = new IntercomClient();

    try {
      await first.connect(registration("short-id-one"), "abcdef12-session");
      await second.connect(registration("short-id-two"), "abcdef99-session");

      const received = once(first, "message") as Promise<
        [SessionInfo, Message]
      >;
      const unique = await planner.send("abcdef12", { text: "prefix works" });
      assert.equal(unique.delivered, true);
      const [, message] = await received;
      assert.equal(message.content.text, "prefix works");

      const ambiguous = await planner.send("abcdef", { text: "ambiguous" });
      assert.equal(ambiguous.delivered, false);
      assert.match(ambiguous.reason ?? "", /Multiple sessions/);

      const exactNameReceived = once(orchestrator, "message") as Promise<
        [SessionInfo, Message]
      >;
      const exactName = await planner.send("orchestrator", {
        text: "exact name wins",
      });
      assert.equal(exactName.delivered, true);
      const [, exactNameMessage] = await exactNameReceived;
      assert.equal(exactNameMessage.content.text, "exact name wins");
    } finally {
      await first.disconnect().catch(() => undefined);
      await second.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker rejects unknown replyTo values instead of delivering forged replies",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();

    try {
      const result = await planner.send(orchestrator.sessionId!, {
        text: "This is not a real reply.",
        replyTo: "not-a-pending-ask",
      });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /pending ask/i);
    } finally {
      await cleanup();
    }
  },
);

test(
  "broker refuses reverse mutual asks until the original ask is answered",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();

    try {
      const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
        messageId: "planner-to-orchestrator",
        text: "Can you decide?",
        expectsReply: true,
      });
      assert.equal(askToOrchestrator.delivered, true);

      const reverseAsk = await orchestrator.send(planner.sessionId!, {
        messageId: "orchestrator-to-planner",
        text: "Can you decide instead?",
        expectsReply: true,
      });
      assert.equal(reverseAsk.delivered, false);
      assert.match(reverseAsk.reason ?? "", /Mutual ask refused/);

      const plainSend = await orchestrator.send(planner.sessionId!, {
        text: "Plain update still works.",
      });
      assert.equal(plainSend.delivered, true);

      const reply = await orchestrator.send(planner.sessionId!, {
        text: "Answered.",
        replyTo: "planner-to-orchestrator",
      });
      assert.equal(reply.delivered, true);

      const nextAsk = await orchestrator.send(planner.sessionId!, {
        messageId: "orchestrator-to-planner-after-reply",
        text: "Now can I ask?",
        expectsReply: true,
      });
      assert.equal(nextAsk.delivered, true);
    } finally {
      await cleanup();
    }
  },
);

test(
  "a reply can start a new reverse ask",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();

    try {
      const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
        messageId: "planner-to-orchestrator-transition",
        text: "Can you decide?",
        expectsReply: true,
      });
      assert.equal(askToOrchestrator.delivered, true);

      const replyAndAsk = await orchestrator.send(planner.sessionId!, {
        messageId: "orchestrator-reply-and-ask",
        text: "I answered; can you decide the next thing?",
        replyTo: "planner-to-orchestrator-transition",
        expectsReply: true,
      });
      assert.equal(replyAndAsk.delivered, true);

      const plannerReverseAsk = await planner.send(orchestrator.sessionId!, {
        messageId: "planner-reverse-while-orchestrator-waits",
        text: "Can I ask while you wait?",
        expectsReply: true,
      });
      assert.equal(plannerReverseAsk.delivered, false);
      assert.match(plannerReverseAsk.reason ?? "", /Mutual ask refused/);
    } finally {
      await cleanup();
    }
  },
);

test(
  "failed replies do not clear broker mutual-ask edges",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();

    try {
      const askToOrchestrator = await planner.send(orchestrator.sessionId!, {
        messageId: "planner-to-orchestrator-missing-reply",
        text: "Can you decide?",
        expectsReply: true,
      });
      assert.equal(askToOrchestrator.delivered, true);

      const missingReply = await orchestrator.send("missing-session", {
        messageId: "reply-to-missing-session",
        text: "Answered, maybe?",
        replyTo: "planner-to-orchestrator-missing-reply",
      });
      assert.equal(missingReply.delivered, false);
      assert.match(missingReply.reason ?? "", /Session not found/);

      const reverseAsk = await orchestrator.send(planner.sessionId!, {
        messageId: "reverse-after-missing-reply",
        text: "Can I ask now?",
        expectsReply: true,
      });
      assert.equal(reverseAsk.delivered, false);
      assert.match(reverseAsk.reason ?? "", /Mutual ask refused/);

      const deliveredReply = await orchestrator.send(planner.sessionId!, {
        messageId: "reply-to-planner",
        text: "Actually answered.",
        replyTo: "planner-to-orchestrator-missing-reply",
      });
      assert.equal(deliveredReply.delivered, true);

      const nextAsk = await orchestrator.send(planner.sessionId!, {
        messageId: "reverse-after-delivered-reply",
        text: "Now can I ask?",
        expectsReply: true,
      });
      assert.equal(nextAsk.delivered, true);
    } finally {
      await cleanup();
    }
  },
);

test(
  "broker rejects blocking asks to disconnected targets",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();

    try {
      const disconnectedId = planner.sessionId!;
      await planner.disconnect();
      const result = await orchestrator.send(disconnectedId, {
        messageId: "offline-broker-ask",
        text: "Do not queue this blocking request.",
        expectsReply: true,
      });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /not currently connected/);
      assert.match(result.reason ?? "", /not queued/);
    } finally {
      await cleanup();
    }
  },
);

test(
  "broker queues replies to recently disconnected named senders",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const replacement = new IntercomClient();

    try {
      const originalPlannerId = planner.sessionId!;
      const receivedAsk = once(orchestrator, "message") as Promise<
        [SessionInfo, Message]
      >;
      assert.equal(
        (
          await planner.send(orchestrator.sessionId!, {
            messageId: "ephemeral-cli-ask",
            text: "Can you answer later?",
            expectsReply: true,
          })
        ).delivered,
        true,
      );
      await receivedAsk;
      await planner.disconnect();

      const queuedReply = once(replacement, "message") as Promise<
        [SessionInfo, Message]
      >;
      const reply = await orchestrator.send(originalPlannerId, {
        messageId: "queued-reply-to-ephemeral",
        text: "Queued answer.",
        replyTo: "ephemeral-cli-ask",
      });
      assert.equal(reply.delivered, true);

      await replacement.connect(registration("planner"));
      const [from, message] = await queuedReply;
      assert.equal(from.id, orchestrator.sessionId);
      assert.equal(message.id, "queued-reply-to-ephemeral");
      assert.equal(message.replyTo, "ephemeral-cli-ask");
      assert.equal(message.content.text, "Queued answer.");
      assert.equal(typeof message.brokerReceivedAt, "number");
      assert.equal(typeof message.brokerDeliveredAt, "number");
    } finally {
      await replacement.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker never remaps a disconnected mailbox back to the sending session",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const sender = new IntercomClient();
    const replacement = new IntercomClient();

    try {
      const disconnectedId = planner.sessionId!;
      await planner.disconnect();
      await sender.connect(registration("planner"));
      const senderId = sender.sessionId!;

      const selfDeliveries: Message[] = [];
      sender.on("message", (_from: SessionInfo, message: Message) =>
        selfDeliveries.push(message),
      );
      const result = await sender.send(disconnectedId, {
        messageId: "no-self-mailbox-remap",
        text: "Queue this for the disconnected session.",
      });
      assert.equal(result.delivered, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(selfDeliveries, []);

      await sender.disconnect();
      await sender.connect(registration("planner"), senderId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(selfDeliveries, []);

      const queuedMessage = once(replacement, "message") as Promise<
        [SessionInfo, Message]
      >;
      await replacement.connect(registration("planner"), disconnectedId);
      const [, message] = await queuedMessage;
      assert.equal(message.id, "no-self-mailbox-remap");
    } finally {
      await sender.disconnect().catch(() => undefined);
      await replacement.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker keeps queued mail away from a same-name session in another cwd",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const otherProject = new IntercomClient();

    try {
      const originalPlannerId = planner.sessionId!;
      const receivedAsk = once(orchestrator, "message") as Promise<
        [SessionInfo, Message]
      >;
      assert.equal(
        (
          await planner.send(orchestrator.sessionId!, {
            messageId: "cross-cwd-ask",
            text: "Answer later?",
            expectsReply: true,
          })
        ).delivered,
        true,
      );
      await receivedAsk;
      await planner.disconnect();

      assert.equal(
        (
          await orchestrator.send(originalPlannerId, {
            messageId: "cross-cwd-answer",
            text: "Answer for the original project.",
            replyTo: "cross-cwd-ask",
          })
        ).delivered,
        true,
      );

      const received: Message[] = [];
      otherProject.on("message", (_from: SessionInfo, message: Message) =>
        received.push(message),
      );
      await otherProject.connect(
        registration("planner", path.join(repoDir, "other-project")),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.deepEqual(received, []);
    } finally {
      await otherProject.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker delivers queued mail to a relaunch reporting the same cwd differently",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, orchestrator, cleanup } = await setupClients();
    const replacement = new IntercomClient();

    try {
      const originalPlannerId = planner.sessionId!;
      const receivedAsk = once(orchestrator, "message") as Promise<
        [SessionInfo, Message]
      >;
      assert.equal(
        (
          await planner.send(orchestrator.sessionId!, {
            messageId: "cwd-variant-ask",
            text: "Answer later?",
            expectsReply: true,
          })
        ).delivered,
        true,
      );
      await receivedAsk;
      await planner.disconnect();

      assert.equal(
        (
          await orchestrator.send(originalPlannerId, {
            messageId: "cwd-variant-answer",
            text: "Answer for the same project.",
            replyTo: "cwd-variant-ask",
          })
        ).delivered,
        true,
      );

      const queuedReply = once(replacement, "message") as Promise<
        [SessionInfo, Message]
      >;
      await replacement.connect(
        registration(
          "planner",
          // Same directory as registration() spelled with a ".." segment and a
          // trailing separator, built by concatenation so path.join cannot
          // collapse it before the broker sees it.
          `${repoDir}${path.sep}ui${path.sep}..${path.sep}`,
        ),
      );

      const [, message] = await queuedReply;
      assert.equal(message.id, "cwd-variant-answer");
      assert.equal(message.content.text, "Answer for the same project.");
    } finally {
      await replacement.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "broker coalesces no-op presence floods",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const worker = new IntercomClient();
    const updates: SessionInfo[] = [];
    planner.on("presence_update", (session: SessionInfo) => {
      if (session.name === "presence-worker") {
        updates.push(session);
      }
    });

    try {
      await worker.connect(registration("presence-worker"));
      worker.updatePresence({ status: "idle" });
      for (let i = 0; i < 20; i += 1) {
        worker.updatePresence({ status: "idle" });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(updates.length, 1);
    } finally {
      await worker.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "old stable-ID socket cannot mutate the replacement session",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const first = await connectRawRegistered(
      "replaceable-session-id",
      "replaceable-worker-old",
    );
    const replacement = new IntercomClient();

    try {
      await replacement.connect(
        registration("replaceable-worker-new"),
        "replaceable-session-id",
      );

      first.writeMessage(first.socket, {
        type: "presence",
        name: "stale-name",
      });
      first.writeMessage(first.socket, { type: "unregister" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const replacementSession = await waitForSessionId(
        planner,
        "replaceable-session-id",
      );
      assert.equal(replacementSession.name, "replaceable-worker-new");

      const received = once(replacement, "message") as Promise<
        [SessionInfo, Message]
      >;
      const sent = await planner.send("replaceable-session-id", {
        text: "still there",
      });
      assert.equal(sent.delivered, true);
      const [, message] = await received;
      assert.equal(message.content.text, "still there");
    } finally {
      first.socket.destroy();
      await replacement.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

test(
  "stable-ID replacement clears old ask edges and ignores stale cancels",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { orchestrator, cleanup } = await setupClients();
    const first = await connectRawRegistered(
      "replaceable-asker-id",
      "replaceable-asker-old",
    );
    const replacement = new IntercomClient();

    try {
      first.writeMessage(first.socket, {
        type: "send",
        to: orchestrator.sessionId,
        message: {
          id: "old-ask-edge",
          timestamp: Date.now(),
          expectsReply: true,
          content: { text: "Old ask" },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await replacement.connect(
        registration("replaceable-asker-new"),
        "replaceable-asker-id",
      );

      const reverseAfterReplace = await orchestrator.send(
        "replaceable-asker-id",
        {
          messageId: "reverse-after-replace",
          text: "Can I ask the replacement?",
          expectsReply: true,
        },
      );
      assert.equal(reverseAfterReplace.delivered, true);
      assert.equal(
        (
          await replacement.send(orchestrator.sessionId!, {
            text: "Replacement answered.",
            replyTo: "reverse-after-replace",
          })
        ).delivered,
        true,
      );

      const replacementAsk = await replacement.send(orchestrator.sessionId!, {
        messageId: "replacement-ask-edge",
        text: "Replacement ask",
        expectsReply: true,
      });
      assert.equal(replacementAsk.delivered, true);
      first.writeMessage(first.socket, {
        type: "cancel_ask",
        messageId: "replacement-ask-edge",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const reverseWhileReplacementWaits = await orchestrator.send(
        "replaceable-asker-id",
        {
          messageId: "reverse-while-replacement-waits",
          text: "Can I ask while replacement waits?",
          expectsReply: true,
        },
      );
      assert.equal(reverseWhileReplacementWaits.delivered, false);
      assert.match(
        reverseWhileReplacementWaits.reason ?? "",
        /Mutual ask refused/,
      );
    } finally {
      first.socket.destroy();
      await replacement.disconnect().catch(() => undefined);
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Part B: the dsh plugin (tool + BrokerTransport) against the real broker.
// ---------------------------------------------------------------------------

const pluginConfig: IntercomConfig = {
  enabled: true,
  inboundTrigger: "always",
  replyHint: true,
  confirmSend: false,
};

/** Fake Agent recording followup/steer/inject deliveries, with a parking inbox. */
function recordingAgent(id: string, status: "idle" | "running") {
  const calls: Array<{
    method: "followup" | "steer" | "inject";
    message: UserMessage;
  }> = [];
  const parked: UserMessage[] = [];
  const agent = {
    id: id as SessionId,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { cwd: repoDir } },
    status,
    inbox: {
      get nextTurn() {
        return parked;
      },
      get nextStep() {
        return [] as readonly UserMessage[];
      },
    },
    followup(message: UserMessage) {
      calls.push({ method: "followup", message });
      parked.push(message);
    },
    steer(message: UserMessage) {
      calls.push({ method: "steer", message });
      parked.push(message);
    },
    inject(message: UserMessage) {
      calls.push({ method: "inject", message });
    },
  } as unknown as Agent;
  return { agent, calls };
}

function execFor(
  agent: Agent | undefined,
  signal: AbortSignal = new AbortController().signal,
): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext;
}

async function setupPlugin(
  options: {
    askTimeoutMs?: number;
    alias?: string;
    config?: IntercomConfig;
  } = {},
) {
  const config = options.config ?? pluginConfig;
  const registry = new SessionRegistry();
  const { agent, calls } = recordingAgent("integ-self", "idle");
  registry.add(agent);
  if (options.alias) {
    registry.alias(agent, options.alias);
  }
  const transport = new BrokerTransport({
    config,
    aliasOf: (id) => registry.aliasOf(id),
    spawnBroker: () => Promise.resolve(),
    ...(options.askTimeoutMs !== undefined
      ? { askTimeoutMs: options.askTimeoutMs }
      : {}),
  });
  const local = new LocalTransport((id) => registry.aliasOf(id));
  transport.attach(agent);
  await transport.sessionFor("integ-self")!.ensureConnected();
  const tool = createIntercomTool({
    registry,
    local,
    broker: transport,
    config,
  });
  return { registry, transport, tool, agent, calls };
}

test(
  "plugin ask blocks until the peer replies through the real broker",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, tool, agent } = await setupPlugin();
    try {
      await waitForSessionId(planner, "integ-self");
      const askReceived = once(planner, "message") as Promise<
        [SessionInfo, Message]
      >;
      const askPromise = tool.execute(
        { action: "ask", to: "planner", message: "what is the status?" },
        execFor(agent),
      );
      askPromise.catch(() => undefined);
      const [, askMessage] = await askReceived;
      assert.equal(askMessage.expectsReply, true);
      assert.equal(askMessage.content.text, "what is the status?");

      const reply = await planner.send("integ-self", {
        text: "status: green",
        replyTo: askMessage.id,
      });
      assert.equal(reply.delivered, true);
      const result = (await askPromise) as string;
      assert.equal(result, "**Reply from planner:**\nstatus: green");
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "plugin receives an inbound ask via followup and answers it with reply",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, tool, agent, calls } = await setupPlugin({
      alias: "worker",
    });
    try {
      await waitForSessionId(planner, "integ-self");
      const sent = await planner.send("integ-self", {
        messageId: "inbound-ask-1",
        text: "can you handle this?",
        expectsReply: true,
      });
      assert.equal(sent.delivered, true);

      const deadline = Date.now() + 3000;
      while (calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.method, "followup");
      const text = calls[0]!.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      assert.match(text, /\*\*From planner\*\*/);
      assert.match(text, /action: "reply", message: "\.\.\."/);
      assert.match(text, /can you handle this\?/);

      const replyReceived = once(planner, "message") as Promise<
        [SessionInfo, Message]
      >;
      const replyResult = (await tool.execute(
        { action: "reply", message: "on it" },
        execFor(agent),
      )) as string;
      assert.equal(replyResult, "Reply sent to planner");
      const [, replyMessage] = await replyReceived;
      assert.equal(replyMessage.replyTo, "inbound-ask-1");
      assert.equal(replyMessage.content.text, "on it");

      const pending = (await tool.execute(
        { action: "pending" },
        execFor(agent),
      )) as string;
      assert.match(pending, /No unresolved inbound asks/);
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "plugin ask abort via exec.signal clears the broker mutual-ask edge",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, tool, agent } = await setupPlugin();
    try {
      await waitForSessionId(planner, "integ-self");
      const askReceived = once(planner, "message") as Promise<
        [SessionInfo, Message]
      >;
      const controller = new AbortController();
      const askPromise = tool.execute(
        { action: "ask", to: "planner", message: "should I continue?" },
        execFor(agent, controller.signal),
      );
      await askReceived;
      controller.abort();
      await assert.rejects(askPromise, /Cancelled/);

      // The broker-side ask edge is gone: the peer may now ask us.
      const reverseAsk = await planner.send("integ-self", {
        messageId: "reverse-after-abort",
        text: "Can I ask after your cancellation?",
        expectsReply: true,
      });
      assert.equal(reverseAsk.delivered, true);
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "plugin ask timeout reports the message id and delivery state",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, tool, agent } = await setupPlugin({
      askTimeoutMs: 150,
    });
    try {
      await waitForSessionId(planner, "integ-self");
      // The planner receives but never replies.
      planner.on("message", () => undefined);
      const askPromise = tool.execute(
        { action: "ask", to: "planner", message: "will this time out?" },
        execFor(agent),
      );
      await assert.rejects(
        askPromise,
        /No reply from .* within 150ms\. Last known delivery state: socket_delivered/,
      );
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "plugin receives a mailbox flush delivered at registration time",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    // First incarnation of the worker: named, then disconnects.
    const first = new BrokerTransport({
      config: pluginConfig,
      aliasOf: () => "worker",
      spawnBroker: () => Promise.resolve(),
    });
    const firstRegistry = new SessionRegistry();
    const firstAgent = recordingAgent("integ-worker", "idle").agent;
    firstRegistry.add(firstAgent);
    firstRegistry.alias(firstAgent, "worker");
    first.attach(firstAgent);
    await first.sessionFor("integ-worker")!.ensureConnected();
    await waitForSessionId(planner, "integ-worker");
    await first.dispose();

    try {
      // Queue mail for the disconnected worker, then reconnect the plugin side
      // with the same id + alias + cwd: the flush must reach followup().
      const queued = await planner.send("worker", {
        messageId: "flush-at-register",
        text: "delivered on registration",
      });
      assert.equal(queued.delivered, true);

      const second = new BrokerTransport({
        config: pluginConfig,
        aliasOf: () => "worker",
        spawnBroker: () => Promise.resolve(),
      });
      const { agent: secondAgent, calls } = recordingAgent(
        "integ-worker",
        "idle",
      );
      second.attach(secondAgent);
      await second.sessionFor("integ-worker")!.ensureConnected();

      const deadline = Date.now() + 3000;
      while (calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.method, "followup");
      const text = calls[0]!.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      assert.match(text, /delivered on registration/);
      await second.dispose();
    } finally {
      await first.dispose();
      await cleanup();
    }
  },
);

test(
  "plugin send queues mail for a disconnected named target and cancel withdraws it",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, tool, agent } = await setupPlugin();
    const replacement = new IntercomClient();
    try {
      await waitForSessionId(planner, "integ-self");

      // The planner leaves; a named send queues in the broker mailbox.
      await planner.disconnect();
      const sendOut = (await tool.execute(
        { action: "send", to: "planner", message: "queued while away" },
        execFor(agent),
      )) as string;
      assert.equal(sendOut, "Message sent to planner");

      // A same name+cwd relaunch receives the queued message.
      const queued = once(replacement, "message") as Promise<
        [SessionInfo, Message]
      >;
      await replacement.connect(registration("planner"));
      const replacementId = replacement.sessionId!;
      const [, queuedMessage] = await queued;
      assert.equal(queuedMessage.content.text, "queued while away");
      await replacement.disconnect();

      // Cancel of an unknown message id fails loudly.
      await assert.rejects(
        tool.execute(
          { action: "cancel", messageId: "withheld-id" },
          execFor(agent),
        ),
        /Cancellation for withheld-id was not delivered/,
      );

      // Cancel a queued message by explicit id: the relaunch never sees it. Two
      // disconnected sessions are named "planner" by now, so address by id.
      await tool.execute(
        {
          action: "send",
          to: replacementId,
          message: "withdrawn by id",
          messageId: "withheld-id",
        },
        execFor(agent),
      );
      const cancelled = (await tool.execute(
        { action: "cancel", messageId: "withheld-id" },
        execFor(agent),
      )) as string;
      assert.equal(cancelled, "Cancellation requested for withheld-id");

      const redelivered: Message[] = [];
      replacement.on("message", (_from: SessionInfo, message: Message) =>
        redelivered.push(message),
      );
      await replacement.connect(registration("planner"), replacementId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(redelivered, []);
    } finally {
      await replacement.disconnect().catch(() => undefined);
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "inboundTrigger never parks inbound sends via inject without waking a turn",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, calls } = await setupPlugin({
      config: { ...pluginConfig, inboundTrigger: "never" },
    });
    try {
      await waitForSessionId(planner, "integ-self");
      const sent = await planner.send("integ-self", {
        messageId: "never-park-1",
        text: "parked, no wake",
      });
      assert.equal(sent.delivered, true);

      const deadline = Date.now() + 3000;
      while (calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The message lands as context (inject) only — no followup/steer wake.
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.method, "inject");

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(calls.length, 1, "no wake delivery may follow the inject");
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);

test(
  "inboundTrigger replies parks plain sends but wakes on replies",
  { concurrency: false, timeout: 30_000 },
  async () => {
    const { planner, cleanup } = await setupClients();
    const { transport, calls } = await setupPlugin({
      config: { ...pluginConfig, inboundTrigger: "replies" },
    });
    try {
      await waitForSessionId(planner, "integ-self");

      // A plain (non-reply) send is parked via inject, no new turn.
      const plain = await planner.send("integ-self", {
        messageId: "replies-park-1",
        text: "fyi only",
      });
      assert.equal(plain.delivered, true);
      const parkDeadline = Date.now() + 3000;
      while (calls.length === 0 && Date.now() < parkDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.method, "inject");

      // Set up a real ask edge (plugin → planner) at the client level, with no
      // reply waiter, so the planner's reply is a valid inbound reply.
      const selfClient = transport.sessionFor("integ-self")!.client!;
      const askOut = await selfClient.send(planner.sessionId!, {
        messageId: "replies-edge-ask",
        text: "question for the planner",
        expectsReply: true,
      });
      assert.equal(askOut.delivered, true);
      const plannerGotAsk = once(planner, "message") as Promise<
        [SessionInfo, Message]
      >;
      const [, askMessage] = await plannerGotAsk;
      assert.equal(askMessage.id, "replies-edge-ask");

      const reply = await planner.send("integ-self", {
        text: "the answer",
        replyTo: "replies-edge-ask",
      });
      assert.equal(reply.delivered, true);
      const wakeDeadline = Date.now() + 3000;
      while (calls.length < 2 && Date.now() < wakeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(calls.length, 2);
      assert.equal(
        calls[1]!.method,
        "followup",
        "a reply must wake the idle session under inboundTrigger: replies",
      );
    } finally {
      await transport.dispose();
      await cleanup();
    }
  },
);
