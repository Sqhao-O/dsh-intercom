import { INTERCOM_SOURCE_KIND } from "../source.js";
import { formatIntercomMessage } from "../message.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/transport/local.ts
/** Summarize the delivery target for the tool result. */
function targetSummary(target, alias) {
	const provider = target.options.provider;
	const model = target.options.model;
	return {
		id: String(target.id),
		alias,
		cwd: target.session.header.cwd,
		model: provider && model ? `${provider}/${model}` : model ?? provider,
		status: target.status,
		self: false
	};
}
var LocalTransport = class {
	aliasOf;
	constructor(aliasOf) {
		this.aliasOf = aliasOf;
	}
	async send(target, message) {
		const text = formatIntercomMessage({
			display: message.from.display,
			address: message.from.address,
			cwd: message.from.cwd
		}, message.body);
		const injected = createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: INTERCOM_SOURCE_KIND,
				form: "relay",
				senderSessionId: message.from.sessionId
			}
		});
		if (target.status === "idle") {
			target.followup(injected);
			return {
				path: "followup",
				target: targetSummary(target, this.aliasOf(String(target.id)))
			};
		}
		target.steer(injected);
		return {
			path: "steer",
			target: targetSummary(target, this.aliasOf(String(target.id)))
		};
	}
};
//#endregion
export { LocalTransport };
