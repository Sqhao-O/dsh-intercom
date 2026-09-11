/**
 * Real-environment acceptance probe plugin: mounted into the REAL web profile
 * by tests/accept/local-env.mjs, which appends one row to the profile's
 * cordis.patch.yml for the duration of the run and restores it byte-identical
 * afterwards (`dsh web` accepts no --patch flag). Creates two agents with
 * unique per-run session ids (accept-planner-<ts> / accept-worker-<ts>, from
 * the driver env), names them through the intercom tool so they register with
 * the real broker under the real ~/.dsh/intercom, then walks the scenario:
 *   1. the intercom tool is registered and the bundled dsh-intercom skill is
 *      listed by the profile's skill registry,
 *   2. planner's intercom({action:"list"}) shows the worker (broker roster),
 *   3. the driver-driven POST /intercom/send relay lands in the worker's
 *      durable session log with source kind "intercom" and the worker wakes
 *      (assistant/message after the relay),
 *   4. a worker→planner ask through the tool genuinely blocks across the
 *      broker until the planner's reply action unblocks it with the reply
 *      text.
 * Prints markers the driver waits on; stays alive until killed. Plain .mjs:
 * the dsh Loader imports this file URL directly.
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-intercom-accept-probe";
export const inject = ["agents", "agentDefaultModel", "tools"];

const tag = "[accept-probe]";
const PLANNER_ID = process.env.ACCEPT_PLANNER_ID;
const WORKER_ID = process.env.ACCEPT_WORKER_ID;
const RELAY_BODY = process.env.ACCEPT_RELAY_BODY;
const ASK_BODY = process.env.ACCEPT_ASK_BODY;
const REPLY_BODY = process.env.ACCEPT_REPLY_BODY;
const out = (line) => process.stdout.write(`${tag} ${line}\n`);

const exec = (agent) => ({
  callId: `accept-${Math.random().toString(36).slice(2)}`,
  name: "intercom",
  arguments: {},
  agent,
  signal: new AbortController().signal,
});

async function poll(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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

const isIntercomRelay = (event, body) =>
  event.type === "user/message" &&
  event.data.source?.kind === "intercom" &&
  JSON.stringify(event.data.content).includes(body);

async function run(ctx) {
  await ctx.get("loader")?.await();

  // Assertion 1: the intercom tool is registered and the bundled
  // dsh-intercom skill is visible in the profile's skill registry.
  const tool = ctx.tools.get("intercom");
  if (!tool) throw new Error("intercom tool is not registered");
  const skills = (await ctx.get("skills")?.list?.()) ?? [];
  if (!skills.some((skill) => skill.name === "dsh-intercom")) {
    throw new Error(
      `dsh-intercom skill not listed: ${JSON.stringify(skills.map((skill) => skill.name))}`,
    );
  }
  out("assert1 ok: intercom tool registered + dsh-intercom skill listed");

  const selection = ctx.agentDefaultModel.currentSelection();
  const planner = await createAgent(ctx, selection, PLANNER_ID);
  const worker = await createAgent(ctx, selection, WORKER_ID);
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

  // Assertion 2 (probe half): the worker is visible in the broker roster
  // from the planner's own tool call.
  const listed = await tool.execute({ action: "list" }, exec(planner));
  if (typeof listed !== "string" || !listed.includes("worker (")) {
    throw new Error(`planner list does not show the worker: ${listed}`);
  }
  out("assert2 ok: planner list shows the worker through the broker");

  // Assertion 3 (probe half): the panel-driven send lands in the worker's
  // durable log with its intercom source and wakes a real turn.
  const relay = await poll("panel relay in worker log", () =>
    worker.session.events.find((event) => isIntercomRelay(event, RELAY_BODY)),
  );
  await poll("worker wake after the relay", () =>
    worker.session.events.find(
      (event) => event.type === "assistant/message" && event.seq > relay.seq,
    ),
  );
  out("assert3 ok: panel relay delivered and the worker woke");

  // Assertion 4: the worker's ask blocks on the real broker until the
  // planner's reply action unblocks it with the reply text.
  const askPromise = tool.execute(
    { action: "ask", to: "planner", message: ASK_BODY },
    exec(worker),
  );
  askPromise.catch(() => undefined);
  await poll("inbound ask in planner log", () =>
    planner.session.events.find((event) => isIntercomRelay(event, ASK_BODY)),
  );
  const replyOut = await tool.execute(
    { action: "reply", message: REPLY_BODY },
    exec(planner),
  );
  if (replyOut !== "Reply sent to worker") {
    throw new Error(`reply action failed: ${replyOut}`);
  }
  const askResult = await askPromise;
  if (typeof askResult !== "string" || !askResult.includes(REPLY_BODY)) {
    throw new Error(`ask did not unblock with the reply: ${askResult}`);
  }
  out("assert4 ok: ask blocked across the broker and unblocked with the reply");

  out("PASS");
}

export function apply(ctx) {
  const timer = setTimeout(() => {
    out("FAIL timeout waiting for the scenario");
    process.exit(2);
  }, 180_000);
  void run(ctx)
    .then(() => clearTimeout(timer))
    .catch((error) => {
      out(
        `FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      clearTimeout(timer);
      process.exit(1);
    });
}
