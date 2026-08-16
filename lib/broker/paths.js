import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
//#region broker/paths.ts
const INTERCOM_DIR_MODE = 448;
const INTERCOM_RUNTIME_FILE_MODE = 384;
const INTERCOM_TCP_HOST = "127.0.0.1";
const INTERCOM_PROTOCOL_NAME = "dsh-intercom";
const INTERCOM_PROTOCOL_VERSION = 1;
function sanitizePipeSegment(value) {
	return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}
function getAgentDirPath(env = process.env, homeDir = homedir(), cwd = process.cwd()) {
	const configured = env.DSH_HOME?.trim();
	if (!configured) return join(homeDir, ".dsh");
	return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
function getIntercomDirPath(agentDir = getAgentDirPath()) {
	return join(agentDir, "intercom");
}
function shouldUseWindowsTcpTransport(platform = process.platform, env = process.env) {
	if (platform !== "win32") return false;
	if (env.DSH_INTERCOM_TRANSPORT?.trim().toLowerCase() === "tcp") return true;
	const legacyOptIn = env.DSH_INTERCOM_TCP?.trim().toLowerCase();
	return legacyOptIn === "1" || legacyOptIn === "true";
}
function getBrokerPortFilePath(intercomDir = getIntercomDirPath()) {
	return join(intercomDir, "broker.port.json");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
	if (platform === "win32") return `\\\\.\\pipe\\dsh-intercom-${sanitizePipeSegment(agentDir)}`;
	return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerConnectTarget(platform = process.platform, env = process.env, intercomDir = getIntercomDirPath(getAgentDirPath(env))) {
	if (shouldUseWindowsTcpTransport(platform, env)) {
		const endpointFile = getBrokerPortFilePath(intercomDir);
		const raw = readFileSync(endpointFile, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
		const endpoint = parsed;
		if (endpoint.transport !== "tcp" || endpoint.host !== "127.0.0.1" || typeof endpoint.port !== "number" || !Number.isSafeInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535 || typeof endpoint.stateId !== "string" || endpoint.stateId.length === 0) throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
		return {
			transport: "tcp",
			host: endpoint.host,
			port: endpoint.port,
			stateId: endpoint.stateId
		};
	}
	return getBrokerSocketPath(platform, getAgentDirPath(env));
}
function getBrokerListenTarget(platform = process.platform, env = process.env) {
	if (shouldUseWindowsTcpTransport(platform, env)) return {
		transport: "tcp",
		host: INTERCOM_TCP_HOST,
		port: 0
	};
	return getBrokerSocketPath(platform, getAgentDirPath(env));
}
function ensureIntercomRuntimeDir(intercomDir = getIntercomDirPath(), platform = process.platform) {
	mkdirSync(intercomDir, {
		recursive: true,
		mode: 448
	});
	if (platform !== "win32") chmodSync(intercomDir, 448);
}
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
	if (platform !== "win32") chmodSync(filePath, 384);
}
//#endregion
export { INTERCOM_DIR_MODE, INTERCOM_PROTOCOL_NAME, INTERCOM_PROTOCOL_VERSION, INTERCOM_RUNTIME_FILE_MODE, INTERCOM_TCP_HOST, ensureIntercomRuntimeDir, getAgentDirPath, getBrokerConnectTarget, getBrokerListenTarget, getBrokerPortFilePath, getBrokerSocketPath, getIntercomDirPath, restrictIntercomRuntimeFile, shouldUseWindowsTcpTransport };
