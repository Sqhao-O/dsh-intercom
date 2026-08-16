/**
 * Abort-signal audit tests: every tool `execute` path that awaits a broker
 * round-trip must reject promptly with "Cancelled" when `exec.signal` fires —
 * never hang, never resolve late. `ask`'s waiter abort (with the broker-side
 * cancel_ask) is covered in tests/tool-broker.test.ts; this file covers the
 * remaining actions: send mid-round-trip, cancel mid-round-trip, list
 * mid-round-trip, and an abort while the broker connection (spawn) is still
 * being established.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { IntercomConfig } from "../src/config.ts";
import { SessionRegistry } from "../src/registry.ts";
import { createIntercomTool } from "../src/tool.ts";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { BrokerTransport } from "../src/transport/broker.ts";
import type {
  BrokerClientLike,
  BrokerSendOptions,
  BrokerSendResult,
} from "../src/transport/broker.ts";
import { LocalTransport } from "../src/transport/local.ts";
import type { SessionInfo, SessionRegistration } from "../types.ts";

const defaultConfig: IntercomConfig = {
  enabled: true,
  inboundTrigger: "always",
  replyHint: true,
  confirmSend: false,
};

function sessionInfo(id: string, name: string, cwd: string): SessionInfo {
  return {
    id,
    name,
    cwd,
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    status: "idle",
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake broker client whose connect/send/listSessions can be parked on
 * manually-resolved deferreds to simulate a slow (or never-answering) broker.
 */
class DeferredClient extends EventEmitter implements BrokerClientLike {
  sessionId: string | null = null;
  connected = false;
  roster: SessionInfo[] = [];
  connectGate: Deferred<void> | null = null;
  sendGate: Deferred<BrokerSendResult> | null = null;
  listGate: Deferred<SessionInfo[]> | null = null;
  sent: Array<{ to: string; options: BrokerSendOptions }> = [];
  cancelled: string[] = [];
  asksCancelled: string[] = [];

  isConnected(): boolean {
    return this.connected;
  }
  async connect(
    session: SessionRegistration,
    sessionId?: string,
  ): Promise<void> {
    void session;
    if (this.connectGate) await this.connectGate.promise;
    this.sessionId = sessionId ?? "generated-id";
    this.connected = true;
  }
  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  listSessions(): Promise<SessionInfo[]> {
    return this.listGate ? this.listGate.promise : Promise.resolve(this.roster);
  }
  send(to: string, options: BrokerSendOptions): Promise<BrokerSendResult> {
    this.sent.push({ to, options });
    if (this.sendGate) return this.sendGate.promise;
    return Promise.resolve({ id: options.messageId ?? "m", delivered: true });
  }
  cancelMessage(messageId: string): Promise<BrokerSendResult> {
    this.cancelled.push(messageId);
    if (this.sendGate) return this.sendGate.promise;
    return Promise.resolve({ id: messageId, delivered: true });
  }
  cancelAsk(messageId: string): void {
    this.asksCancelled.push(messageId);
  }
  sendMessageReceipt(): void {}
  updatePresence(): void {}
  onMessageReceipt(): void {}
  onMessageControl(): void {}
}

/** Minimal Agent stand-in (no deliveries are exercised in these tests). */
function fakeAgent(id: string): Agent {
  const parked: UserMessage[] = [];
  return {
    id: id as SessionId,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { cwd: "D:/self" } },
    status: "idle",
    inbox: {
      get nextTurn() {
        return parked;
      },
      get nextStep() {
        return [] as readonly UserMessage[];
      },
    },
    followup(message: UserMessage) {
      parked.push(message);
    },
    steer(message: UserMessage) {
      parked.push(message);
    },
    inject() {},
  } as unknown as Agent;
}

function execFor(agent: Agent, signal: AbortSignal): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext;
}

interface Setup {
  broker: BrokerTransport;
  tool: ToolDefinition;
  client: DeferredClient;
  self: Agent;
}

async function setup(
  options: { spawnGate?: Deferred<void> } = {},
): Promise<Setup> {
  const registry = new SessionRegistry();
  const self = fakeAgent("self-full-id");
  registry.add(self);
  registry.alias(self, "planner");
  const client = new DeferredClient();
  client.roster = [
    sessionInfo("self-full-id", "planner", "D:/self"),
    sessionInfo("worker-full-id", "worker", "D:/worker"),
  ];
  const broker = new BrokerTransport({
    config: defaultConfig,
    aliasOf: (id) => registry.aliasOf(id),
    spawnBroker: options.spawnGate
      ? () => options.spawnGate!.promise
      : () => Promise.resolve(),
    createClient: () => client,
  });
  const local = new LocalTransport((id) => registry.aliasOf(id));
  broker.attach(self);
  if (!options.spawnGate && !client.connectGate) {
    await broker.sessionFor("self-full-id")!.ensureConnected();
  }
  const tool = createIntercomTool({
    registry,
    local,
    broker,
    config: defaultConfig,
  });
  return { broker, tool, client, self };
}

/** Observe how a promise settles; `settled` stays undefined while pending. */
function track(promise: Promise<unknown>): { state: () => string | undefined } {
  let settled: string | undefined;
  promise.then(
    (value) => {
      settled = `resolved: ${String(value)}`;
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  return { state: () => settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("abort during send's broker round-trip rejects with Cancelled and stays rejected", async () => {
  const { broker, tool, client, self } = await setup();
  try {
    client.sendGate = deferred<BrokerSendResult>();
    const controller = new AbortController();
    const result = track(
      tool.execute(
        { action: "send", to: "worker", message: "hello" },
        execFor(self, controller.signal),
      ),
    );
    while (client.sent.length === 0) await tick();
    controller.abort();
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);

    // The broker's late answer must not flip the already-rejected tool result.
    client.sendGate.resolve({ id: "m-1", delivered: true });
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);
  } finally {
    await broker.dispose();
  }
});

test("abort during cancel's broker round-trip rejects with Cancelled", async () => {
  const { broker, tool, client, self } = await setup();
  try {
    client.sendGate = deferred<BrokerSendResult>();
    const controller = new AbortController();
    const result = track(
      tool.execute(
        { action: "cancel", messageId: "m-1" },
        execFor(self, controller.signal),
      ),
    );
    while (client.cancelled.length === 0) await tick();
    controller.abort();
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);
    client.sendGate.resolve({ id: "m-1", delivered: true });
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);
  } finally {
    await broker.dispose();
  }
});

test("abort during list's roster round-trip rejects with Cancelled", async () => {
  const { broker, tool, client, self } = await setup();
  try {
    client.listGate = deferred<SessionInfo[]>();
    const controller = new AbortController();
    const result = track(
      tool.execute({ action: "list" }, execFor(self, controller.signal)),
    );
    await tick();
    controller.abort();
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);
    client.listGate.resolve(client.roster);
    await tick();
    assert.match(result.state() ?? "", /^rejected: Cancelled/);
  } finally {
    await broker.dispose();
  }
});

test("abort while the broker spawn/connect is still in flight rejects instead of hanging", async () => {
  const spawnGate = deferred<void>();
  const registry = new SessionRegistry();
  const self = fakeAgent("self-full-id");
  registry.add(self);
  const client = new DeferredClient();
  const broker = new BrokerTransport({
    config: defaultConfig,
    aliasOf: () => undefined,
    spawnBroker: () => spawnGate.promise,
    createClient: () => client,
    reconnectDelaysMs: [60_000],
  });
  const local = new LocalTransport(() => undefined);
  const tool = createIntercomTool({
    registry,
    local,
    broker,
    config: defaultConfig,
  });
  broker.attach(self); // background connect parks on the spawn gate
  try {
    const controller = new AbortController();
    // `ask` goes through requireBroker → ensureConnected (in flight).
    const askResult = track(
      tool.execute(
        { action: "ask", to: "worker", message: "hi" },
        execFor(self, controller.signal),
      ),
    );
    await tick();
    controller.abort();
    await tick();
    assert.match(askResult.state() ?? "", /^rejected: Cancelled/);

    // `send` goes through connectedClient: the abort must surface as a
    // rejection, not a silent degradation to local fallback.
    const sendController = new AbortController();
    const sendResult = track(
      tool.execute(
        { action: "send", to: "worker", message: "hi" },
        execFor(self, sendController.signal),
      ),
    );
    await tick();
    sendController.abort();
    await tick();
    assert.match(sendResult.state() ?? "", /^rejected: Cancelled/);
  } finally {
    spawnGate.reject(new Error("test teardown"));
    await broker.dispose();
  }
});

test("a pre-aborted signal fails fast before any broker round-trip", async () => {
  const { broker, tool, client, self } = await setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tool.execute(
        { action: "send", to: "worker", message: "hi" },
        execFor(self, controller.signal),
      ),
      /Cancelled/,
    );
    await assert.rejects(
      tool.execute({ action: "list" }, execFor(self, controller.signal)),
      /Cancelled/,
    );
    assert.equal(client.sent.length, 0);
  } finally {
    await broker.dispose();
  }
});
