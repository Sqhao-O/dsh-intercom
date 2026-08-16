/**
 * dsh-intercom e2e runner plugin (M2: cross-process). Mounted into a scratch
 * headless profile via `dsh --profile headless --patch <generated>`; see
 * run.ts, which spawns TWO separate dsh processes sharing one scratch
 * DSH_HOME (so both discover the same auto-spawned socket broker) plus a
 * relaunch of the worker process for the mailbox phase.
 *
 * Roles (E2E_ROLE) and phases (E2E_PHASE):
 *   - planner (proc A, phase main): names itself, waits until "worker" is
 *     visible via `list` (broker roster across processes), runs a scripted
 *     turn whose mock LLM emits intercom({action:"send", to:"worker"}),
 *     receives the worker's ask, answers it by driving the tool's `reply`
 *     action directly, then — once the worker process has died — verifies a
 *     blocking `ask` fails immediately and a `send` queues in the mailbox.
 *     Finally it waits for the relaunched worker to reappear (keeping one
 *     live session so the broker does not idle-exit and lose the mailbox).
 *   - worker (proc B, phase main): names itself, waits for "planner", gets
 *     woken by the relayed send, and its scripted mock turn calls
 *     intercom({action:"ask", to:"planner"}) which genuinely blocks until the
 *     planner's reply unblocks it.
 *   - worker (proc B2, phase reconnect): same session id, alias and cwd; the
 *     broker flushes the queued mailbox message on registration.
 *
 * Plain .mjs: the dsh Loader imports this file URL directly (no build step).
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-intercom-e2e-runner";
export const inject = ["agents", "agentDefaultModel", "tools"];

const ROLE = process.env.E2E_ROLE ?? "planner";
const PHASE = process.env.E2E_PHASE ?? "main";
const SESSION_ID = `e2e-${ROLE}`;
const ALIAS = ROLE;
const PEER_ALIAS = ROLE === "planner" ? "worker" : "planner";
const SEND_BODY = "hello from planner";
const ASK_BODY = "what is the status?";
const REPLY_BODY = "planner reply: all good";
const QUEUED_BODY = "queued after disconnect";
const TIMEOUT_MS = 100_000;
const tag = `[e2e:${ROLE}${PHASE === "reconnect" ? ":reconnect" : ""}]`;

function exit(ctx, code) {
  const appExit = ctx.get("appExit");
  if (typeof appExit === "function") appExit(code);
  else process.exit(code);
}

const out = (line) => process.stdout.write(`${tag} ${line}\n`);

const exec = (agent) => ({
  callId: `e2e-${Math.random().toString(36).slice(2)}`,
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

  // Sibling plugins mount concurrently; wait for the whole tree (dsh-intercom
  // among them) before touching the tool registry.
  await ctx.get("loader")?.await();

  const tool = ctx.tools.get("intercom");
  if (!tool) {
    fail("intercom tool is not registered");
    return;
  }

  const selection = ctx.agentDefaultModel.currentSelection();
  const cwd = process.cwd();
  const agentOptions = { provider: selection.provider, model: selection.model };
  const setup = (agentCtx) => {
    installModelSelection(agentCtx, {
      current: selection,
      assembled: undefined,
    });
  };
  // The reconnect phase relaunches the worker against the same DSH_HOME where
  // its first incarnation's session log persists: creating a fresh agent with
  // the same session id is rejected (id collision), so resume it instead —
  // this mirrors a real dsh restart in the same directory, and the broker
  // mailbox matches the resumed registration by session id.
  const created =
    PHASE === "reconnect"
      ? await ctx.agents.resume({
          resumeSessionId: SessionId(SESSION_ID),
          agentOptions,
          setup,
        })
      : await ctx.agents.create({
          sessionId: SessionId(SESSION_ID),
          meta: { cwd },
          agentOptions,
          setup,
        });
  const agent = created.agent;
  out(`agent ${PHASE === "reconnect" ? "resumed" : "created"}: ${SESSION_ID}`);

  const named = await tool.execute(
    { action: "name", alias: ALIAS },
    exec(agent),
  );
  if (typeof named !== "string" || !named.includes(`"${ALIAS}"`)) {
    return fail(`name action failed: ${named}`);
  }
  out(`alias set: ${ALIAS}`);

  // Scenario 1: the peer is visible in the broker roster across processes.
  await poll(`peer ${PEER_ALIAS} in roster`, async () => {
    const listed = await tool.execute({ action: "list" }, exec(agent));
    return typeof listed === "string" && listed.includes(PEER_ALIAS);
  });
  out(`scenario 1 ok: ${PEER_ALIAS} visible via cross-process list`);

  if (ROLE === "planner" && PHASE === "main") {
    return runPlannerMain(ctx, tool, agent, fail);
  }
  if (ROLE === "worker" && PHASE === "main") {
    return runWorkerMain(ctx, tool, agent, fail);
  }
  return runWorkerReconnect(ctx, tool, agent, fail);
}

async function runPlannerMain(ctx, tool, agent, fail) {
  // Scenario 2: scripted turn → intercom send to the worker (real tool
  // pipeline: model tool call → dispatch → broker → peer process).
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
  out("scenario 2 ok: send crossed processes through the broker");

  // Scenario 3 (planner half): the worker's ask arrives as a relay, wakes the
  // planner, and the reply is driven through the tool's reply action.
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
  out("scenario 3 ok: answered the worker's ask via the reply action");

  // Scenario 4 (planner half): once the worker process is gone, a blocking
  // ask fails immediately and a send queues in the broker mailbox.
  await poll("worker leaving the roster", async () => {
    const listed = await tool.execute({ action: "list" }, exec(agent));
    return typeof listed === "string" && !listed.includes("worker (");
  });
  out("worker process left the roster");

  const askError = await tool
    .execute(
      { action: "ask", to: "worker", message: "still there?" },
      exec(agent),
    )
    .then(
      (value) => `unexpected success: ${value}`,
      (error) => String(error instanceof Error ? error.message : error),
    );
  if (!/not currently connected/.test(askError)) {
    return fail(`ask to a dead peer did not fail immediately: ${askError}`);
  }
  out("scenario 4a ok: ask to a disconnected peer fails immediately");

  const queuedOut = await tool.execute(
    { action: "send", to: "worker", message: QUEUED_BODY },
    exec(agent),
  );
  if (queuedOut !== "Message sent to worker") {
    return fail(`send to a dead peer did not queue: ${queuedOut}`);
  }
  out("scenario 4b ok: send queued in the broker mailbox");

  // Keep this session alive (so the broker does not idle-exit and drop the
  // mailbox) until the relaunched worker registers and receives the queue.
  await poll("relaunched worker in roster", async () => {
    const listed = await tool.execute({ action: "list" }, exec(agent));
    return typeof listed === "string" && listed.includes("worker (");
  });
  out("scenario 4c ok: relaunched worker re-registered across processes");

  out("PASS");
  exit(ctx, 0);
}

async function runWorkerMain(ctx, tool, agent, fail) {
  // Scenario 2 (worker half): the planner's relayed send wakes this idle
  // agent; the scripted mock turn answers with a blocking intercom ask.
  const relay = await poll("planner relay in worker log", () =>
    agent.session.events.find(
      (event) =>
        event.type === "user/message" &&
        event.data.source?.kind === "intercom" &&
        event.data.source.senderSessionId === "e2e-planner" &&
        JSON.stringify(event.data.content).includes(SEND_BODY),
    ),
  );
  out("scenario 2 ok: relay arrived from the planner process");

  // The wake turn's ask blocks until the planner replies (scenario 3).
  await agent.whenIdle();
  const askResult = agent.session.events.find(
    (event) =>
      event.type === "tool/result" &&
      !event.data.error &&
      JSON.stringify(event.data.message).includes(REPLY_BODY),
  );
  if (!askResult) {
    return fail("worker log has no ask tool result carrying the planner reply");
  }
  const woke = agent.session.events.find(
    (event) => event.type === "assistant/message" && event.seq > relay.seq,
  );
  if (!woke) return fail("worker never produced a turn after the relay");
  out(
    "scenario 3 ok: ask blocked across processes and unblocked with the reply",
  );

  out("PASS");
  exit(ctx, 0);
}

async function runWorkerReconnect(ctx, tool, agent, fail) {
  // Scenario 4 (worker half): same session id + alias + cwd as the dead
  // worker, so the broker flushes the queued mailbox message on register.
  let relay;
  try {
    relay = await poll("queued mailbox relay in worker log", () =>
      agent.session.events.find(
        (event) =>
          event.type === "user/message" &&
          event.data.source?.kind === "intercom" &&
          JSON.stringify(event.data.content).includes(QUEUED_BODY),
      ),
    );
  } catch (error) {
    const status = await tool
      .execute({ action: "status" }, exec(agent))
      .catch((e) => String(e));
    out(
      `debug: status=${JSON.stringify(status)} events=${JSON.stringify(agent.session.events.map((e) => e.type))}`,
    );
    throw error;
  }
  await agent.whenIdle();
  const woke = agent.session.events.find(
    (event) => event.type === "assistant/message" && event.seq > relay.seq,
  );
  if (!woke) return fail("queued message did not wake the relaunched worker");
  out(
    "scenario 4d ok: queued mailbox message delivered and answered after reconnect",
  );

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
