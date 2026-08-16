/**
 * dsh-intercom e2e runner plugin. Mounted into a scratch headless profile via
 * `dsh --profile headless --patch <generated>` (see run.ts, which also starts
 * the mock LLM this scenario is scripted against).
 *
 * Scenario (all inside one real dsh process):
 *   1. Create two agents, "planner" and "worker", through ctx.agents.create.
 *   2. Name both sessions by executing the registered `intercom` tool
 *      definition (the `name` action) on their behalf.
 *   3. Give the planner a task; the mock LLM is scripted to answer with a
 *      tool call `intercom({action:"send", to:"worker", message:...})`, so the
 *      send goes through the real tool pipeline (model tool call → tool
 *      registry dispatch → LocalTransport → worker inbox).
 *   4. Assert delivery: planner logged a successful tool result, the worker's
 *      session log contains the injected relay user/message, and the worker
 *      started a new turn after the injection.
 *
 * Plain .mjs: the dsh Loader imports this file URL directly (no build step).
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "dsh-intercom-e2e-runner";
export const inject = ["agents", "agentDefaultModel", "tools"];

const BODY = "hello from planner";
const TIMEOUT_MS = 120_000;

function exit(ctx, code) {
  const appExit = ctx.get("appExit");
  if (typeof appExit === "function") appExit(code);
  else process.exit(code);
}

function textOf(content) {
  return JSON.stringify(content);
}

const out = (line) => process.stdout.write(`[e2e] ${line}\n`);

const exec = (agent) => ({
  callId: `e2e-${Math.random().toString(36).slice(2)}`,
  name: "intercom",
  arguments: {},
  agent,
  signal: new AbortController().signal,
});

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
  const createAgent = (id) =>
    ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, {
          current: selection,
          assembled: undefined,
        });
      },
    });

  const worker = await createAgent("e2e-worker");
  const planner = await createAgent("e2e-planner");
  out("agents created: e2e-planner, e2e-worker");

  await tool.execute({ action: "name", alias: "worker" }, exec(worker.agent));
  await tool.execute({ action: "name", alias: "planner" }, exec(planner.agent));
  out("aliases set via the intercom tool: planner, worker");

  planner.agent.followup(
    createUserMessage({
      content: [
        { type: "text", text: "Send a greeting to the worker session." },
      ],
      source: { kind: "user" },
    }),
  );
  await planner.agent.whenIdle();
  out("planner turn settled");
  await worker.agent.whenIdle();
  out("worker turn settled");

  // (a) the planner's log holds a successful intercom tool result.
  const plannerResult = planner.agent.session.events.find(
    (event) =>
      event.type === "tool/result" &&
      !event.data.error &&
      textOf(event.data.message).includes("Delivered"),
  );
  if (!plannerResult)
    return fail(
      "planner log has no successful intercom tool result reporting delivery",
    );
  out("assertion a ok: planner tool result reports delivery");

  // (b) the worker's log holds the injected relay message from the planner.
  const relay = worker.agent.session.events.find(
    (event) =>
      event.type === "user/message" &&
      event.data.source?.kind === "intercom" &&
      event.data.source.senderSessionId === "e2e-planner" &&
      textOf(event.data.content).includes(BODY),
  );
  if (!relay)
    return fail(
      "worker log has no injected intercom relay message with the body",
    );
  out("assertion b ok: worker log holds the relay user/message");

  // (c) the injection woke the worker: it answered after the relay event.
  // (turn/start precedes user/message in the log — the claimed message is
  // appended inside its turn — so the observable proof is the reply itself.)
  const reply = worker.agent.session.events.find(
    (event) => event.type === "assistant/message" && event.seq > relay.seq,
  );
  if (!reply) return fail("worker never answered after the injection");
  out(
    "assertion c ok: worker produced an assistant reply in a turn after the injection",
  );

  out("PASS");
  exit(ctx, 0);
}

export function apply(ctx) {
  const timer = setTimeout(() => {
    process.stdout.write("[e2e] FAIL timeout waiting for the scenario\n");
    exit(ctx, 2);
  }, TIMEOUT_MS);
  void run(ctx)
    .then(() => clearTimeout(timer))
    .catch((error) => {
      process.stdout.write(
        `[e2e] FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      exit(ctx, 1);
    });
}
