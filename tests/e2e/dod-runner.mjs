/**
 * DoD e2e runner plugin (M4 final acceptance). Mounted into a scratch headless
 * profile via `dsh --profile headless --patch <generated>` by dod-install.ts —
 * alongside the GITHUB-INSTALLED dsh-intercom package (not the repo's lib/).
 *
 * Roles (E2E_ROLE):
 *   - planner: names itself, waits until "worker" is visible in the broker
 *     roster, runs a scripted turn whose mock LLM emits
 *     intercom({action:"send", to:"worker", message:"dod-check"}), receives
 *     the worker's ask as a relay, and answers it through the tool's reply
 *     action.
 *   - worker: names itself, gets woken by the planner's relayed send (the
 *     relay must appear in its durable log AND produce a new turn), and its
 *     scripted wake-turn calls intercom({action:"ask", to:"planner"}) which
 *     blocks until the planner's reply arrives.
 *
 * Plain .mjs: the dsh Loader imports this file URL directly (no build step).
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-intercom-dod-runner";
export const inject = ["agents", "agentDefaultModel", "tools"];

const ROLE = process.env.E2E_ROLE ?? "planner";
const SESSION_ID = `dod-${ROLE}`;
const ALIAS = ROLE;
const PEER_ALIAS = ROLE === "planner" ? "worker" : "planner";
const SEND_BODY = "dod-check";
const ASK_BODY = "dod-question";
const REPLY_BODY = "dod-reply";
const TIMEOUT_MS = 100_000;
const tag = `[dod:${ROLE}]`;

function exit(ctx, code) {
  const appExit = ctx.get("appExit");
  if (typeof appExit === "function") appExit(code);
  else process.exit(code);
}

const out = (line) => process.stdout.write(`${tag} ${line}\n`);

const exec = (agent) => ({
  callId: `dod-${Math.random().toString(36).slice(2)}`,
  name: "intercom",
  arguments: {},
  agent,
  signal: new AbortController().signal,
});

async function poll(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(ctx) {
  const fail = (line) => {
    out(`FAIL ${line}`);
    exit(ctx, 1);
  };

  // Sibling plugins mount concurrently; wait for the whole tree (the
  // github-installed dsh-intercom among them) before touching the registry.
  await ctx.get("loader")?.await();

  const tool = ctx.tools.get("intercom");
  if (!tool) {
    fail("intercom tool is not registered");
    return;
  }

  const selection = ctx.agentDefaultModel.currentSelection();
  const created = await ctx.agents.create({
    sessionId: SessionId(SESSION_ID),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined,
      });
    },
  });
  const agent = created.agent;
  out(`agent created: ${SESSION_ID}`);

  const named = await tool.execute(
    { action: "name", alias: ALIAS },
    exec(agent),
  );
  if (typeof named !== "string" || !named.includes(`"${ALIAS}"`)) {
    return fail(`name action failed: ${named}`);
  }
  out(`alias set: ${ALIAS}`);

  // The peer is visible in the broker roster across processes.
  await poll(`peer ${PEER_ALIAS} in roster`, async () => {
    const listed = await tool.execute({ action: "list" }, exec(agent));
    return typeof listed === "string" && listed.includes(PEER_ALIAS);
  });
  out(`peer visible via cross-process list`);

  if (ROLE === "planner") {
    return runPlanner(ctx, tool, agent, fail);
  }
  return runWorker(ctx, tool, agent, fail);
}

async function runPlanner(ctx, tool, agent, fail) {
  // Scripted turn → intercom send to the worker (real tool pipeline:
  // model tool call → dispatch → broker → peer process).
  agent.followup(
    createUserMessage({
      content: [
        { type: "text", text: "Send a greeting to the worker session." },
      ],
      source: { kind: "user" },
    }),
  );
  await agent.whenIdle();
  const sendResult = agent.session.events.find(
    (event) =>
      event.type === "tool/result" &&
      !event.data.error &&
      JSON.stringify(event.data.message).includes("Message sent to worker"),
  );
  if (!sendResult)
    return fail("planner log has no successful send tool result");
  out("send crossed processes through the broker");

  // The worker's ask arrives as a relay; answer via the reply action.
  await poll("inbound ask relay in planner log", () =>
    agent.session.events.find(
      (event) =>
        event.type === "user/message" &&
        event.data.source?.kind === "intercom" &&
        JSON.stringify(event.data.content).includes(ASK_BODY),
    ),
  );
  await agent.whenIdle();
  const replyOut = await tool.execute(
    { action: "reply", message: REPLY_BODY },
    exec(agent),
  );
  if (replyOut !== "Reply sent to worker") {
    return fail(`reply action failed: ${replyOut}`);
  }
  out("answered the worker's ask via the reply action");

  out("PASS");
  exit(ctx, 0);
}

async function runWorker(ctx, tool, agent, fail) {
  // The planner's relayed send wakes this idle agent; the scripted mock wake
  // turn answers with a blocking intercom ask.
  const relay = await poll("planner relay in worker log", () =>
    agent.session.events.find(
      (event) =>
        event.type === "user/message" &&
        event.data.source?.kind === "intercom" &&
        JSON.stringify(event.data.content).includes(SEND_BODY),
    ),
  );
  out("relay arrived from the planner process");

  await agent.whenIdle();
  const woke = agent.session.events.find(
    (event) => event.type === "assistant/message" && event.seq > relay.seq,
  );
  if (!woke) return fail("worker never produced a turn after the relay");
  out("worker woke on the relay");

  const askResult = agent.session.events.find(
    (event) =>
      event.type === "tool/result" &&
      !event.data.error &&
      JSON.stringify(event.data.message).includes(REPLY_BODY),
  );
  if (!askResult) {
    return fail("worker log has no ask tool result carrying the planner reply");
  }
  out("ask blocked across processes and unblocked with the reply");

  out("PASS");
  exit(ctx, 0);
}

export function apply(ctx) {
  ctx.on(
    "agent/error",
    (payload) => {
      const error = payload?.error ?? payload;
      out(
        `debug agent/error: ${error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(payload)}`,
      );
    },
    { global: true },
  );
  const timer = setTimeout(() => {
    process.stdout.write(`${tag} FAIL timeout waiting for the scenario\n`);
    exit(ctx, 2);
  }, TIMEOUT_MS);
  void run(ctx)
    .then(() => clearTimeout(timer))
    .catch((error) => {
      process.stdout.write(
        `${tag} FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      exit(ctx, 1);
    });
}
