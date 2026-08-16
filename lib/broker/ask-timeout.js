//#region broker/ask-timeout.ts
const DEFAULT_ASK_TIMEOUT_MS = 6e5;
function getAskTimeoutMs() {
	const raw = process.env.DSH_INTERCOM_ASK_TIMEOUT_MS;
	if (raw === void 0 || raw.trim() === "") return DEFAULT_ASK_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("DSH_INTERCOM_ASK_TIMEOUT_MS must be a positive integer number of milliseconds");
	return value;
}
//#endregion
export { getAskTimeoutMs };
