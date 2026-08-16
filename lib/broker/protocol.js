//#region broker/protocol.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMessageReceiptStatus(value) {
	return value === "receiver_received" || value === "queued" || value === "injected" || value === "acknowledged" || value === "expired" || value === "cancelled" || value === "superseded" || value === "cancellation_requested";
}
function isMessageReceipt(value) {
	if (!isRecord(value)) return false;
	if (typeof value.messageId !== "string" || !isMessageReceiptStatus(value.status) || typeof value.timestamp !== "number") return false;
	return value.detail === void 0 || typeof value.detail === "string";
}
function isMessageControl(value) {
	if (!isRecord(value)) return false;
	if (typeof value.messageId !== "string" || typeof value.timestamp !== "number") return false;
	if (value.action !== "cancel" && value.action !== "supersede") return false;
	if (value.supersededBy !== void 0 && typeof value.supersededBy !== "string") return false;
	return value.detail === void 0 || typeof value.detail === "string";
}
function isAttachment(value) {
	if (!isRecord(value)) return false;
	if (value.type !== "file" && value.type !== "snippet" && value.type !== "context") return false;
	if (typeof value.name !== "string" || typeof value.content !== "string") return false;
	return value.language === void 0 || typeof value.language === "string";
}
function isMessage(value) {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.timestamp !== "number") return false;
	for (const key of [
		"senderSequence",
		"brokerReceivedAt",
		"brokerDeliveredAt",
		"receiverReceivedAt",
		"injectedAt"
	]) if (value[key] !== void 0 && typeof value[key] !== "number") return false;
	if (value.supersedes !== void 0 && typeof value.supersedes !== "string") return false;
	if (value.retryOf !== void 0 && typeof value.retryOf !== "string") return false;
	if (value.replyTo !== void 0 && typeof value.replyTo !== "string") return false;
	if (value.expectsReply !== void 0 && typeof value.expectsReply !== "boolean") return false;
	if (!isRecord(value.content) || typeof value.content.text !== "string") return false;
	return value.content.attachments === void 0 || Array.isArray(value.content.attachments) && value.content.attachments.every(isAttachment);
}
function isSessionInfo(value) {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || typeof value.cwd !== "string" || typeof value.model !== "string" || typeof value.pid !== "number" || typeof value.startedAt !== "number" || typeof value.lastActivity !== "number") return false;
	if (value.name !== void 0 && typeof value.name !== "string") return false;
	if (value.runtimeFallbackAlias !== void 0 && typeof value.runtimeFallbackAlias !== "boolean") return false;
	if (value.status !== void 0 && typeof value.status !== "string") return false;
	if (value.peerUid !== void 0 && typeof value.peerUid !== "number") return false;
	for (const key of [
		"contextPct",
		"contextTokens",
		"contextWindow"
	]) if (value[key] !== void 0 && typeof value[key] !== "number") return false;
	if (value.tmuxPane !== void 0 && typeof value.tmuxPane !== "string") return false;
	return value.trustedLocal === void 0 || typeof value.trustedLocal === "boolean";
}
function isSessionId(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isSessionRegistration(value) {
	if (!isRecord(value)) return false;
	if (typeof value.cwd !== "string" || typeof value.model !== "string" || typeof value.pid !== "number" || typeof value.startedAt !== "number" || typeof value.lastActivity !== "number") return false;
	if (value.name !== void 0 && typeof value.name !== "string") return false;
	if (value.runtimeFallbackAlias !== void 0 && typeof value.runtimeFallbackAlias !== "boolean") return false;
	if (value.extensions !== void 0 && !Array.isArray(value.extensions)) return false;
	if (value.tmuxPane !== void 0 && typeof value.tmuxPane !== "string") return false;
	return value.status === void 0 || typeof value.status === "string";
}
//#endregion
export { isMessage, isMessageControl, isMessageReceipt, isSessionId, isSessionInfo, isSessionRegistration };
