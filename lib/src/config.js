import { getIntercomDirPath } from "../broker/paths.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
//#region src/config.ts
/**
* Plugin configuration: `$DSH_HOME/intercom/config.json`.
*
* Ported from pi-intercom's `config.ts` (see NOTICE), with two deliberate
* semantic changes:
*
* - A malformed config file **fails closed** (`inboundTrigger: "never"`,
*   otherwise defaults) and reports through `log` instead of throwing — a
*   broken JSON file must not take the plugin (or dsh startup) down, but it
*   also must not silently trigger model turns the user never opted into.
* - `confirmSend` is accepted for config compatibility but is a **documented
*   no-op**: dsh's host-level tool-approval flow is the equivalent gate, so
*   the plugin never opens its own confirmation dialog.
*/
function getConfigPath(intercomDir = getIntercomDirPath()) {
	return join(intercomDir, "config.json");
}
const defaults = {
	enabled: true,
	inboundTrigger: "always",
	replyHint: true,
	confirmSend: false
};
/** Fail-closed copy of the defaults: malformed config must never auto-trigger turns. */
const failClosed = {
	...defaults,
	inboundTrigger: "never"
};
/**
* Load the plugin config. Missing file → defaults. Malformed JSON or invalid
* values → fail-closed defaults with `inboundTrigger: "never"`, reported via
* `log` (never throws).
*/
function loadConfig(log) {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return { ...defaults };
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Config must be a JSON object");
		const parsedConfig = parsed;
		const config = { ...defaults };
		if (Object.hasOwn(parsedConfig, "enabled")) {
			if (typeof parsedConfig.enabled !== "boolean") throw new Error(`"enabled" must be a boolean`);
			config.enabled = parsedConfig.enabled;
		}
		if (Object.hasOwn(parsedConfig, "inboundTrigger")) {
			if (parsedConfig.inboundTrigger !== "always" && parsedConfig.inboundTrigger !== "replies" && parsedConfig.inboundTrigger !== "never") throw new Error(`"inboundTrigger" must be "always", "replies", or "never"`);
			config.inboundTrigger = parsedConfig.inboundTrigger;
		}
		if (Object.hasOwn(parsedConfig, "replyHint")) {
			if (typeof parsedConfig.replyHint !== "boolean") throw new Error(`"replyHint" must be a boolean`);
			config.replyHint = parsedConfig.replyHint;
		}
		if (Object.hasOwn(parsedConfig, "status")) {
			if (typeof parsedConfig.status !== "string") throw new Error(`"status" must be a string`);
			config.status = parsedConfig.status;
		}
		if (Object.hasOwn(parsedConfig, "confirmSend")) {
			if (typeof parsedConfig.confirmSend !== "boolean") throw new Error(`"confirmSend" must be a boolean`);
			config.confirmSend = parsedConfig.confirmSend;
		}
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log?.(`dsh-intercom: failed to load config at ${configPath}: ${message}. Failing closed with inboundTrigger: "never".`);
		return { ...failClosed };
	}
}
//#endregion
export { getConfigPath, loadConfig };
