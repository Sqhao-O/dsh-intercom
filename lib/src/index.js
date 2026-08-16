import { loadConfig } from "./config.js";
import { registerPanelRoutes } from "./panel.js";
import { SessionRegistry } from "./registry.js";
import { registerBundledSkill } from "./skill.js";
import { createIntercomTool } from "./tool.js";
import { BrokerTransport } from "./transport/broker.js";
import { LocalTransport } from "./transport/local.js";
//#region src/index.ts
const name = "dsh-intercom";
/** Core services required before the tool can resolve and reach peers. */
const inject = ["agents", "tools"];
function apply(ctx) {
	const config = loadConfig((message) => ctx.logger.warn(message));
	const sessionTitle = ctx.get("sessionTitle");
	const registry = new SessionRegistry({ sessionTitle });
	const local = new LocalTransport((sessionId) => registry.aliasOf(sessionId));
	const broker = new BrokerTransport({
		config,
		aliasOf: (sessionId) => registry.aliasOf(sessionId),
		log: (message) => ctx.logger.warn(message)
	});
	for (const agent of ctx.agents.list()) {
		registry.add(agent);
		broker.attach(agent);
	}
	ctx.on("agent/created", ({ agent }) => {
		registry.add(agent);
		broker.attach(agent);
	}, { global: true });
	ctx.on("agent/disposed", ({ agent }) => {
		registry.remove(agent);
		broker.detach(agent);
	}, { global: true });
	ctx.on("agent/status", ({ agent, status }) => broker.publishStatus(agent, status), { global: true });
	ctx.on("session/event", (session, event) => broker.noteSessionEvent(session, event), { global: true });
	ctx.effect(() => () => {
		broker.dispose();
	}, "dsh-intercom broker transport");
	ctx.tools.register(createIntercomTool({
		registry,
		local,
		broker,
		config
	}));
	registerBundledSkill(ctx);
	registerPanelRoutes(ctx, {
		registry,
		broker,
		config
	});
}
//#endregion
export { apply, inject, name };
