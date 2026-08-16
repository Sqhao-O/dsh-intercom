/**
 * BrokerTransport: cross-process delivery through the vendored socket broker.
 *
 * The plugin is global (one instance per dsh process) but dsh hosts N agents
 * per process, and the broker protocol registers exactly ONE session per
 * connection — so this transport keeps one `IntercomClient` per registered
 * agent, mirroring pi-intercom's one-session-per-process shape. Inbound broker
 * messages are injected through the same delivery path as LocalTransport
 * (idle → `followup`, running → `steer`), gated by the `inboundTrigger`
 * policy; receipts, duplicate-id suppression, and the reply tracker are wired
 * through from the vendored client/broker rather than reinvented.
 *
 * Graceful degradation: if the broker cannot be spawned or connected, the
 * session simply has no broker client and the tool falls back to
 * LocalTransport for same-process targets; `health()` exposes the state.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AgentStatus } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { getAskTimeoutMs } from "../../broker/ask-timeout.ts";
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";
import type {
  Message,
  MessageControl,
  MessageReceipt,
  MessageReceiptStatus,
  SessionInfo,
  SessionRegistration,
} from "../../types.ts";
import type { IntercomConfig } from "../config.ts";
import { formatIntercomMessage } from "../message.ts";
import { ReplyTracker } from "../reply-tracker.ts";
import { INTERCOM_SOURCE_KIND } from "../source.ts";

const INBOUND_MESSAGE_DEDUPE_MAX = 1000;
const INBOUND_MESSAGE_DEDUPE_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000] as const;

/** Options accepted by the vendored client's `send`. */
export interface BrokerSendOptions {
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
  supersedes?: string;
  retryOf?: string;
}

export interface BrokerSendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

interface PresenceUpdates {
  name?: string;
  status?: string;
  model?: string;
}

/**
 * The slice of the vendored `IntercomClient` the transport and tool use.
 * Structural, so unit tests can substitute a fake without sockets.
 */
export interface BrokerClientLike {
  readonly sessionId: string | null;
  isConnected(): boolean;
  connect(session: SessionRegistration, sessionId?: string): Promise<void>;
  disconnect(): Promise<void>;
  listSessions(options?: { timeoutMs?: number }): Promise<SessionInfo[]>;
  send(to: string, options: BrokerSendOptions): Promise<BrokerSendResult>;
  cancelMessage(messageId: string): Promise<BrokerSendResult>;
  cancelAsk(messageId: string): void;
  sendMessageReceipt(receipt: MessageReceipt): void;
  updatePresence(updates: PresenceUpdates): void;
  on(
    event: "message",
    handler: (from: SessionInfo, message: Message) => void,
  ): unknown;
  on(event: "disconnected", handler: (error: Error) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  onMessageReceipt(
    handler: (from: SessionInfo, receipt: MessageReceipt) => void,
  ): unknown;
  onMessageControl(
    handler: (from: SessionInfo, control: MessageControl) => void,
  ): unknown;
}

export interface BrokerTransportOptions {
  readonly config: IntercomConfig;
  /** Alias lookup backing the broker presence name. */
  readonly aliasOf: (sessionId: string) => string | undefined;
  readonly log?: (message: string) => void;
  /** Test hook: override broker auto-spawn. */
  readonly spawnBroker?: () => Promise<void>;
  /** Test hook: override client construction. */
  readonly createClient?: () => BrokerClientLike;
  /** Test hook: override the ask/reply-tracker timeout. */
  readonly askTimeoutMs?: number;
  /** Test hook: override the reconnect backoff schedule. */
  readonly reconnectDelaysMs?: readonly number[];
  /** Test hook: override the lost-wake watchdog interval (default 2s). */
  readonly deliveryWatchdogMs?: number;
  /** Test hook: cap redelivery attempts per lost message (default 3). */
  readonly maxRedeliveries?: number;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Automatic lifecycle status published to the broker roster. */
function lifecycleStatus(agentStatus: AgentStatus): string {
  return agentStatus === "running" ? "thinking" : "idle";
}

const DEFAULT_DELIVERY_WATCHDOG_MS = 2000;
const DEFAULT_MAX_REDELIVERIES = 3;

interface ReplyWaiter {
  from: string;
  replyTo: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
}

/**
 * One agent's broker runtime: the client connection, its inbound reply
 * tracker, the single pending reply waiter, dedup state, and delivery-state
 * receipts.
 */
export class BrokerSession {
  readonly tracker: ReplyTracker;
  client: BrokerClientLike | null = null;
  /** Last connect/spawn failure, surfaced by the `status` action. */
  lastError: string | undefined;

  private readonly agent: Agent;
  private readonly options: BrokerTransportOptions;
  private readonly askTimeoutMs: number;
  private readonly startedAt = Date.now();
  private replyWaiter: ReplyWaiter | null = null;
  private readonly seenInboundMessages = new Map<string, number>();
  private readonly latestOutboundReceipts = new Map<
    string,
    { status: MessageReceiptStatus; timestamp: number; detail?: string }
  >();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connectPromise: Promise<BrokerClientLike> | null = null;
  private disposed = false;
  private agentStatus: AgentStatus;
  private readonly pendingWakeDeliveries = new Map<string, NodeJS.Timeout>();

  constructor(agent: Agent, options: BrokerTransportOptions) {
    this.agent = agent;
    this.options = options;
    this.askTimeoutMs = options.askTimeoutMs ?? getAskTimeoutMs();
    this.tracker = new ReplyTracker(this.askTimeoutMs);
    this.agentStatus = agent.status;
  }

  get agentId(): string {
    return String(this.agent.id);
  }

  isConnected(): boolean {
    return Boolean(this.client?.isConnected());
  }

  hasWaiter(): boolean {
    return this.replyWaiter !== null;
  }

  /** Start (or restart) the connection in the background; never throws. */
  connectInBackground(): void {
    void this.ensureConnected().catch((error: unknown) => {
      this.options.log?.(
        `dsh-intercom: broker connect failed for ${this.agentId}: ${toErrorMessage(error)}`,
      );
    });
  }

  /**
   * Connect this agent's client to the broker (spawning it if needed).
   * Awaits the registration handshake; throws on failure. Concurrent callers
   * share one in-flight attempt.
   */
  ensureConnected(): Promise<BrokerClientLike> {
    if (this.disposed) {
      return Promise.reject(new Error("intercom session disposed"));
    }
    const existing = this.client;
    if (existing?.isConnected()) {
      return Promise.resolve(existing);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const promise = this.doConnect();
    this.connectPromise = promise;
    const clear = () => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  private async doConnect(): Promise<BrokerClientLike> {
    const client = this.options.createClient
      ? this.options.createClient()
      : (new IntercomClient() as BrokerClientLike);
    this.attachClientHandlers(client);
    this.client = client;
    try {
      await (this.options.spawnBroker ?? (() => spawnBrokerIfNeeded()))();
      await client.connect(this.buildRegistration(), this.agentId);
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      return client;
    } catch (error) {
      if (this.client === client) {
        this.client = null;
      }
      this.lastError = toErrorMessage(error);
      await client.disconnect().catch(() => undefined);
      this.scheduleReconnect();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private buildRegistration(): SessionRegistration {
    const alias = this.options.aliasOf(this.agentId);
    const provider = this.agent.options.provider;
    const model = this.agent.options.model;
    return {
      ...(alias ? { name: alias } : {}),
      cwd: this.agent.session.header.cwd ?? process.cwd(),
      model:
        provider && model
          ? `${provider}/${model}`
          : (model ?? provider ?? "unknown"),
      pid: process.pid,
      startedAt: this.startedAt,
      lastActivity: Date.now(),
      status: this.currentStatus(),
    };
  }

  private currentStatus(): string {
    const base = lifecycleStatus(this.agentStatus);
    const suffix = this.options.config.status;
    return suffix ? `${base} · ${suffix}` : base;
  }

  /** agent/status transition: republish presence, and close the reply turn context on idle. */
  publishStatus(status: AgentStatus): void {
    this.agentStatus = status;
    if (status === "idle") {
      this.tracker.endTurn();
    }
    this.client?.updatePresence({ status: this.currentStatus() });
  }

  /** The `name` action ran: republish the alias as the presence name. */
  publishName(): void {
    const alias = this.options.aliasOf(this.agentId);
    if (alias) {
      this.client?.updatePresence({ name: alias });
    }
  }

  private attachClientHandlers(client: BrokerClientLike): void {
    client.on("message", (from, message) => {
      if (this.client !== client || this.disposed) return;
      this.handleIncoming(from, message);
    });
    client.on("disconnected", (error: Error) => {
      if (this.client !== client) return;
      this.client = null;
      this.lastError = error.message;
      this.rejectReplyWaiter(
        new Error(`Disconnected while waiting for reply: ${error.message}`),
      );
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    });
    client.on("error", () => {
      // Socket noise is normal during teardown; reconnect runs from the disconnect path.
    });
    client.onMessageReceipt((_from, receipt) => {
      this.latestOutboundReceipts.set(receipt.messageId, {
        status: receipt.status,
        timestamp: receipt.timestamp,
        ...(receipt.detail ? { detail: receipt.detail } : {}),
      });
    });
    client.onMessageControl((_from, control) => {
      this.handleMessageControl(control);
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    const delays =
      this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInBackground();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ---- inbound -----------------------------------------------------------

  private emitMessageReceipt(
    messageId: string,
    status: MessageReceiptStatus,
    detail?: string,
  ): void {
    try {
      this.client?.sendMessageReceipt({
        messageId,
        status,
        timestamp: Date.now(),
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Receipts are diagnostics; message handling must not fail with the sender.
    }
  }

  private hasSeenInboundMessage(
    from: SessionInfo,
    message: Message,
    now: number,
  ): boolean {
    for (const [key, seenAt] of this.seenInboundMessages) {
      if (now - seenAt > INBOUND_MESSAGE_DEDUPE_RETENTION_MS) {
        this.seenInboundMessages.delete(key);
      }
    }
    const key = `${from.id}\0${message.id}`;
    if (this.seenInboundMessages.has(key)) {
      return true;
    }
    this.seenInboundMessages.set(key, now);
    while (this.seenInboundMessages.size > INBOUND_MESSAGE_DEDUPE_MAX) {
      const oldestKey = this.seenInboundMessages.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.seenInboundMessages.delete(oldestKey);
    }
    return false;
  }

  private handleMessageControl(control: MessageControl): void {
    this.tracker.dismissPendingAsk(control.messageId);
    if (control.action === "cancel") {
      this.emitMessageReceipt(
        control.messageId,
        "cancellation_requested",
        "message may already be injected or processed",
      );
      return;
    }
    this.emitMessageReceipt(
      control.messageId,
      "superseded",
      control.supersededBy
        ? `superseded by ${control.supersededBy}`
        : undefined,
    );
  }

  private handleIncoming(from: SessionInfo, message: Message): void {
    const receivedAt = Date.now();
    if (this.hasSeenInboundMessage(from, message, receivedAt)) {
      this.emitMessageReceipt(
        message.id,
        "acknowledged",
        "duplicate message id suppressed",
      );
      return;
    }
    const received = { ...message, receiverReceivedAt: receivedAt };
    this.emitMessageReceipt(received.id, "receiver_received");

    const waiter = this.replyWaiter;
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches =
        senderTarget.toLowerCase() === waiter.from.toLowerCase() ||
        from.id === waiter.from;
      if (fromMatches && received.replyTo === waiter.replyTo) {
        this.emitMessageReceipt(
          received.id,
          "acknowledged",
          "matched reply waiter",
        );
        waiter.resolve(received);
        return;
      }
    }

    this.tracker.recordIncomingMessage(from, received, receivedAt);
    this.emitMessageReceipt(
      received.id,
      "acknowledged",
      "accepted by receiver",
    );
    this.deliverInbound(from, received);
  }

  /**
   * Inject an inbound broker message into the local agent. The delivery path
   * mirrors LocalTransport (idle → followup, running → steer); the
   * `inboundTrigger` policy can demote delivery to a non-waking `inject`.
   */
  private deliverInbound(from: SessionInfo, message: Message): void {
    const policy = this.options.config.inboundTrigger;
    const mayTrigger =
      policy === "always" || (policy === "replies" && Boolean(message.replyTo));
    const text = formatIntercomMessage(
      {
        display: from.name || from.id.slice(0, 8),
        address: from.name || from.id,
        cwd: from.cwd,
      },
      message.content.text,
      {
        expectsReply: message.expectsReply,
        replyHint: this.options.config.replyHint,
      },
    );
    this.emitMessageReceipt(message.id, "injected");
    if (!mayTrigger) {
      this.agent.inject(
        createUserMessage({
          content: [{ type: "text", text }],
          source: {
            kind: INTERCOM_SOURCE_KIND,
            form: "relay",
            senderSessionId: from.id,
            messageId: message.id,
          },
        }),
      );
      return;
    }
    this.deliverWithWake(from, message, text, 0);
  }

  /**
   * Deliver with a wake and arm the lost-wake watchdog. A wake issued while
   * the agent is still inside `agents.create()` can be claimed and dropped by
   * the loop without ever reaching the durable log (observed in the
   * cross-process e2e: the broker's mailbox flush lands mid-registration);
   * the watchdog re-delivers unless the message was logged or is still parked
   * in the inbox.
   */
  private deliverWithWake(
    from: SessionInfo,
    message: Message,
    text: string,
    attempt: number,
  ): void {
    const injected = createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: INTERCOM_SOURCE_KIND,
        form: "relay",
        senderSessionId: from.id,
        messageId: message.id,
      },
    });
    if (this.agent.status === "idle") {
      this.agent.followup(injected);
    } else {
      this.agent.steer(injected);
    }
    this.armDeliveryWatchdog(from, message, text, attempt);
  }

  private armDeliveryWatchdog(
    from: SessionInfo,
    message: Message,
    text: string,
    attempt: number,
  ): void {
    const maxRedeliveries =
      this.options.maxRedeliveries ?? DEFAULT_MAX_REDELIVERIES;
    const watchdogMs =
      this.options.deliveryWatchdogMs ?? DEFAULT_DELIVERY_WATCHDOG_MS;
    const timer = setTimeout(() => {
      this.pendingWakeDeliveries.delete(message.id);
      if (this.disposed) {
        return;
      }
      // Still parked in the inbox (e.g. steering a busy agent): healthy, wait.
      const parked = [
        ...this.agent.inbox.nextTurn,
        ...this.agent.inbox.nextStep,
      ].some(
        (pending) =>
          pending.source.kind === INTERCOM_SOURCE_KIND &&
          pending.source.messageId === message.id,
      );
      if (parked) {
        this.armDeliveryWatchdog(from, message, text, attempt);
        return;
      }
      // Never claimed into the durable log and no longer pending: the wake was
      // lost — redeliver, bounded.
      if (attempt >= maxRedeliveries) {
        this.options.log?.(
          `dsh-intercom: giving up delivering message ${message.id} to ${this.agentId} after ${attempt} redeliveries`,
        );
        return;
      }
      this.deliverWithWake(from, message, text, attempt + 1);
    }, watchdogMs);
    timer.unref?.();
    this.pendingWakeDeliveries.set(message.id, timer);
  }

  /**
   * The message reached the durable session log (observed via the global
   * `session/event` stream): cancel its watchdog and make its ask the current
   * reply turn context.
   */
  noteDelivered(messageId: string): void {
    const timer = this.pendingWakeDeliveries.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingWakeDeliveries.delete(messageId);
    }
    this.tracker.activateTurnContext(messageId);
  }

  // ---- ask / reply support ------------------------------------------------

  /**
   * Block until the reply to one outbound ask arrives. At most one waiter per
   * session (broker-side mutual-ask rules assume it). Aborting the signal
   * sends the broker-side `cancel_ask` and rejects with "Cancelled".
   */
  waitForReply(
    from: string,
    replyTo: string,
    signal: AbortSignal | undefined,
    getDeliveryState: () => string = () => "unknown",
  ): Promise<Message> {
    if (this.replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutDescription =
          this.askTimeoutMs % 60000 === 0
            ? `${this.askTimeoutMs / 60000} minutes`
            : `${this.askTimeoutMs}ms`;
        this.rejectReplyWaiter(
          new Error(
            `No reply from "${from}" for message ${replyTo} within ${timeoutDescription}. ` +
              `Last known delivery state: ${getDeliveryState()}. ` +
              `This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`,
          ),
        );
      }, this.askTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.replyWaiter?.replyTo === replyTo) {
          this.replyWaiter = null;
        }
      };
      const onAbort = () => {
        try {
          this.client?.cancelAsk(replyTo);
        } catch {
          // Cancellation is best-effort; local waiter cleanup must still proceed.
        }
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }

  rejectReplyWaiter(error: Error): void {
    this.replyWaiter?.reject(error);
  }

  latestDeliveryState(messageId: string | null, fallback: string): string {
    if (!messageId) {
      return fallback;
    }
    const receipt = this.latestOutboundReceipts.get(messageId);
    return receipt ? receipt.status : fallback;
  }

  /** Tear down the connection and all pending state for a disposed agent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const timer of this.pendingWakeDeliveries.values()) {
      clearTimeout(timer);
    }
    this.pendingWakeDeliveries.clear();
    this.rejectReplyWaiter(new Error("Session disposed"));
    this.tracker.reset();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.disconnect().catch(() => undefined);
    }
  }

  /** Whether this runtime drives the agent owning `session` (identity check). */
  ownsSession(session: unknown): boolean {
    return this.agent.session === session;
  }
}

/** Transport health snapshot surfaced by the `status` action. */
export interface BrokerHealth {
  readonly enabled: boolean;
  /** registered = sessions with a BrokerSession; connected = live client. */
  readonly registered: number;
  readonly connected: number;
  readonly errors: readonly string[];
}

/**
 * Owns the per-agent `BrokerSession` map and the broker lifecycle. All
 * methods are no-ops when `config.enabled` is false (the tool reports the
 * disabled state itself).
 */
export class BrokerTransport {
  private readonly sessions = new Map<string, BrokerSession>();

  constructor(private readonly options: BrokerTransportOptions) {}

  get enabled(): boolean {
    return this.options.config.enabled;
  }

  /** The broker runtime of one local agent, if it has one. */
  sessionFor(agentId: string): BrokerSession | undefined {
    return this.sessions.get(agentId);
  }

  /** Register and connect an agent (background connect; failures degrade gracefully). */
  attach(agent: Agent): void {
    if (!this.options.config.enabled) {
      return;
    }
    const id = String(agent.id);
    if (this.sessions.has(id)) {
      return;
    }
    const session = new BrokerSession(agent, this.options);
    this.sessions.set(id, session);
    session.connectInBackground();
  }

  /** Disconnect and drop an agent's broker session. */
  async detach(agent: Agent): Promise<void> {
    const id = String(agent.id);
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      await session.dispose();
    }
  }

  /** agent/status fan-out. */
  publishStatus(agent: Agent, status: AgentStatus): void {
    this.sessions.get(String(agent.id))?.publishStatus(status);
  }

  /** Alias change fan-out (the `name` action). */
  publishName(agent: Agent): void {
    this.sessions.get(String(agent.id))?.publishName();
  }

  /**
   * Global `session/event` fan-out: a `user/message` carrying an intercom
   * source confirms the delivery reached the durable log (cancels the
   * lost-wake watchdog) and makes its ask the current reply turn context.
   */
  noteSessionEvent(
    session: unknown,
    event: { type: string; data?: unknown },
  ): void {
    if (event.type !== "user/message") {
      return;
    }
    const source = (event.data as { source?: unknown } | undefined)?.source;
    if (
      typeof source !== "object" ||
      source === null ||
      !("kind" in source) ||
      source.kind !== INTERCOM_SOURCE_KIND ||
      !("messageId" in source) ||
      typeof source.messageId !== "string"
    ) {
      return;
    }
    for (const brokerSession of this.sessions.values()) {
      if (brokerSession.ownsSession(session)) {
        brokerSession.noteDelivered(source.messageId);
      }
    }
  }

  health(): BrokerHealth {
    const sessions = [...this.sessions.values()];
    return {
      enabled: this.options.config.enabled,
      registered: sessions.length,
      connected: sessions.filter((session) => session.isConnected()).length,
      errors: sessions
        .map((session) => session.lastError)
        .filter((error): error is string => Boolean(error)),
    };
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }
}
