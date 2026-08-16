import { getAskTimeoutMs } from "./ask-timeout.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { isMessage, isMessageReceipt, isSessionId, isSessionRegistration } from "./protocol.js";
import { INTERCOM_PROTOCOL_NAME, ensureIntercomRuntimeDir, getBrokerListenTarget, getBrokerPortFilePath, getIntercomDirPath, restrictIntercomRuntimeFile } from "./paths.js";
import { sameCwd } from "../cwd.js";
import { EXTENSION_BUS_FEATURE } from "../types.js";
import { ExtensionStateManager } from "./extension-state.js";
import { assertNoLiveBroker } from "./runtime-claim.js";
import net from "net";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
//#region broker/broker.ts
const INTERCOM_DIR = getIntercomDirPath();
const LISTEN_TARGET = getBrokerListenTarget();
const PID_PATH = join(INTERCOM_DIR, "broker.pid");
const PORT_PATH = getBrokerPortFilePath(INTERCOM_DIR);
const BROKER_STATE_ID = randomUUID();
const MAX_SESSIONS = 128;
const MAX_UNREGISTERED_CONNECTIONS = 32;
const REGISTRATION_TIMEOUT_MS = 1e3;
const RATE_LIMIT_CAPACITY = 240;
const RATE_LIMIT_REFILL_PER_SECOND = 120;
const PRESENCE_HEARTBEAT_MS = 1e3;
const MAX_EXTENSIONS_PER_SESSION = 32;
const MAX_EXTENSION_MESSAGE_BYTES = 16384;
const MAX_EXTENSION_STATE_BYTES = 65536;
const MESSAGE_RECEIPT_ROUTE_RETENTION_MS = 36e5;
const DISCONNECTED_SESSION_RETENTION_MS = 864e5;
const MAILBOX_MESSAGE_RETENTION_MS = 864e5;
const MAX_MAILBOX_MESSAGES = 256;
function serializedPayloadSize(payload) {
	try {
		const json = JSON.stringify(payload);
		return json === void 0 ? null : Buffer.byteLength(json, "utf8");
	} catch {
		return null;
	}
}
var IntercomBroker = class {
	sessions = /* @__PURE__ */ new Map();
	askEdges = /* @__PURE__ */ new Map();
	messageReceiptRoutes = /* @__PURE__ */ new Map();
	disconnectedSessions = /* @__PURE__ */ new Map();
	mailboxMessages = [];
	connections = /* @__PURE__ */ new Set();
	unregisteredConnections = /* @__PURE__ */ new Set();
	server;
	shutdownTimer = null;
	askTimeoutMs = getAskTimeoutMs();
	namespaceOwners = /* @__PURE__ */ new Map();
	nextOwnerOrder = 1;
	extensionStateManager;
	constructor() {
		ensureIntercomRuntimeDir(INTERCOM_DIR);
		assertNoLiveBroker(PID_PATH);
		this.extensionStateManager = new ExtensionStateManager(INTERCOM_DIR);
		if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") try {
			unlinkSync(LISTEN_TARGET);
		} catch {}
		this.server = net.createServer(this.handleConnection.bind(this));
	}
	start() {
		const onListening = () => {
			if (typeof LISTEN_TARGET === "string") restrictIntercomRuntimeFile(LISTEN_TARGET);
			else {
				const address = this.server.address();
				if (!address || typeof address === "string") throw new Error("Intercom TCP broker started without a TCP address");
				const endpoint = {
					transport: "tcp",
					host: LISTEN_TARGET.host,
					port: address.port,
					stateId: BROKER_STATE_ID
				};
				writeFileSync(PORT_PATH, `${JSON.stringify(endpoint)}\n`, { mode: 384 });
				restrictIntercomRuntimeFile(PORT_PATH);
			}
			writeFileSync(PID_PATH, String(process.pid), { mode: 384 });
			restrictIntercomRuntimeFile(PID_PATH);
			console.log(`Intercom broker started (pid: ${process.pid})`);
		};
		if (typeof LISTEN_TARGET === "string") this.server.listen(LISTEN_TARGET, onListening);
		else this.server.listen({
			host: LISTEN_TARGET.host,
			port: LISTEN_TARGET.port
		}, onListening);
		process.on("SIGTERM", () => this.shutdown());
		process.on("SIGINT", () => this.shutdown());
	}
	handleConnection(socket) {
		this.connections.add(socket);
		let sessionId = null;
		let registrationTimeout = null;
		const armRegistrationTimeout = () => {
			if (registrationTimeout) clearTimeout(registrationTimeout);
			this.unregisteredConnections.delete(socket);
			this.unregisteredConnections.add(socket);
			this.evictOldestUnregisteredConnections(socket);
			registrationTimeout = setTimeout(() => {
				if (!sessionId) socket.destroy();
			}, REGISTRATION_TIMEOUT_MS);
			registrationTimeout.unref?.();
		};
		const clearRegistrationTimeout = () => {
			if (registrationTimeout) {
				clearTimeout(registrationTimeout);
				registrationTimeout = null;
			}
			this.unregisteredConnections.delete(socket);
		};
		armRegistrationTimeout();
		const connection = {
			socket,
			tokens: RATE_LIMIT_CAPACITY,
			lastRefillAt: Date.now()
		};
		const reader = createMessageReader((msg) => {
			if (!this.consumeToken(connection)) {
				writeMessage(socket, {
					type: "error",
					error: "Intercom broker rate limit exceeded"
				});
				socket.destroy(/* @__PURE__ */ new Error("Intercom broker rate limit exceeded"));
				return;
			}
			this.handleMessage(socket, msg, sessionId, (id) => {
				sessionId = id;
				if (id) clearRegistrationTimeout();
				else armRegistrationTimeout();
			});
		}, (error) => {
			socket.destroy(error);
		});
		socket.on("data", reader);
		socket.on("close", () => {
			clearRegistrationTimeout();
			this.connections.delete(socket);
			if (sessionId) {
				const existing = this.sessions.get(sessionId);
				if (existing?.socket === socket) {
					this.rememberDisconnectedSession(existing.info);
					this.sessions.delete(sessionId);
					this.clearMessageReceiptRoutesForSession(sessionId);
					this.broadcast({
						type: "session_left",
						sessionId
					}, sessionId);
					this.recomputeNamespaceOwners();
					this.scheduleShutdownCheck();
				}
			}
		});
		socket.on("error", (error) => {
			console.error("Socket error:", error);
		});
	}
	evictOldestUnregisteredConnections(currentSocket) {
		while (this.unregisteredConnections.size > MAX_UNREGISTERED_CONNECTIONS) {
			const [oldest] = this.unregisteredConnections;
			if (!oldest) return;
			if (oldest === currentSocket && this.unregisteredConnections.size === 1) return;
			this.unregisteredConnections.delete(oldest);
			oldest.destroy();
		}
	}
	consumeToken(connection, now = Date.now()) {
		const elapsedMs = now - connection.lastRefillAt;
		if (elapsedMs > 0) {
			connection.tokens = Math.min(RATE_LIMIT_CAPACITY, connection.tokens + elapsedMs * RATE_LIMIT_REFILL_PER_SECOND / 1e3);
			connection.lastRefillAt = now;
		}
		if (connection.tokens < 1) return false;
		connection.tokens -= 1;
		return true;
	}
	scheduleShutdownCheck() {
		if (this.shutdownTimer) return;
		this.shutdownTimer = setTimeout(() => {
			this.shutdownTimer = null;
			if (this.sessions.size === 0) {
				console.log("No sessions connected, shutting down");
				this.shutdown();
			}
		}, 5e3);
	}
	handleMessage(socket, msg, currentId, setId) {
		if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") throw new Error("Invalid client message");
		const clientMessage = msg;
		const requiresEndpointAuth = typeof LISTEN_TARGET !== "string";
		const hasEndpointAuth = clientMessage.stateId === BROKER_STATE_ID;
		if (clientMessage.type === "health") {
			if (typeof clientMessage.requestId !== "string") throw new Error("Invalid health message");
			if (requiresEndpointAuth && !hasEndpointAuth) throw new Error("Invalid intercom TCP endpoint credentials");
			writeMessage(socket, {
				type: "health_ok",
				requestId: clientMessage.requestId,
				protocol: INTERCOM_PROTOCOL_NAME,
				version: 1
			});
			return;
		}
		if (requiresEndpointAuth && clientMessage.type === "register" && !hasEndpointAuth) throw new Error("Invalid intercom TCP endpoint credentials");
		if (currentId === null && clientMessage.type !== "register") throw new Error(`Received ${clientMessage.type} before register`);
		switch (clientMessage.type) {
			case "register": {
				if (!isSessionRegistration(clientMessage.session)) throw new Error("Invalid register message");
				if (currentId) throw new Error("Received duplicate register message");
				let id = randomUUID();
				if (clientMessage.sessionId !== void 0) {
					if (!isSessionId(clientMessage.sessionId)) throw new Error("Invalid register sessionId");
					id = clientMessage.sessionId;
				}
				const session = clientMessage.session;
				const extensions = session.extensions;
				if (extensions !== void 0) {
					if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
					for (const extension of extensions) if (!this.validateExtensionCapability(extension)) throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
				}
				this.pruneDisconnectedSessions();
				this.pruneMailboxMessages();
				const previous = this.sessions.get(id);
				if (!previous && this.sessions.size >= MAX_SESSIONS) {
					writeMessage(socket, {
						type: "error",
						error: "Too many registered intercom sessions"
					});
					socket.destroy();
					break;
				}
				if (previous) {
					this.clearAskEdgesForSession(id);
					this.clearMessageReceiptRoutesForSession(id);
					previous.socket.end();
				}
				setId(id);
				const info = {
					id,
					...session.name !== void 0 ? { name: session.name } : {},
					...session.runtimeFallbackAlias !== void 0 ? { runtimeFallbackAlias: session.runtimeFallbackAlias } : {},
					cwd: session.cwd,
					model: session.model,
					pid: session.pid,
					startedAt: session.startedAt,
					lastActivity: session.lastActivity,
					...session.status !== void 0 ? { status: session.status } : {},
					...session.tmuxPane !== void 0 ? { tmuxPane: session.tmuxPane } : {},
					trustedLocal: typeof LISTEN_TARGET === "string" && process.platform !== "win32"
				};
				const connectedSession = {
					socket,
					info,
					lastPresenceBroadcastAt: Date.now(),
					ownerOrder: previous?.ownerOrder ?? this.nextOwnerOrder++,
					extensions
				};
				this.sessions.set(id, connectedSession);
				this.disconnectedSessions.delete(id);
				if (this.shutdownTimer) {
					clearTimeout(this.shutdownTimer);
					this.shutdownTimer = null;
				}
				writeMessage(socket, {
					type: "registered",
					sessionId: id,
					features: [EXTENSION_BUS_FEATURE]
				});
				this.broadcast({
					type: "session_joined",
					session: info
				}, id);
				this.recomputeNamespaceOwners();
				this.flushMailboxForSession(connectedSession);
				if (extensions) for (const ext of extensions) {
					const owner = this.namespaceOwners.get(ext.namespace);
					writeMessage(socket, {
						type: "extension_owner",
						namespace: ext.namespace,
						...owner ? {
							ownerId: owner.sessionId,
							ownerEpoch: owner.epoch
						} : {}
					});
					const state = this.extensionStateManager.loadState(ext.namespace);
					if (state) writeMessage(socket, {
						type: "extension_state",
						namespace: ext.namespace,
						revision: state.revision,
						payload: state.payload
					});
				}
				break;
			}
			case "unregister": {
				if (!currentId) throw new Error("Received unregister before register");
				const existing = this.sessions.get(currentId);
				if (existing?.socket === socket) {
					this.rememberDisconnectedSession(existing.info);
					this.sessions.delete(currentId);
					this.clearMessageReceiptRoutesForSession(currentId);
					this.broadcast({
						type: "session_left",
						sessionId: currentId
					}, currentId);
					this.recomputeNamespaceOwners();
					this.scheduleShutdownCheck();
				}
				setId(null);
				break;
			}
			case "extension_capabilities_update": {
				if (!currentId) throw new Error("Received extension_capabilities_update before register");
				const session = this.sessions.get(currentId);
				if (!session || session.socket !== socket) throw new Error("Extension capability session not found");
				const extensions = clientMessage.extensions;
				if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS_PER_SESSION) throw new Error(`Invalid extensions field (maximum ${MAX_EXTENSIONS_PER_SESSION})`);
				for (const extension of extensions) if (!this.validateExtensionCapability(extension)) throw new Error(`Invalid extension capability: ${JSON.stringify(extension)}`);
				session.extensions = extensions;
				this.recomputeNamespaceOwners();
				for (const extension of extensions) {
					const owner = this.namespaceOwners.get(extension.namespace);
					writeMessage(socket, {
						type: "extension_owner",
						namespace: extension.namespace,
						...owner ? {
							ownerId: owner.sessionId,
							ownerEpoch: owner.epoch
						} : {}
					});
					const state = this.extensionStateManager.loadState(extension.namespace);
					if (state) writeMessage(socket, {
						type: "extension_state",
						namespace: extension.namespace,
						revision: state.revision,
						payload: state.payload
					});
				}
				break;
			}
			case "list": {
				if (typeof clientMessage.requestId !== "string") throw new Error("Invalid list message");
				const sessions = Array.from(this.sessions.values()).map((s) => s.info);
				writeMessage(socket, {
					type: "sessions",
					requestId: clientMessage.requestId,
					sessions
				});
				break;
			}
			case "send": {
				if (!currentId) throw new Error("Received send before register");
				const message = clientMessage.message;
				const messageId = isMessage(message) ? message.id : "unknown";
				if (typeof clientMessage.to !== "string" || !isMessage(message)) {
					writeMessage(socket, {
						type: "delivery_failed",
						messageId,
						reason: "Invalid message format"
					});
					break;
				}
				const brokerReceivedAt = Date.now();
				this.pruneAskEdges();
				this.pruneMessageReceiptRoutes(brokerReceivedAt);
				const replyEdge = message.replyTo ? this.askEdges.get(message.replyTo) : void 0;
				const targets = this.findSessions(clientMessage.to);
				if (targets.length === 1) {
					if (message.replyTo && !replyEdge) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Reply target does not match a pending ask"
						});
						break;
					}
					const fromSession = this.sessions.get(currentId);
					if (!fromSession || fromSession.socket !== socket) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Sender session not found"
						});
						break;
					}
					const target = targets[0];
					if (message.supersedes) {
						const supersededRoute = this.messageReceiptRoutes.get(message.supersedes);
						if (!supersededRoute || supersededRoute.from !== currentId || supersededRoute.to !== target.info.id) {
							writeMessage(socket, {
								type: "delivery_failed",
								messageId: message.id,
								reason: "Supersede target does not match a previous message from this sender to this receiver"
							});
							break;
						}
					}
					if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.info.id)) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Reply target does not match the pending ask"
						});
						break;
					}
					if (message.expectsReply) {
						if (Array.from(this.askEdges.entries()).find(([edgeMessageId, edge]) => edgeMessageId !== message.replyTo && edge.from === target.info.id && edge.to === currentId)) {
							writeMessage(socket, {
								type: "delivery_failed",
								messageId: message.id,
								reason: "Mutual ask refused: target session is already waiting for a reply from this session."
							});
							break;
						}
						this.askEdges.set(message.id, {
							from: currentId,
							to: target.info.id,
							createdAt: Date.now()
						});
					}
					const deliveredMessage = {
						...message,
						brokerReceivedAt,
						brokerDeliveredAt: Date.now()
					};
					if (message.supersedes) {
						const control = {
							action: "supersede",
							messageId: message.supersedes,
							supersededBy: message.id,
							timestamp: Date.now()
						};
						writeMessage(target.socket, {
							type: "message_control",
							from: fromSession.info,
							control
						});
					}
					writeMessage(target.socket, {
						type: "message",
						from: fromSession.info,
						message: deliveredMessage
					});
					if (message.replyTo) this.askEdges.delete(message.replyTo);
					this.messageReceiptRoutes.set(message.id, {
						from: currentId,
						to: target.info.id,
						createdAt: brokerReceivedAt
					});
					writeMessage(socket, {
						type: "delivered",
						messageId: message.id
					});
					break;
				}
				if (targets.length > 1) {
					writeMessage(socket, {
						type: "delivery_failed",
						messageId: message.id,
						reason: `Multiple sessions named \"${clientMessage.to}\" are connected. Use the session ID instead.`
					});
					break;
				}
				const disconnectedTargets = this.findDisconnectedSessions(clientMessage.to);
				if (disconnectedTargets.length === 1) {
					if (message.replyTo && !replyEdge) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Reply target does not match a pending ask"
						});
						break;
					}
					const fromSession = this.sessions.get(currentId);
					if (!fromSession || fromSession.socket !== socket) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Sender session not found"
						});
						break;
					}
					const target = disconnectedTargets[0].info;
					if (message.supersedes) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Supersede target is not connected"
						});
						break;
					}
					if (replyEdge && (replyEdge.to !== currentId || replyEdge.from !== target.id)) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Reply target does not match the pending ask"
						});
						break;
					}
					if (message.expectsReply) {
						writeMessage(socket, {
							type: "delivery_failed",
							messageId: message.id,
							reason: "Target session is not currently connected; blocking asks are not queued"
						});
						break;
					}
					const liveMailboxTarget = this.findUniqueLiveSessionForDisconnectedSession(target, currentId);
					if (liveMailboxTarget) {
						const deliveredMessage = {
							...message,
							brokerReceivedAt,
							brokerDeliveredAt: Date.now()
						};
						writeMessage(liveMailboxTarget.socket, {
							type: "message",
							from: fromSession.info,
							message: deliveredMessage
						});
						this.messageReceiptRoutes.set(message.id, {
							from: currentId,
							to: liveMailboxTarget.info.id,
							createdAt: brokerReceivedAt
						});
					} else this.queueMailboxMessage(fromSession.info, target, message, brokerReceivedAt);
					if (message.replyTo) this.askEdges.delete(message.replyTo);
					writeMessage(socket, {
						type: "delivered",
						messageId: message.id
					});
					break;
				}
				if (disconnectedTargets.length > 1) {
					writeMessage(socket, {
						type: "delivery_failed",
						messageId: message.id,
						reason: `Multiple disconnected sessions named \"${clientMessage.to}\" can receive queued mail. Use the session ID instead.`
					});
					break;
				}
				writeMessage(socket, {
					type: "delivery_failed",
					messageId: message.id,
					reason: "Session not found"
				});
				break;
			}
			case "message_receipt": {
				if (!currentId) throw new Error("Received message_receipt before register");
				if (!isMessageReceipt(clientMessage.receipt)) throw new Error("Invalid message_receipt message");
				this.pruneMessageReceiptRoutes();
				const route = this.messageReceiptRoutes.get(clientMessage.receipt.messageId);
				const receiver = this.sessions.get(currentId);
				const sender = route ? this.sessions.get(route.from) : void 0;
				if (route?.to === currentId && receiver?.socket === socket && sender) writeMessage(sender.socket, {
					type: "message_receipt",
					from: receiver.info,
					receipt: clientMessage.receipt
				});
				break;
			}
			case "cancel_message": {
				if (!currentId) throw new Error("Received cancel_message before register");
				if (typeof clientMessage.messageId !== "string") throw new Error("Invalid cancel_message message");
				this.pruneMessageReceiptRoutes();
				this.pruneMailboxMessages();
				const sender = this.sessions.get(currentId);
				const queuedIndex = this.mailboxMessages.findIndex((entry) => entry.message.id === clientMessage.messageId && entry.from.id === currentId);
				if (queuedIndex >= 0 && sender?.socket === socket) {
					this.mailboxMessages.splice(queuedIndex, 1);
					if (this.askEdges.get(clientMessage.messageId)?.from === currentId) this.askEdges.delete(clientMessage.messageId);
					writeMessage(socket, {
						type: "delivered",
						messageId: clientMessage.messageId
					});
					break;
				}
				const route = this.messageReceiptRoutes.get(clientMessage.messageId);
				const receiver = route ? this.sessions.get(route.to) : void 0;
				if (route?.from !== currentId || sender?.socket !== socket || !receiver) {
					writeMessage(socket, {
						type: "delivery_failed",
						messageId: clientMessage.messageId,
						reason: "Message cannot be cancelled by this session"
					});
					break;
				}
				writeMessage(receiver.socket, {
					type: "message_control",
					from: sender.info,
					control: {
						action: "cancel",
						messageId: clientMessage.messageId,
						timestamp: Date.now()
					}
				});
				if (this.askEdges.get(clientMessage.messageId)?.from === currentId) this.askEdges.delete(clientMessage.messageId);
				writeMessage(socket, {
					type: "delivered",
					messageId: clientMessage.messageId
				});
				break;
			}
			case "cancel_ask": {
				if (!currentId) throw new Error("Received cancel_ask before register");
				if (typeof clientMessage.messageId !== "string") throw new Error("Invalid cancel_ask message");
				const session = this.sessions.get(currentId);
				const edge = this.askEdges.get(clientMessage.messageId);
				if (session?.socket === socket && edge?.from === currentId) this.askEdges.delete(clientMessage.messageId);
				break;
			}
			case "presence": {
				if (!currentId) throw new Error("Received presence before register");
				const session = this.sessions.get(currentId);
				if (session?.socket === socket) {
					let changed = false;
					if (clientMessage.name !== void 0) {
						if (typeof clientMessage.name !== "string") throw new Error("Invalid presence name");
						if (session.info.name !== clientMessage.name) {
							session.info.name = clientMessage.name;
							changed = true;
						}
					}
					if (clientMessage.runtimeFallbackAlias !== void 0) {
						if (typeof clientMessage.runtimeFallbackAlias !== "boolean") throw new Error("Invalid presence runtimeFallbackAlias");
						if (session.info.runtimeFallbackAlias !== clientMessage.runtimeFallbackAlias) {
							session.info.runtimeFallbackAlias = clientMessage.runtimeFallbackAlias;
							changed = true;
						}
					}
					if (clientMessage.status !== void 0) {
						if (typeof clientMessage.status !== "string") throw new Error("Invalid presence status");
						if (session.info.status !== clientMessage.status) {
							session.info.status = clientMessage.status;
							changed = true;
						}
					}
					if (clientMessage.model !== void 0) {
						if (typeof clientMessage.model !== "string") throw new Error("Invalid presence model");
						if (session.info.model !== clientMessage.model) {
							session.info.model = clientMessage.model;
							changed = true;
						}
					}
					if (clientMessage.contextPct !== void 0) {
						if (clientMessage.contextPct === null) {
							if (session.info.contextPct !== void 0) {
								delete session.info.contextPct;
								changed = true;
							}
						} else if (typeof clientMessage.contextPct !== "number") throw new Error("Invalid presence contextPct");
						else if (session.info.contextPct !== clientMessage.contextPct) {
							session.info.contextPct = clientMessage.contextPct;
							changed = true;
						}
					}
					if (clientMessage.contextTokens !== void 0) {
						if (clientMessage.contextTokens === null) {
							if (session.info.contextTokens !== void 0) {
								delete session.info.contextTokens;
								changed = true;
							}
						} else if (typeof clientMessage.contextTokens !== "number") throw new Error("Invalid presence contextTokens");
						else if (session.info.contextTokens !== clientMessage.contextTokens) {
							session.info.contextTokens = clientMessage.contextTokens;
							changed = true;
						}
					}
					if (clientMessage.contextWindow !== void 0) {
						if (clientMessage.contextWindow === null) {
							if (session.info.contextWindow !== void 0) {
								delete session.info.contextWindow;
								changed = true;
							}
						} else if (typeof clientMessage.contextWindow !== "number") throw new Error("Invalid presence contextWindow");
						else if (session.info.contextWindow !== clientMessage.contextWindow) {
							session.info.contextWindow = clientMessage.contextWindow;
							changed = true;
						}
					}
					const now = Date.now();
					session.info.lastActivity = now;
					if (changed || now - session.lastPresenceBroadcastAt >= PRESENCE_HEARTBEAT_MS) {
						session.lastPresenceBroadcastAt = now;
						this.broadcast({
							type: "presence_update",
							session: session.info
						}, currentId);
					}
				}
				break;
			}
			case "extension_publish":
				this.handleExtensionPublish(socket, currentId, clientMessage);
				break;
			case "extension_state_commit":
				this.handleExtensionStateCommit(socket, currentId, clientMessage);
				break;
			default: throw new Error(`Unknown client message type: ${clientMessage.type}`);
		}
	}
	rememberDisconnectedSession(info, now = Date.now()) {
		this.disconnectedSessions.set(info.id, {
			info: { ...info },
			disconnectedAt: now
		});
		this.pruneDisconnectedSessions(now);
	}
	pruneDisconnectedSessions(now = Date.now()) {
		for (const [sessionId, session] of this.disconnectedSessions) if (now - session.disconnectedAt > DISCONNECTED_SESSION_RETENTION_MS) this.disconnectedSessions.delete(sessionId);
	}
	pruneMailboxMessages(now = Date.now()) {
		for (let index = this.mailboxMessages.length - 1; index >= 0; index -= 1) {
			const entry = this.mailboxMessages[index];
			if (now - entry.queuedAt > MAILBOX_MESSAGE_RETENTION_MS) {
				if (entry.message.expectsReply) this.askEdges.delete(entry.message.id);
				this.messageReceiptRoutes.delete(entry.message.id);
				this.mailboxMessages.splice(index, 1);
			}
		}
	}
	queueMailboxMessage(from, target, message, brokerReceivedAt) {
		this.pruneMailboxMessages(brokerReceivedAt);
		while (this.mailboxMessages.length >= MAX_MAILBOX_MESSAGES) {
			const evicted = this.mailboxMessages.shift();
			if (!evicted) break;
			if (evicted.message.expectsReply) this.askEdges.delete(evicted.message.id);
			this.messageReceiptRoutes.delete(evicted.message.id);
		}
		this.mailboxMessages.push({
			from: { ...from },
			target: { ...target },
			message: {
				...message,
				brokerReceivedAt
			},
			queuedAt: brokerReceivedAt
		});
	}
	flushMailboxForSession(session, now = Date.now()) {
		this.pruneMailboxMessages(now);
		const sessionName = session.info.name?.toLowerCase();
		const uniqueMailboxIdentity = this.findLiveSessionsSharingMailboxIdentity(session.info).length === 1;
		for (let index = 0; index < this.mailboxMessages.length;) {
			const entry = this.mailboxMessages[index];
			const matchesId = entry.target.id === session.info.id;
			const matchesSenderIdentity = Boolean(sessionName && entry.from.name?.toLowerCase() === sessionName && sameCwd(entry.from.cwd, session.info.cwd));
			const matchesUniqueName = Boolean(uniqueMailboxIdentity && sessionName && !matchesSenderIdentity && entry.target.name?.toLowerCase() === sessionName && sameCwd(entry.target.cwd, session.info.cwd));
			if (!matchesId && !matchesUniqueName) {
				index += 1;
				continue;
			}
			this.mailboxMessages.splice(index, 1);
			const edge = this.askEdges.get(entry.message.id);
			if (edge?.to === entry.target.id) edge.to = session.info.id;
			const deliveredMessage = {
				...entry.message,
				brokerDeliveredAt: Date.now()
			};
			writeMessage(session.socket, {
				type: "message",
				from: entry.from,
				message: deliveredMessage
			});
			this.messageReceiptRoutes.set(entry.message.id, {
				from: entry.from.id,
				to: session.info.id,
				createdAt: entry.message.brokerReceivedAt ?? entry.queuedAt
			});
		}
	}
	pruneAskEdges(now = Date.now()) {
		for (const [messageId, edge] of this.askEdges) if (now - edge.createdAt > this.askTimeoutMs) this.askEdges.delete(messageId);
	}
	clearAskEdgesForSession(sessionId) {
		for (const [messageId, edge] of this.askEdges) if (edge.from === sessionId || edge.to === sessionId) this.askEdges.delete(messageId);
	}
	pruneMessageReceiptRoutes(now = Date.now()) {
		for (const [messageId, route] of this.messageReceiptRoutes) if (now - route.createdAt > MESSAGE_RECEIPT_ROUTE_RETENTION_MS) this.messageReceiptRoutes.delete(messageId);
	}
	clearMessageReceiptRoutesForSession(sessionId) {
		for (const [messageId, route] of this.messageReceiptRoutes) if (route.from === sessionId || route.to === sessionId) this.messageReceiptRoutes.delete(messageId);
	}
	findSessions(nameOrId) {
		const byId = this.sessions.get(nameOrId);
		if (byId) return [byId];
		const lowerName = nameOrId.toLowerCase();
		const byName = Array.from(this.sessions.values()).filter((session) => session.info.name?.toLowerCase() === lowerName);
		if (byName.length > 0) return byName;
		return Array.from(this.sessions.entries()).filter(([id]) => id.startsWith(nameOrId)).map(([, session]) => session);
	}
	findDisconnectedSessions(nameOrId) {
		this.pruneDisconnectedSessions();
		const byId = this.disconnectedSessions.get(nameOrId);
		if (byId) return [byId];
		const lowerName = nameOrId.toLowerCase();
		const byName = Array.from(this.disconnectedSessions.values()).filter((session) => session.info.name?.toLowerCase() === lowerName);
		if (byName.length > 0) return byName;
		return Array.from(this.disconnectedSessions.entries()).filter(([id]) => id.startsWith(nameOrId)).map(([, session]) => session);
	}
	findUniqueLiveSessionForDisconnectedSession(info, senderId) {
		const matches = this.findLiveSessionsSharingMailboxIdentity(info).filter((session) => session.info.id !== senderId);
		return matches.length === 1 ? matches[0] : null;
	}
	/**
	* Mailbox identity is an explicit name plus directory, never name alone. A
	* runtime fallback alias is derived from the session id rather than chosen as
	* a durable identity, so it must not transfer mail to another process. This
	* also prevents two unnamed UUIDv7 sessions started close together from
	* inheriting each other's mailbox through a shared short alias.
	*
	* Directories compare through sameCwd so a relaunch that reports the same
	* directory differently (trailing slash, "."/"..", or a symlink such as macOS
	* /tmp vs /private/tmp) still matches.
	*/
	findLiveSessionsSharingMailboxIdentity(info) {
		const lowerName = info.name?.toLowerCase();
		if (!lowerName || info.runtimeFallbackAlias) return [];
		return Array.from(this.sessions.values()).filter((session) => !session.info.runtimeFallbackAlias && session.info.name?.toLowerCase() === lowerName && sameCwd(session.info.cwd, info.cwd));
	}
	broadcast(msg, exclude) {
		for (const [id, session] of this.sessions) if (id !== exclude) writeMessage(session.socket, msg);
	}
	validateExtensionCapability(cap) {
		if (typeof cap !== "object" || cap === null) return false;
		const c = cap;
		if (typeof c.namespace !== "string" || typeof c.ownerEligible !== "boolean") return false;
		return this.validateNamespace(c.namespace);
	}
	validateNamespace(ns) {
		if (ns.length === 0 || ns.length > 64) return false;
		if (!/^[a-z0-9]/.test(ns)) return false;
		if (!/^[a-z0-9][a-z0-9._/-]*$/.test(ns)) return false;
		return true;
	}
	recomputeNamespaceOwners() {
		const namespaces = new Set(this.namespaceOwners.keys());
		for (const session of this.sessions.values()) for (const extension of session.extensions ?? []) namespaces.add(extension.namespace);
		for (const namespace of namespaces) {
			const candidates = [];
			for (const [sessionId, session] of this.sessions) if (session.extensions) {
				if (session.extensions.some((ext) => ext.namespace === namespace && ext.ownerEligible)) candidates.push({
					sessionId,
					session
				});
			}
			if (candidates.length === 0) {
				if (this.namespaceOwners.delete(namespace)) {
					for (const session of this.sessions.values()) if (session.extensions?.some((extension) => extension.namespace === namespace)) writeMessage(session.socket, {
						type: "extension_owner",
						namespace
					});
				}
				continue;
			}
			candidates.sort((a, b) => {
				if (a.session.ownerOrder !== b.session.ownerOrder) return a.session.ownerOrder - b.session.ownerOrder;
				return a.sessionId.localeCompare(b.sessionId);
			});
			const winner = candidates[0];
			const existing = this.namespaceOwners.get(namespace);
			const ownerChanged = !existing || existing.sessionId !== winner.sessionId;
			const socketChanged = existing && existing.socket !== winner.session.socket;
			if (ownerChanged || socketChanged) {
				const epoch = randomUUID();
				this.namespaceOwners.set(namespace, {
					sessionId: winner.sessionId,
					socket: winner.session.socket,
					epoch
				});
				for (const session of this.sessions.values()) if (session.extensions?.length) {
					if (session.extensions.some((ext) => ext.namespace === namespace)) writeMessage(session.socket, {
						type: "extension_owner",
						namespace,
						ownerId: winner.sessionId,
						ownerEpoch: epoch
					});
				}
			}
		}
	}
	handleExtensionPublish(socket, currentId, msg) {
		if (!currentId) throw new Error("Received extension_publish before register");
		const session = this.sessions.get(currentId);
		if (!session || session.socket !== socket) {
			writeMessage(socket, {
				type: "error",
				error: "Session not found"
			});
			return;
		}
		if (!session.extensions?.length) {
			writeMessage(socket, {
				type: "error",
				error: "Session has not advertised extension capability"
			});
			return;
		}
		const namespace = msg.namespace;
		const audience = msg.audience;
		const ownerOnly = msg.ownerOnly === true;
		const ownerEpoch = msg.ownerEpoch;
		const payload = msg.payload;
		if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
			writeMessage(socket, {
				type: "error",
				error: "Invalid namespace"
			});
			return;
		}
		if (audience !== "owner" && audience !== "capable") {
			writeMessage(socket, {
				type: "error",
				error: "Invalid audience"
			});
			return;
		}
		const payloadSize = serializedPayloadSize(payload);
		if (payloadSize === null || payloadSize > MAX_EXTENSION_MESSAGE_BYTES) {
			writeMessage(socket, {
				type: "error",
				error: "Invalid extension payload or payload exceeds 16 KiB limit"
			});
			return;
		}
		if (!session.extensions?.some((ext) => ext.namespace === namespace)) {
			writeMessage(socket, {
				type: "error",
				error: "Sender does not have capability for this namespace"
			});
			return;
		}
		const owner = this.namespaceOwners.get(namespace);
		if ((audience === "owner" || ownerOnly) && !owner) {
			writeMessage(socket, {
				type: "error",
				error: "No owner for this namespace"
			});
			return;
		}
		if (ownerOnly && owner) {
			if (typeof ownerEpoch !== "string") {
				writeMessage(socket, {
					type: "error",
					error: "ownerEpoch required for owner-only messages"
				});
				return;
			}
			if (currentId !== owner.sessionId || socket !== owner.socket || ownerEpoch !== owner.epoch) {
				writeMessage(socket, {
					type: "error",
					error: "Owner validation failed"
				});
				return;
			}
		}
		for (const [recipientId, recipientSession] of this.sessions) {
			if (!recipientSession.extensions?.length) continue;
			if (!recipientSession.extensions.some((ext) => ext.namespace === namespace)) continue;
			if (audience === "capable" || audience === "owner" && owner !== void 0 && recipientId === owner.sessionId && recipientSession.socket === owner.socket) writeMessage(recipientSession.socket, {
				type: "extension_message",
				namespace,
				fromSessionId: currentId,
				...owner ? {
					ownerId: owner.sessionId,
					ownerEpoch: owner.epoch
				} : {},
				payload
			});
		}
	}
	handleExtensionStateCommit(socket, currentId, msg) {
		if (!currentId) throw new Error("Received extension_state_commit before register");
		const session = this.sessions.get(currentId);
		if (!session || session.socket !== socket) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace: String(msg.namespace || ""),
				committed: false,
				revision: 0,
				reason: "Session not found"
			});
			return;
		}
		if (!session.extensions?.length) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace: String(msg.namespace || ""),
				committed: false,
				revision: 0,
				reason: "Session has not advertised extension capability"
			});
			return;
		}
		const namespace = msg.namespace;
		const ownerEpoch = msg.ownerEpoch;
		const expectedRevision = msg.expectedRevision;
		const payload = msg.payload;
		if (typeof namespace !== "string" || !this.validateNamespace(namespace)) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace: String(namespace),
				committed: false,
				revision: 0,
				reason: "Invalid namespace"
			});
			return;
		}
		if (typeof ownerEpoch !== "string") {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "Invalid ownerEpoch"
			});
			return;
		}
		if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "Invalid expectedRevision"
			});
			return;
		}
		const payloadSize = serializedPayloadSize(payload);
		if (payloadSize === null || payloadSize > MAX_EXTENSION_STATE_BYTES) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "Invalid extension state or payload exceeds 64 KiB limit"
			});
			return;
		}
		if (!session.extensions?.some((ext) => ext.namespace === namespace)) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "Sender does not have capability for this namespace"
			});
			return;
		}
		const owner = this.namespaceOwners.get(namespace);
		if (!owner) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "No owner for this namespace"
			});
			return;
		}
		if (currentId !== owner.sessionId || socket !== owner.socket || ownerEpoch !== owner.epoch) {
			writeMessage(socket, {
				type: "extension_state_result",
				namespace,
				committed: false,
				revision: this.extensionStateManager.getCurrentRevision(namespace),
				reason: "Owner validation failed"
			});
			return;
		}
		const result = this.extensionStateManager.commitState(namespace, expectedRevision, payload);
		writeMessage(socket, {
			type: "extension_state_result",
			namespace,
			committed: result.committed,
			revision: result.revision,
			reason: result.reason
		});
		if (result.committed) for (const recipientSession of this.sessions.values()) {
			if (!recipientSession.extensions?.length) continue;
			if (recipientSession.extensions.some((ext) => ext.namespace === namespace)) writeMessage(recipientSession.socket, {
				type: "extension_state",
				namespace,
				revision: result.revision,
				payload
			});
		}
	}
	shutdown() {
		console.log("Broker shutting down");
		for (const session of this.sessions.values()) session.socket.end();
		this.sessions.clear();
		this.askEdges.clear();
		this.messageReceiptRoutes.clear();
		this.disconnectedSessions.clear();
		this.mailboxMessages.length = 0;
		if (typeof LISTEN_TARGET === "string" && process.platform !== "win32") try {
			unlinkSync(LISTEN_TARGET);
		} catch {}
		try {
			unlinkSync(PORT_PATH);
		} catch {}
		try {
			unlinkSync(PID_PATH);
		} catch {}
		this.server.close();
		process.exit(0);
	}
};
new IntercomBroker().start();
//#endregion
export {};
