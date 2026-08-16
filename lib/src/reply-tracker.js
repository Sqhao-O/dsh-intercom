import { getAskTimeoutMs } from "../broker/ask-timeout.js";
//#region src/reply-tracker.ts
/**
* Tracks inbound asks awaiting a reply and the intercom context of the current
* turn, so the `reply` action can resolve "the ask I was just woken with".
*
* Ported from pi-intercom's `reply-tracker.ts` (see NOTICE). Adjustments:
* imports point at the vendored `broker/ask-timeout.ts` / `types.ts`, and
* `activateTurnContext` is a dsh addition — pi learns turn boundaries from
* `turn_start`/`turn_end`; dsh's `agent/inbox/claimed` event identifies the
* exact relayed message the driver claimed, so the tracker adopts it directly
* instead of shifting a queued context.
*/
function matchesPendingSender(context, to) {
	if (context.from.id === to || context.from.id.startsWith(to)) return true;
	return context.from.name?.toLowerCase() === to.toLowerCase();
}
function resolvePendingSender(pending, to) {
	const exactIdMatches = pending.filter((context) => context.from.id === to);
	if (exactIdMatches.length === 1) return exactIdMatches[0];
	if (exactIdMatches.length > 1) throw new Error(`Multiple pending asks from session ID "${to}" — specify \`replyTo\``);
	const lowerTo = to.toLowerCase();
	const exactNameMatches = pending.filter((context) => context.from.name?.toLowerCase() === lowerTo);
	if (exactNameMatches.length === 1) return exactNameMatches[0];
	if (exactNameMatches.length > 1) throw new Error(`Multiple pending asks match sender name "${to}" — specify a full session ID or \`replyTo\``);
	const idPrefixMatches = pending.filter((context) => context.from.id.startsWith(to));
	if (idPrefixMatches.length === 1) return idPrefixMatches[0];
	if (idPrefixMatches.length > 1) throw new Error(`Multiple pending asks match ID prefix "${to}" — use a longer session ID prefix or specify \`replyTo\``);
	throw new Error(`No pending ask from "${to}"`);
}
var ReplyTracker = class {
	askTimeoutMs;
	pendingAsks = /* @__PURE__ */ new Map();
	pendingTurnContexts = [];
	currentTurnContext = null;
	constructor(askTimeoutMs = getAskTimeoutMs()) {
		this.askTimeoutMs = askTimeoutMs;
	}
	recordIncomingMessage(from, message, receivedAt = Date.now()) {
		const context = {
			from,
			message,
			receivedAt
		};
		if (message.expectsReply) this.pendingAsks.set(message.id, context);
		return context;
	}
	queueTurnContext(context) {
		this.pendingTurnContexts.push(context);
	}
	beginTurn(now = Date.now()) {
		this.pruneExpired(now);
		this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
	}
	endTurn() {
		this.currentTurnContext = null;
	}
	/**
	* dsh addition: the driver claimed an injected relay (observed via
	* `agent/inbox/claimed`), making its ask the current turn context.
	*/
	activateTurnContext(messageId, now = Date.now()) {
		this.pruneExpired(now);
		const context = this.pendingAsks.get(messageId);
		if (context) this.currentTurnContext = context;
	}
	reset() {
		this.pendingAsks.clear();
		this.pendingTurnContexts.length = 0;
		this.currentTurnContext = null;
	}
	resolveReplyTarget(options, now = Date.now()) {
		this.pruneExpired(now);
		if (options.replyTo) {
			const target = this.pendingAsks.get(options.replyTo);
			if (!target) throw new Error(`No pending ask with message ID "${options.replyTo}"`);
			if (options.to && !matchesPendingSender(target, options.to)) throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
			return target;
		}
		const pending = Array.from(this.pendingAsks.values());
		if (options.to) return resolvePendingSender(pending, options.to);
		if (this.currentTurnContext) return this.currentTurnContext;
		if (pending.length === 1) return pending[0];
		if (pending.length === 0) throw new Error("No active intercom context to reply to");
		throw new Error("Multiple pending asks — list them with intercom({ action: \"pending\" }) and specify `to`");
	}
	findUniquePendingAskFrom(to, now = Date.now()) {
		const candidates = Array.from(this.pendingAsks.values()).filter((context) => {
			if (now - context.receivedAt > this.askTimeoutMs) return false;
			return context.from.id === to || context.from.name?.toLowerCase() === to.toLowerCase();
		});
		return candidates.length === 1 ? candidates[0] : null;
	}
	markReplied(replyTo) {
		this.dismissPendingAsk(replyTo);
	}
	dismissPendingAsk(replyTo) {
		this.pendingAsks.delete(replyTo);
		for (let index = this.pendingTurnContexts.length - 1; index >= 0; index -= 1) if (this.pendingTurnContexts[index]?.message.id === replyTo) this.pendingTurnContexts.splice(index, 1);
		if (this.currentTurnContext?.message.id === replyTo) this.currentTurnContext = null;
	}
	listPending(now = Date.now()) {
		this.pruneExpired(now);
		return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
	}
	pruneExpired(now) {
		for (const [messageId, context] of this.pendingAsks) if (now - context.receivedAt > this.askTimeoutMs) this.dismissPendingAsk(messageId);
	}
};
//#endregion
export { ReplyTracker };
