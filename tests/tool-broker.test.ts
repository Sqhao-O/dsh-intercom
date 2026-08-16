/**
 * Unit tests for the broker-backed tool actions (ask / reply / pending /
 * cancel / list-cwd / send upgrades) and the BrokerSession inbound pipeline
 * (delivery path, inboundTrigger policy, receipts, dedup). A fake
 * BrokerClientLike replaces the socket; cross-process behavior against a real
 * broker lives in tests/intercom.integration.test.ts.
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
import type {
  Message,
  MessageControl,
  MessageReceipt,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

const defaultConfig: IntercomConfig = {
  enabled: true,
  inboundTrigger: "always",
  replyHint: true,
  confirmSend: false,
};

function sessionInfo(
  id: string,
  name: string | undefined,
  cwd: string,
  status = "idle",
): SessionInfo {
  return {
    id,
    ...(name ? { name } : {}),
    cwd,
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    status,
  };
}

function incomingMessage(
  id: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { id, timestamp: Date.now(), content: { text }, ...extra };
}

/** Fake broker client: scripted roster, recorded sends, manual inbound events. */
class FakeClient extends EventEmitter implements BrokerClientLike {
  sessionId: string | null = null;
  registration: SessionRegistration | undefined;
  connected = false;
  roster: SessionInfo[] = [];
  sent: Array<{ to: string; options: BrokerSendOptions }> = [];
  cancelled: string[] = [];
  asksCancelled: string[] = [];
  receipts: MessageReceipt[] = [];
  presenceUpdates: Array<Record<string, unknown>> = [];
  sendResults: Array<{ delivered: boolean; reason?: string }> = [];
  private receiptHandler:
    ((from: SessionInfo, receipt: MessageReceipt) => void) | undefined;
  private controlHandler:
    ((from: SessionInfo, control: MessageControl) => void) | undefined;

  isConnected(): boolean {
    return this.connected;
  }
  connect(session: SessionRegistration, sessionId?: string): Promise<void> {
    this.registration = session;
    this.sessionId = sessionId ?? "generated-id";
    this.connected = true;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  listSessions(): Promise<SessionInfo[]> {
    return Promise.resolve(this.roster);
  }
  send(to: string, options: BrokerSendOptions): Promise<BrokerSendResult> {
    this.sent.push({ to, options });
    const scripted = this.sendResults.shift();
    return Promise.resolve({
      id: options.messageId ?? `fake-msg-${this.sent.length}`,
      delivered: scripted?.delivered ?? true,
      ...(scripted?.reason ? { reason: scripted.reason } : {}),
    });
  }
  cancelMessage(messageId: string): Promise<BrokerSendResult> {
    this.cancelled.push(messageId);
    const scripted = this.sendResults.shift();
    return Promise.resolve({
      id: messageId,
      delivered: scripted?.delivered ?? true,
      ...(scripted?.reason ? { reason: scripted.reason } : {}),
    });
  }
  cancelAsk(messageId: string): void {
    this.asksCancelled.push(messageId);
  }
  sendMessageReceipt(receipt: MessageReceipt): void {
    this.receipts.push(receipt);
  }
  updatePresence(updates: Record<string, unknown>): void {
    this.presenceUpdates.push(updates);
  }
  onMessageReceipt(
    handler: (from: SessionInfo, receipt: MessageReceipt) => void,
  ): void {
    this.receiptHandler = handler;
  }
  onMessageControl(
    handler: (from: SessionInfo, control: MessageControl) => void,
  ): void {
    this.controlHandler = handler;
  }

  // Test helpers.
  emitIncoming(from: SessionInfo, message: Message): void {
    this.emit("message", from, message);
  }
  emitReceipt(from: SessionInfo, receipt: MessageReceipt): void {
    this.receiptHandler?.(from, receipt);
  }
  emitControl(from: SessionInfo, control: MessageControl): void {
    this.controlHandler?.(from, control);
  }
}

/** Fake Agent recording followup/steer/inject deliveries, with a parking inbox. */
function recordingAgent(
  id: string,
  status: "idle" | "running",
  cwd = "D:/self",
  options: { dropDeliveries?: boolean } = {},
) {
  const calls: Array<{
    method: "followup" | "steer" | "inject";
    message: UserMessage;
  }> = [];
  // Messages the fake driver has not claimed yet; the watchdog treats parked
  // messages as healthy and lost (absent) ones as redeliverable.
  const parked: UserMessage[] = [];
  const park = (message: UserMessage) => {
    if (!options.dropDeliveries) parked.push(message);
  };
  const agent = {
    id: id as SessionId,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { cwd } },
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
      park(message);
    },
    steer(message: UserMessage) {
      calls.push({ method: "steer", message });
      park(message);
    },
    inject(message: UserMessage) {
      calls.push({ method: "inject", message });
    },
  } as unknown as Agent;
  return { agent, calls, parked };
}

function execFor(
  agent: Agent | undefined,
  signal: AbortSignal = new AbortController().signal,
): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext;
}

interface Setup {
  registry: SessionRegistry;
  broker: BrokerTransport;
  tool: ToolDefinition;
  client: FakeClient;
  self: Agent;
  calls: Array<{ method: string; message: UserMessage }>;
  workerInfo: SessionInfo;
}

async function setup(
  options: {
    config?: IntercomConfig;
    askTimeoutMs?: number;
    selfStatus?: "idle" | "running";
    roster?: SessionInfo[];
    dropDeliveries?: boolean;
    deliveryWatchdogMs?: number;
    maxRedeliveries?: number;
  } = {},
): Promise<Setup> {
  const registry = new SessionRegistry();
  const { agent: self, calls } = recordingAgent(
    "self-full-id",
    options.selfStatus ?? "idle",
    "D:/self",
    { dropDeliveries: options.dropDeliveries ?? false },
  );
  registry.add(self);
  registry.alias(self, "planner");
  const workerInfo = sessionInfo("worker-full-id", "worker", "D:/worker");
  const client = new FakeClient();
  client.roster = options.roster ?? [
    sessionInfo("self-full-id", "planner", "D:/self"),
    workerInfo,
  ];
  const config = options.config ?? defaultConfig;
  const broker = new BrokerTransport({
    config,
    aliasOf: (id) => registry.aliasOf(id),
    spawnBroker: () => Promise.resolve(),
    createClient: () => client,
    ...(options.askTimeoutMs !== undefined
      ? { askTimeoutMs: options.askTimeoutMs }
      : {}),
    ...(options.deliveryWatchdogMs !== undefined
      ? { deliveryWatchdogMs: options.deliveryWatchdogMs }
      : {}),
    ...(options.maxRedeliveries !== undefined
      ? { maxRedeliveries: options.maxRedeliveries }
      : {}),
  });
  const local = new LocalTransport((id) => registry.aliasOf(id));
  broker.attach(self);
  await broker.sessionFor("self-full-id")!.ensureConnected();
  const tool = createIntercomTool({ registry, local, broker, config });
  return { registry, broker, tool, client, self, calls, workerInfo };
}

test("list renders the broker roster across processes", async () => {
  const { tool, self } = await setup();
  const out = (await tool.execute({ action: "list" }, execFor(self))) as string;
  assert.match(out, /\*\*Current session:\*\*/);
  assert.match(out, /planner \(self-full\)/);
  assert.match(out, /\[self, idle\]/);
  assert.match(out, /worker \(worker-full\)/);
});

test("list-cwd shows only peers in the same working directory", async () => {
  const { tool, self } = await setup({
    roster: [
      sessionInfo("self-full-id", "planner", "D:/self"),
      sessionInfo("peer-in-cwd", "neighbor", "D:/self"),
      sessionInfo("peer-elsewhere", "far", "D:/other"),
    ],
  });
  const out = (await tool.execute(
    { action: "list-cwd" },
    execFor(self),
  )) as string;
  assert.match(out, /neighbor/);
  assert.doesNotMatch(out, /far \(/);
  const otherDir = (await tool.execute(
    { action: "list-cwd", cwd: "D:/elsewhere" },
    execFor(self),
  )) as string;
  assert.match(otherDir, /No other sessions in this directory/);
});

test("name publishes the alias as the broker presence name", async () => {
  const { tool, self, client } = await setup();
  await tool.execute({ action: "name", alias: "boss" }, execFor(self));
  assert.deepEqual(client.presenceUpdates.at(-1), { name: "boss" });
});

test("send resolves an alias through the broker roster", async () => {
  const { tool, self, client } = await setup();
  const out = (await tool.execute(
    { action: "send", to: "worker", message: "hello" },
    execFor(self),
  )) as string;
  assert.equal(out, "Message sent to worker");
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]!.to, "worker-full-id");
  assert.equal(client.sent[0]!.options.text, "hello");
});

test("send passes supersedes/retryOf/messageId through to the broker", async () => {
  const { tool, self, client } = await setup();
  await tool.execute(
    {
      action: "send",
      to: "worker",
      message: "correction",
      messageId: "fixed-id",
      supersedes: "old-id",
      retryOf: "retry-id",
    },
    execFor(self),
  );
  assert.deepEqual(client.sent[0]!.options, {
    text: "correction",
    messageId: "fixed-id",
    supersedes: "old-id",
    retryOf: "retry-id",
  });
});

test("send to self through the roster is rejected", async () => {
  const { tool, self } = await setup();
  await assert.rejects(
    tool.execute(
      { action: "send", to: "planner", message: "hi" },
      execFor(self),
    ),
    /current session/,
  );
});

test("send reports broker delivery failure with the reason", async () => {
  const { tool, self, client } = await setup();
  client.sendResults.push({ delivered: false, reason: "Session not found" });
  await assert.rejects(
    tool.execute(
      { action: "send", to: "worker", message: "hi" },
      execFor(self),
    ),
    /Message to "worker" was not delivered: Session not found/,
  );
});

test("send infers a reply from the sole pending ask and dismisses it", async () => {
  const { tool, self, client, workerInfo, broker } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "Can you check?", { expectsReply: true }),
  );
  const out = (await tool.execute(
    { action: "send", to: "worker", message: "checked" },
    execFor(self),
  )) as string;
  assert.equal(out, "Reply sent to worker (inferred from pending ask)");
  assert.equal(client.sent.at(-1)!.options.replyTo, "ask-1");
  const pending = (await tool.execute(
    { action: "pending" },
    execFor(self),
  )) as string;
  assert.match(pending, /No unresolved inbound asks/);
  assert.ok(broker.sessionFor("self-full-id"));
});

test("an explicit replyTo wins over pending-ask inference", async () => {
  const { tool, self, client, workerInfo } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "Can you check?", { expectsReply: true }),
  );
  const out = (await tool.execute(
    { action: "send", to: "worker", message: "threaded", replyTo: "other-msg" },
    execFor(self),
  )) as string;
  assert.equal(out, "Message sent to worker");
  assert.equal(client.sent.at(-1)!.options.replyTo, "other-msg");
  // The pending ask survives an explicitly threaded send.
  const pending = (await tool.execute(
    { action: "pending" },
    execFor(self),
  )) as string;
  assert.match(pending, /ask-1/);
});

test("ask blocks until the reply arrives and returns its text", async () => {
  const { tool, self, client, workerInfo } = await setup();
  const askPromise = tool.execute(
    { action: "ask", to: "worker", message: "status?" },
    execFor(self),
  );
  while (client.sent.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const questionId = client.sent[0]!.options.messageId!;
  assert.equal(client.sent[0]!.options.expectsReply, true);
  client.emitIncoming(
    workerInfo,
    incomingMessage("reply-1", "all green", { replyTo: questionId }),
  );
  const out = (await askPromise) as string;
  assert.equal(out, "**Reply from worker:**\nall green");
});

test("ask times out with the message id and last known delivery state", async () => {
  const { tool, self, client, workerInfo } = await setup({ askTimeoutMs: 60 });
  const askPromise = tool.execute(
    { action: "ask", to: "worker", message: "status?" },
    execFor(self),
  );
  while (client.sent.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const questionId = client.sent[0]!.options.messageId!;
  client.emitReceipt(workerInfo, {
    messageId: questionId,
    status: "injected",
    timestamp: Date.now(),
  });
  await assert.rejects(askPromise, (error: Error) => {
    assert.match(
      error.message,
      new RegExp(
        `No reply from "worker-full-id" for message ${questionId} within 60ms`,
      ),
    );
    assert.match(error.message, /Last known delivery state: injected/);
    return true;
  });
});

test("ask aborts via exec.signal and sends the broker-side cancel_ask", async () => {
  const { tool, self, client } = await setup();
  const controller = new AbortController();
  const askPromise = tool.execute(
    { action: "ask", to: "worker", message: "status?" },
    execFor(self, controller.signal),
  );
  while (client.sent.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const questionId = client.sent[0]!.options.messageId!;
  controller.abort();
  await assert.rejects(askPromise, /Cancelled/);
  assert.deepEqual(client.asksCancelled, [questionId]);
});

test("ask fails immediately for a disconnected target", async () => {
  const { tool, self } = await setup({
    roster: [sessionInfo("self-full-id", "planner", "D:/self")],
  });
  await assert.rejects(
    tool.execute({ action: "ask", to: "ghost", message: "hi" }, execFor(self)),
    /not currently connected\. Blocking asks are not queued/,
  );
});

test("only one pending ask per session at a time", async () => {
  const { tool, self, client } = await setup();
  const first = tool.execute(
    { action: "ask", to: "worker", message: "one" },
    execFor(self),
  );
  first.catch(() => undefined);
  while (client.sent.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(
    tool.execute(
      { action: "ask", to: "worker", message: "two" },
      execFor(self),
    ),
    /Already waiting for a reply/,
  );
  client.emit("disconnected", new Error("test teardown"));
  await assert.rejects(first, /Disconnected while waiting/);
});

test("reply answers the single pending ask and dismisses it", async () => {
  const { tool, self, client, workerInfo } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "Need a decision", { expectsReply: true }),
  );
  const out = (await tool.execute(
    { action: "reply", message: "go ahead" },
    execFor(self),
  )) as string;
  assert.equal(out, "Reply sent to worker");
  assert.equal(client.sent.at(-1)!.to, "worker-full-id");
  assert.equal(client.sent.at(-1)!.options.replyTo, "ask-1");
  const pending = (await tool.execute(
    { action: "pending" },
    execFor(self),
  )) as string;
  assert.match(pending, /No unresolved inbound asks/);
});

test("reply with multiple pending asks asks for disambiguation", async () => {
  const { tool, self, client, workerInfo } = await setup();
  const reviewerInfo = sessionInfo("reviewer-full-id", "reviewer", "D:/rev");
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "First", { expectsReply: true }),
  );
  client.emitIncoming(
    reviewerInfo,
    incomingMessage("ask-2", "Second", { expectsReply: true }),
  );
  await assert.rejects(
    tool.execute({ action: "reply", message: "hi" }, execFor(self)),
    /Multiple pending asks/,
  );
  const out = (await tool.execute(
    { action: "reply", to: "reviewer", message: "hi" },
    execFor(self),
  )) as string;
  assert.equal(out, "Reply sent to reviewer");
  assert.equal(client.sent.at(-1)!.options.replyTo, "ask-2");
});

test("reply without any pending ask fails with guidance", async () => {
  const { tool, self } = await setup();
  await assert.rejects(
    tool.execute({ action: "reply", message: "hi" }, execFor(self)),
    /No active intercom context to reply to/,
  );
});

test("pending lists unresolved inbound asks with sender, id, and preview", async () => {
  const { tool, self, client, workerInfo } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-9", "Can you review the plan?", {
      expectsReply: true,
    }),
  );
  const out = (await tool.execute(
    { action: "pending" },
    execFor(self),
  )) as string;
  assert.match(out, /\*\*Pending asks:\*\*/);
  assert.match(out, /worker · ask-9 · \d+s ago · Can you review the plan\?/);
});

test("cancel requests broker-side cancellation of a sent message", async () => {
  const { tool, self, client } = await setup();
  const out = (await tool.execute(
    { action: "cancel", messageId: "m-1" },
    execFor(self),
  )) as string;
  assert.equal(out, "Cancellation requested for m-1");
  assert.deepEqual(client.cancelled, ["m-1"]);
  client.sendResults.push({
    delivered: false,
    reason: "Message cannot be cancelled by this session",
  });
  await assert.rejects(
    tool.execute({ action: "cancel", messageId: "m-2" }, execFor(self)),
    /Cancellation for m-2 was not delivered/,
  );
});

test("an inbound cancel control dismisses the pending ask", async () => {
  const { tool, self, client, workerInfo } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "Need a decision", { expectsReply: true }),
  );
  client.emitControl(workerInfo, {
    messageId: "ask-1",
    action: "cancel",
    timestamp: Date.now(),
  });
  const pending = (await tool.execute(
    { action: "pending" },
    execFor(self),
  )) as string;
  assert.match(pending, /No unresolved inbound asks/);
  assert.ok(
    client.receipts.some(
      (receipt) =>
        receipt.messageId === "ask-1" &&
        receipt.status === "cancellation_requested",
    ),
  );
});

test("an idle agent receives inbound messages via followup with the reply hint", async () => {
  const { calls, client, workerInfo } = await setup();
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "hello", { expectsReply: true }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "followup");
  const text = calls[0]!.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.match(text, /\*\*From worker\*\* \(D:\/worker\)/);
  assert.match(text, /action: "reply", message: "\.\.\."/);
  assert.deepEqual(calls[0]!.message.source, {
    kind: "intercom",
    form: "relay",
    senderSessionId: "worker-full-id",
    messageId: "ask-1",
  });
  assert.ok(
    client.receipts.some(
      (receipt) =>
        receipt.messageId === "ask-1" && receipt.status === "injected",
    ),
  );
});

test("a running agent receives inbound messages via steer", async () => {
  const { calls, client, workerInfo } = await setup({ selfStatus: "running" });
  client.emitIncoming(workerInfo, incomingMessage("m-1", "ping"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "steer");
});

test("inboundTrigger never demotes delivery to a non-waking inject", async () => {
  const { calls, client, workerInfo } = await setup({
    config: { ...defaultConfig, inboundTrigger: "never" },
  });
  client.emitIncoming(workerInfo, incomingMessage("m-1", "ping"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "inject");
});

test("inboundTrigger replies only triggers turns for replies", async () => {
  const { calls, client, workerInfo } = await setup({
    config: { ...defaultConfig, inboundTrigger: "replies" },
  });
  client.emitIncoming(workerInfo, incomingMessage("m-1", "fyi"));
  client.emitIncoming(
    workerInfo,
    incomingMessage("m-2", "answer", { replyTo: "q-1" }),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["inject", "followup"],
  );
});

test("the same message id is injected at most once per receiving session", async () => {
  const { calls, client, workerInfo } = await setup();
  const message = incomingMessage("dup-1", "once only");
  client.emitIncoming(workerInfo, message);
  client.emitIncoming(workerInfo, message);
  assert.equal(calls.length, 1);
  assert.ok(
    client.receipts.some(
      (receipt) =>
        receipt.messageId === "dup-1" &&
        receipt.status === "acknowledged" &&
        receipt.detail === "duplicate message id suppressed",
    ),
  );
});

test("status reports broker mode, session id, and roster size", async () => {
  const { tool, self } = await setup();
  const out = (await tool.execute(
    { action: "status" },
    execFor(self),
  )) as string;
  assert.match(
    out,
    /Transport: broker \(cross-process\), 1\/1 agent\(s\) connected/,
  );
  assert.match(out, /Session ID: self-full-id/);
  assert.match(out, /Active sessions: 2/);
});

test("broker-only actions fail clearly when the broker is unavailable", async () => {
  const registry = new SessionRegistry();
  const { agent: self } = recordingAgent("self-full-id", "idle");
  registry.add(self);
  const broker = new BrokerTransport({
    config: defaultConfig,
    aliasOf: () => undefined,
    spawnBroker: () => Promise.reject(new Error("spawn exploded")),
    createClient: () => new FakeClient(),
    reconnectDelaysMs: [60_000],
  });
  const local = new LocalTransport((id) => registry.aliasOf(id));
  broker.attach(self);
  // Let the failed background connect settle.
  await broker
    .sessionFor("self-full-id")!
    .ensureConnected()
    .catch(() => undefined);
  const tool = createIntercomTool({
    registry,
    local,
    broker,
    config: defaultConfig,
  });
  await assert.rejects(
    tool.execute({ action: "ask", to: "x", message: "hi" }, execFor(self)),
    /needs the cross-process broker, but it is unavailable: spawn exploded/,
  );
  await broker.dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a wake that never reaches the session log is redelivered, bounded", async () => {
  const { calls, client, workerInfo, broker } = await setup({
    dropDeliveries: true,
    deliveryWatchdogMs: 30,
    maxRedeliveries: 2,
  });
  client.emitIncoming(workerInfo, incomingMessage("lost-1", "wake up"));
  assert.equal(calls.length, 1);

  await sleep(200);
  // Initial delivery + 2 redeliveries, then the watchdog gives up.
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.method, "followup");
    assert.equal(
      (call.message.source as { messageId?: string }).messageId,
      "lost-1",
    );
  }
  await sleep(120);
  assert.equal(calls.length, 3);
  await broker.dispose();
});

test("a message parked in the inbox is not redelivered", async () => {
  const { calls, client, workerInfo, broker } = await setup({
    deliveryWatchdogMs: 30,
  });
  client.emitIncoming(workerInfo, incomingMessage("parked-1", "later"));
  assert.equal(calls.length, 1);

  await sleep(150);
  assert.equal(calls.length, 1);
  await broker.dispose();
});

test("a logged delivery cancels the watchdog and becomes the reply turn context", async () => {
  const { broker, tool, self, client, workerInfo, calls } = await setup({
    deliveryWatchdogMs: 30,
  });
  const reviewerInfo = sessionInfo("reviewer-full-id", "reviewer", "D:/rev");
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "First", { expectsReply: true }),
  );
  client.emitIncoming(
    reviewerInfo,
    incomingMessage("ask-2", "Second", { expectsReply: true }),
  );

  // The driver logged the second relay: watchdog cancelled + turn context set.
  broker.noteSessionEvent(self.session, {
    type: "user/message",
    data: {
      source: {
        kind: "intercom",
        form: "relay",
        senderSessionId: reviewerInfo.id,
        messageId: "ask-2",
      },
    },
  });

  // Two pending asks, yet bare `reply` resolves the logged turn's ask.
  const out = (await tool.execute(
    { action: "reply", message: "answering second" },
    execFor(self),
  )) as string;
  assert.equal(out, "Reply sent to reviewer");
  assert.equal(client.sent.at(-1)!.options.replyTo, "ask-2");

  await sleep(150);
  // ask-1 stays parked (no redelivery); ask-2's watchdog was cancelled.
  assert.equal(calls.length, 2);
  await broker.dispose();
});

test("session events of other sessions or kinds are ignored", async () => {
  const { broker, client, workerInfo, calls } = await setup({
    deliveryWatchdogMs: 30,
  });
  client.emitIncoming(
    workerInfo,
    incomingMessage("ask-1", "First", { expectsReply: true }),
  );
  broker.noteSessionEvent(
    { header: { cwd: "D:/stranger" } },
    {
      type: "user/message",
      data: { source: { kind: "intercom", messageId: "ask-1" } },
    },
  );
  broker.noteSessionEvent(undefined, { type: "turn/start" });
  // Not confirmed for OUR session: still pending (and parked → no redelivery).
  const pending = broker.sessionFor("self-full-id")!.tracker.listPending();
  assert.equal(pending.length, 1);
  assert.equal(calls.length, 1);
  await broker.dispose();
});
