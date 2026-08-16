import { formatSessionList, formatSessionListRow } from "./message.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/tool.ts
/** Short id prefix shown in lists; a unique leading prefix resolves as a target. */
const ID_PREFIX_LENGTH = 8;
function summarizeRow(summary, currentCwd) {
	return formatSessionListRow({
		display: summary.alias ?? "Unnamed session",
		idPrefix: summary.id.slice(0, ID_PREFIX_LENGTH),
		cwd: summary.cwd,
		model: summary.model,
		status: summary.status,
		self: summary.self,
		sameCwd: summary.cwd !== void 0 && summary.cwd === currentCwd
	});
}
function requireSelf(agent) {
	if (!agent) throw new Error("intercom: no calling agent context (the tool must run inside an agent turn).");
	return agent;
}
/** Sender display + reply address for outbound messages from `self`. */
function senderOf(deps, self) {
	const id = String(self.id);
	const alias = deps.registry.aliasOf(id);
	return {
		display: alias ?? id.slice(0, ID_PREFIX_LENGTH),
		address: alias ?? id
	};
}
function createIntercomTool(deps) {
	return defineTool({
		name: "intercom",
		description: "Exchange messages with other live dsh sessions in this process. Use to coordinate with peer sessions: list them, give the current session a name, or send a message. Address sessions by alias, full session id, or the short id prefix shown in parentheses by \"list\". The message arrives as a relay from the named sender: idle sessions start a new turn with it, busy sessions receive it as steering at the next step boundary.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"list",
					"send",
					"status",
					"name"
				],
				required: true,
				description: "'list': show live sessions. 'send': deliver a message to another session. 'name': set the current session's intercom alias. 'status': intercom plugin status."
			},
			to: {
				type: "string",
				description: "Target session for 'send': alias, full session id, or the unique id prefix shown in parentheses by 'list'."
			},
			message: {
				type: "string",
				description: "Message text for 'send'."
			},
			alias: {
				type: "string",
				description: "Alias to give the current session for 'name'. Other sessions address you by this name."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const self = requireSelf(exec.agent);
			const selfId = String(self.id);
			switch (args.action) {
				case "list": {
					const sessions = deps.registry.list(selfId);
					const current = sessions.find((session) => session.self);
					const others = sessions.filter((session) => !session.self);
					return formatSessionList(current ? summarizeRow(current, current.cwd) : void 0, others.map((session) => summarizeRow(session, current?.cwd)));
				}
				case "name": {
					const alias = args.alias?.trim();
					if (!alias) throw new Error("intercom: \"name\" requires a non-empty \"alias\" parameter.");
					deps.registry.alias(self, alias);
					return `This session is now named "${alias}" (${selfId.slice(0, ID_PREFIX_LENGTH)}). Other sessions can reach it with intercom({ action: "send", to: "${alias}", message: "..." }).`;
				}
				case "send": {
					const to = args.to?.trim();
					if (!to) throw new Error("intercom: \"send\" requires a \"to\" parameter (alias or session id).");
					const body = args.message;
					if (typeof body !== "string" || !body.trim()) throw new Error("intercom: \"send\" requires a non-empty \"message\" parameter.");
					const target = deps.registry.resolve(to);
					if (String(target.id) === selfId) throw new Error("intercom: target resolves to the current session; pick a peer from \"list\".");
					const sender = senderOf(deps, self);
					const result = await deps.transport.send(target, {
						from: {
							sessionId: selfId,
							...sender,
							cwd: self.session.header.cwd
						},
						body
					});
					const name = result.target.alias ?? result.target.id;
					const how = result.path === "followup" ? "the session was idle and starts a new turn with it" : "the session was busy and receives it as steering at its next step boundary";
					return `Delivered to ${name} (${result.target.id.slice(0, ID_PREFIX_LENGTH)}) via ${result.path}: ${how}.`;
				}
				case "status": {
					const sessions = deps.registry.list(selfId);
					return [
						"dsh-intercom: transport local (same-process delivery); cross-process broker is not enabled in this build.",
						`Live sessions in this process: ${sessions.length}.`,
						...sessions.map((session) => summarizeRow(session, sessions.find((s) => s.self)?.cwd))
					].join("\n");
				}
				default: throw new Error(`intercom: unknown action ${JSON.stringify(args.action)}. Supported actions: list, send, status, name.`);
			}
		}
	});
}
//#endregion
export { createIntercomTool };
