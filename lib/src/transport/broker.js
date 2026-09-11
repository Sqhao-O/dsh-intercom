import { getAskTimeoutMs } from "../../broker/ask-timeout.js";
import { IntercomClient } from "../../broker/client.js";
import { spawnBrokerIfNeeded } from "../../broker/spawn.js";
import { INTERCOM_SOURCE_KIND } from "../source.js";
import { formatIntercomMessage } from "../message.js";
import { ReplyTracker } from "../reply-tracker.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/transport/broker.ts
const INBOUND_MESSAGE_DEDUPE_MAX = 1e3;
const INBOUND_MESSAGE_DEDUPE_RETENTION_MS = 3600 * 1e3;
const DEFAULT_RECONNECT_DELAYS_MS = [
	1e3,
	2e3,
	5e3,
	1e4,
	3e4
];
function toErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Automatic lifecycle status published to the broker roster. */
function lifecycleStatus(agentStatus) {
	return agentStatus === "running" ? "thinking" : "idle";
}
const DEFAULT_DELIVERY_WATCHDOG_MS = 2e3;
const DEFAULT_MAX_REDELIVERIES = 3;
/**
* One agent's broker runtime: the client connection, its inbound reply
* tracker, the single pending reply waiter, dedup state, and delivery-state
* receipts.
*/
var BrokerSession = class {
	tracker;
	client = null;
	/** Last connect/spawn failure, surfaced by the `status` action. */
	lastError;
	agent;
	options;
	askTimeoutMs;
	startedAt = Date.now();
	replyWaiter = null;
	seenInboundMessages = /* @__PURE__ */ new Map();
	latestOutboundReceipts = /* @__PURE__ */ new Map();
	reconnectTimer = null;
	reconnectAttempt = 0;
	connectPromise = null;
	disposed = false;
	agentStatus;
	pendingWakeDeliveries = /* @__PURE__ */ new Map();
	constructor(agent, options) {
		this.agent = agent;
		this.options = options;
		this.askTimeoutMs = options.askTimeoutMs ?? getAskTimeoutMs();
		this.tracker = new ReplyTracker(this.askTimeoutMs);
		this.agentStatus = agent.status;
	}
	get agentId() {
		return String(this.agent.id);
	}
	isConnected() {
		return Boolean(this.client?.isConnected());
	}
	hasWaiter() {
		return this.replyWaiter !== null;
	}
	/** Start (or restart) the connection in the background; never throws. */
	connectInBackground() {
		this.ensureConnected().catch((error) => {
			this.options.log?.(`dsh-intercom: broker connect failed for ${this.agentId}: ${toErrorMessage(error)}`);
		});
	}
	/**
	* Connect this agent's client to the broker (spawning it if needed).
	* Awaits the registration handshake; throws on failure. Concurrent callers
	* share one in-flight attempt.
	*/
	ensureConnected() {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("intercom session disposed"));
		const existing = this.client;
		if (existing?.isConnected()) return Promise.resolve(existing);
		if (this.connectPromise) return this.connectPromise;
		const promise = this.doConnect();
		this.connectPromise = promise;
		const clear = () => {
			if (this.connectPromise === promise) this.connectPromise = null;
		};
		promise.then(clear, clear);
		return promise;
	}
	async doConnect() {
		const client = this.options.createClient ? this.options.createClient() : new IntercomClient();
		this.attachClientHandlers(client);
		this.client = client;
		try {
			await (this.options.spawnBroker ?? (() => spawnBrokerIfNeeded()))();
			await client.connect(this.buildRegistration(), this.agentId);
			this.reconnectAttempt = 0;
			this.lastError = void 0;
			return client;
		} catch (error) {
			if (this.client === client) this.client = null;
			this.lastError = toErrorMessage(error);
			await client.disconnect().catch(() => void 0);
			this.scheduleReconnect();
			throw error instanceof Error ? error : new Error(String(error));
		}
	}
	buildRegistration() {
		const alias = this.options.aliasOf(this.agentId);
		const provider = this.agent.options.provider;
		const model = this.agent.options.model;
		return {
			...alias ? { name: alias } : {},
			cwd: this.agent.session.header.cwd ?? process.cwd(),
			model: provider && model ? `${provider}/${model}` : model ?? provider ?? "unknown",
			pid: process.pid,
			startedAt: this.startedAt,
			lastActivity: Date.now(),
			status: this.currentStatus()
		};
	}
	currentStatus() {
		const base = lifecycleStatus(this.agentStatus);
		const suffix = this.options.config.status;
		return suffix ? `${base} · ${suffix}` : base;
	}
	/** agent/status transition: republish presence, and close the reply turn context on idle. */
	publishStatus(status) {
		this.agentStatus = status;
		if (status === "idle") this.tracker.endTurn();
		this.client?.updatePresence({ status: this.currentStatus() });
	}
	/** The `name` action ran: republish the alias as the presence name. */
	publishName() {
		const alias = this.options.aliasOf(this.agentId);
		if (alias) this.client?.updatePresence({ name: alias });
	}
	attachClientHandlers(client) {
		client.on("message", (from, message) => {
			if (this.client !== client || this.disposed) return;
			this.handleIncoming(from, message);
		});
		client.on("disconnected", (error) => {
			if (this.client !== client) return;
			this.client = null;
			this.lastError = error.message;
			this.rejectReplyWaiter(/* @__PURE__ */ new Error(`Disconnected while waiting for reply: ${error.message}`));
			if (!this.disposed) this.scheduleReconnect();
		});
		client.on("error", () => {});
		client.onMessageReceipt((_from, receipt) => {
			this.latestOutboundReceipts.set(receipt.messageId, {
				status: receipt.status,
				timestamp: receipt.timestamp,
				...receipt.detail ? { detail: receipt.detail } : {}
			});
		});
		client.onMessageControl((_from, control) => {
			this.handleMessageControl(control);
		});
	}
	scheduleReconnect() {
		if (this.disposed || this.reconnectTimer) return;
		const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connectInBackground();
		}, delay);
		this.reconnectTimer.unref?.();
	}
	emitMessageReceipt(messageId, status, detail) {
		try {
			this.client?.sendMessageReceipt({
				messageId,
				status,
				timestamp: Date.now(),
				...detail ? { detail } : {}
			});
		} catch {}
	}
	hasSeenInboundMessage(from, message, now) {
		for (const [key, seenAt] of this.seenInboundMessages) if (now - seenAt > INBOUND_MESSAGE_DEDUPE_RETENTION_MS) this.seenInboundMessages.delete(key);
		const key = `${from.id}\0${message.id}`;
		if (this.seenInboundMessages.has(key)) return true;
		this.seenInboundMessages.set(key, now);
		while (this.seenInboundMessages.size > INBOUND_MESSAGE_DEDUPE_MAX) {
			const oldestKey = this.seenInboundMessages.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.seenInboundMessages.delete(oldestKey);
		}
		return false;
	}
	handleMessageControl(control) {
		this.tracker.dismissPendingAsk(control.messageId);
		if (control.action === "cancel") {
			this.emitMessageReceipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
			return;
		}
		this.emitMessageReceipt(control.messageId, "superseded", control.supersededBy ? `superseded by ${control.supersededBy}` : void 0);
	}
	handleIncoming(from, message) {
		const receivedAt = Date.now();
		if (this.hasSeenInboundMessage(from, message, receivedAt)) {
			this.emitMessageReceipt(message.id, "acknowledged", "duplicate message id suppressed");
			return;
		}
		const received = {
			...message,
			receiverReceivedAt: receivedAt
		};
		this.emitMessageReceipt(received.id, "receiver_received");
		const waiter = this.replyWaiter;
		if (waiter) {
			if (((from.name || from.id).toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from) && received.replyTo === waiter.replyTo) {
				this.emitMessageReceipt(received.id, "acknowledged", "matched reply waiter");
				waiter.resolve(received);
				return;
			}
		}
		this.tracker.recordIncomingMessage(from, received, receivedAt);
		this.emitMessageReceipt(received.id, "acknowledged", "accepted by receiver");
		this.deliverInbound(from, received);
	}
	/**
	* Inject an inbound broker message into the local agent. The delivery path
	* mirrors LocalTransport (idle → followup, running → steer); the
	* `inboundTrigger` policy can demote delivery to a non-waking `inject`.
	*/
	deliverInbound(from, message) {
		const policy = this.options.config.inboundTrigger;
		const mayTrigger = policy === "always" || policy === "replies" && Boolean(message.replyTo);
		const text = formatIntercomMessage({
			display: from.name || from.id.slice(0, 8),
			address: from.name || from.id,
			cwd: from.cwd
		}, message.content.text, {
			expectsReply: message.expectsReply,
			replyHint: this.options.config.replyHint
		});
		this.emitMessageReceipt(message.id, "injected");
		if (!mayTrigger) {
			this.agent.inject(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: INTERCOM_SOURCE_KIND,
					form: "relay",
					senderSessionId: from.id,
					messageId: message.id
				}
			}));
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
	deliverWithWake(from, message, text, attempt) {
		const injected = createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: INTERCOM_SOURCE_KIND,
				form: "relay",
				senderSessionId: from.id,
				messageId: message.id
			}
		});
		if (this.agent.status === "idle") this.agent.followup(injected);
		else this.agent.steer(injected);
		this.armDeliveryWatchdog(from, message, text, attempt);
	}
	armDeliveryWatchdog(from, message, text, attempt) {
		const maxRedeliveries = this.options.maxRedeliveries ?? DEFAULT_MAX_REDELIVERIES;
		const watchdogMs = this.options.deliveryWatchdogMs ?? DEFAULT_DELIVERY_WATCHDOG_MS;
		const timer = setTimeout(() => {
			this.pendingWakeDeliveries.delete(message.id);
			if (this.disposed) return;
			if ([...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep].some((pending) => pending.source.kind === "intercom" && pending.source.messageId === message.id)) {
				this.armDeliveryWatchdog(from, message, text, attempt);
				return;
			}
			if (attempt >= maxRedeliveries) {
				this.options.log?.(`dsh-intercom: giving up delivering message ${message.id} to ${this.agentId} after ${attempt} redeliveries`);
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
	noteDelivered(messageId) {
		const timer = this.pendingWakeDeliveries.get(messageId);
		if (timer) {
			clearTimeout(timer);
			this.pendingWakeDeliveries.delete(messageId);
		}
		this.tracker.activateTurnContext(messageId);
	}
	/**
	* Block until the reply to one outbound ask arrives. At most one waiter per
	* session (broker-side mutual-ask rules assume it). Aborting the signal
	* sends the broker-side `cancel_ask` and rejects with "Cancelled".
	*/
	waitForReply(from, replyTo, signal, getDeliveryState = () => "unknown") {
		if (this.replyWaiter) return Promise.reject(/* @__PURE__ */ new Error("Already waiting for a reply"));
		if (signal?.aborted) return Promise.reject(/* @__PURE__ */ new Error("Cancelled"));
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const timeoutDescription = this.askTimeoutMs % 6e4 === 0 ? `${this.askTimeoutMs / 6e4} minutes` : `${this.askTimeoutMs}ms`;
				this.rejectReplyWaiter(/* @__PURE__ */ new Error(`No reply from "${from}" for message ${replyTo} within ${timeoutDescription}. Last known delivery state: ${getDeliveryState()}. This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`));
			}, this.askTimeoutMs);
			const cleanup = () => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (this.replyWaiter?.replyTo === replyTo) this.replyWaiter = null;
			};
			const onAbort = () => {
				try {
					this.client?.cancelAsk(replyTo);
				} catch {}
				cleanup();
				reject(/* @__PURE__ */ new Error("Cancelled"));
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
				}
			};
		});
	}
	rejectReplyWaiter(error) {
		this.replyWaiter?.reject(error);
	}
	latestDeliveryState(messageId, fallback) {
		if (!messageId) return fallback;
		const receipt = this.latestOutboundReceipts.get(messageId);
		return receipt ? receipt.status : fallback;
	}
	/** Tear down the connection and all pending state for a disposed agent. */
	async dispose() {
		this.disposed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const timer of this.pendingWakeDeliveries.values()) clearTimeout(timer);
		this.pendingWakeDeliveries.clear();
		this.rejectReplyWaiter(/* @__PURE__ */ new Error("Session disposed"));
		this.tracker.reset();
		const client = this.client;
		this.client = null;
		if (client) await client.disconnect().catch(() => void 0);
	}
	/** Whether this runtime drives the agent owning `session` (identity check). */
	ownsSession(session) {
		return this.agent.session === session;
	}
};
/**
* Owns the per-agent `BrokerSession` map and the broker lifecycle. All
* methods are no-ops when `config.enabled` is false (the tool reports the
* disabled state itself).
*/
var BrokerTransport = class {
	sessions = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	get enabled() {
		return this.options.config.enabled;
	}
	/** The broker runtime of one local agent, if it has one. */
	sessionFor(agentId) {
		return this.sessions.get(agentId);
	}
	/** Every attached broker session, one per local agent (panel roster source). */
	listAttached() {
		return [...this.sessions.values()];
	}
	/** Register and connect an agent (background connect; failures degrade gracefully). */
	attach(agent) {
		if (!this.options.config.enabled) return;
		const id = String(agent.id);
		if (this.sessions.has(id)) return;
		const session = new BrokerSession(agent, this.options);
		this.sessions.set(id, session);
		session.connectInBackground();
	}
	/** Disconnect and drop an agent's broker session. */
	async detach(agent) {
		const id = String(agent.id);
		const session = this.sessions.get(id);
		if (session) {
			this.sessions.delete(id);
			await session.dispose();
		}
	}
	/** agent/status fan-out. */
	publishStatus(agent, status) {
		this.sessions.get(String(agent.id))?.publishStatus(status);
	}
	/** Alias change fan-out (the `name` action). */
	publishName(agent) {
		this.sessions.get(String(agent.id))?.publishName();
	}
	/**
	* Global `session/event` fan-out: a `user/message` carrying an intercom
	* source confirms the delivery reached the durable log (cancels the
	* lost-wake watchdog) and makes its ask the current reply turn context.
	*/
	noteSessionEvent(session, event) {
		if (event.type !== "user/message") return;
		const source = event.data?.source;
		if (typeof source !== "object" || source === null || !("kind" in source) || source.kind !== "intercom" || !("messageId" in source) || typeof source.messageId !== "string") return;
		for (const brokerSession of this.sessions.values()) if (brokerSession.ownsSession(session)) brokerSession.noteDelivered(source.messageId);
	}
	health() {
		const sessions = [...this.sessions.values()];
		return {
			enabled: this.options.config.enabled,
			registered: sessions.length,
			connected: sessions.filter((session) => session.isConnected()).length,
			errors: sessions.map((session) => session.lastError).filter((error) => Boolean(error))
		};
	}
	async dispose() {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => session.dispose()));
	}
};
//#endregion
export { BrokerSession, BrokerTransport };
