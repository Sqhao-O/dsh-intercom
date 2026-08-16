/**
 * Panel e2e probe plugin: mounted into a scratch WEB profile by
 * tests/e2e/panel.ts (via the profile's user patch layer — `dsh web` accepts
 * no --patch flag). Creates two agents (planner/worker), names them through
 * the intercom tool so they register with the broker, then waits for the
 * panel-driven relay (POST /intercom/send from the driver) to land in the
 * worker's session log. Prints markers the driver waits on; stays alive until
 * killed. Plain .mjs: the dsh Loader imports this file URL directly.
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-intercom-panel-probe";
export const inject = ["agents", "agentDefaultModel", "tools"];

const tag = "[panel-probe]";
const RELAY_BODY = "panel-send-check";
const out = (line) => process.stdout.write(`${tag} ${line}\n`);

const exec = (agent) => ({
  callId: `panel-${Math.random().toString(36).slice(2)}`,
  name: "intercom",
  arguments: {},
  agent,
  signal: new AbortController().signal,
});

async function createAgent(ctx, selection, id) {
  const created = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined,
      });
    },
  });
  return created.agent;
}

async function run(ctx) {
  await ctx.get("loader")?.await();
  const tool = ctx.tools.get("intercom");
  if (!tool) throw new Error("intercom tool is not registered");

  const selection = ctx.agentDefaultModel.currentSelection();
  const planner = await createAgent(ctx, selection, "panel-planner");
  const worker = await createAgent(ctx, selection, "panel-worker");
  for (const [agent, alias] of [
    [planner, "planner"],
    [worker, "worker"],
  ]) {
    const named = await tool.execute({ action: "name", alias }, exec(agent));
    if (typeof named !== "string" || !named.includes(`"${alias}"`)) {
      throw new Error(`name action failed for ${alias}: ${named}`);
    }
  }
  out(`ready: planner=${planner.id} worker=${worker.id}`);

  // The driver sends from the planner via POST /intercom/send; the relay must
  // reach the worker's durable log with its intercom source.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const relay = worker.session.events.find(
      (event) =>
        event.type === "user/message" &&
        event.data.source?.kind === "intercom" &&
        JSON.stringify(event.data.content).includes(RELAY_BODY),
    );
    if (relay) {
      out("relay delivered to the worker session log");
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the panel relay");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function apply(ctx) {
  const timer = setTimeout(() => {
    out("FAIL timeout waiting for the scenario");
    process.exit(2);
  }, 90_000);
  void run(ctx)
    .then(() => {
      out("PASS");
      clearTimeout(timer);
    })
    .catch((error) => {
      out(
        `FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      clearTimeout(timer);
      process.exit(1);
    });
}
