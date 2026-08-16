import { SessionRegistry } from "./registry.js";
import { createIntercomTool } from "./tool.js";
import { LocalTransport } from "./transport/local.js";
//#region src/index.ts
const name = "dsh-intercom";
/** Core services required before the tool can resolve and reach peers. */
const inject = ["agents", "tools"];
function apply(ctx) {
	const sessionTitle = ctx.get("sessionTitle");
	const registry = new SessionRegistry({ sessionTitle });
	const transport = new LocalTransport((sessionId) => registry.aliasOf(sessionId));
	for (const agent of ctx.agents.list()) registry.add(agent);
	ctx.on("agent/created", ({ agent }) => registry.add(agent), { global: true });
	ctx.on("agent/disposed", ({ agent }) => registry.remove(agent), { global: true });
	ctx.tools.register(createIntercomTool({
		registry,
		transport
	}));
}
//#endregion
export { apply, inject, name };
