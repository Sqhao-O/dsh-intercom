# dsh-intercom e2e

`pnpm test:e2e` (not part of `pnpm test`) boots a **real dsh process** against
the scripted mock LLM server and exercises the full intercom path. Requires a
built `lib/` (`pnpm build` first) and a globally installed `dsh` (resolved from
`npm root -g`, or point `DSH_BIN` at `.../@deepseek-ai/dsh/lib/bin.js`).

## What runs

`run.ts` (driver, in-process):

1. Starts `@deepseek-ai/dsh-llm-mock-server` on an OS-assigned port, scripted
   as `tool_call_success` (tool `intercom`, arguments
   `{action:"send", to:"worker", message:"hello from planner"}`) for the first
   model request and plain `success` for every later one.
2. Creates a scratch `DSH_HOME` under `tests/e2e/.tmp/` (the real `~/.dsh` is
   never touched) and generates `.tmp/e2e.patch.yml`: the LLM session titler
   and the headless one-shot runner are disabled (the titler would consume mock
   sequence entries; the runner demands a task positional), and both
   `lib/src/index.js` (the plugin under test) and `runner-plugin.mjs` are
   inserted by file URL.
3. Spawns `node <dsh bin> --profile headless --patch <overlay>` with
   `DEEPSEEK_BASE_URL` pointed at the mock (no API key needed).

`runner-plugin.mjs` (scenario, inside the dsh process):

1. Creates two agents (`e2e-planner`, `e2e-worker`) through `ctx.agents.create`
   using the profile's default model selection.
2. Sets both aliases by executing the registered `intercom` tool definition
   (`name` action) on each agent's behalf.
3. Submits a user follow-up to the planner. The mock LLM answers with the
   scripted `intercom` tool call, so the send travels the **real tool
   pipeline**: model tool call → tool registry dispatch → `execute` →
   `LocalTransport` → worker inbox.

## Assertions

- **(a)** The planner's session log contains a `tool/result` event for the
  intercom call with no error, reporting `Delivered to worker`.
- **(b)** The worker's session log contains a `user/message` event whose source
  is the merged `intercom` kind (`form: 'relay'`,
  `senderSessionId: 'e2e-planner'`) and whose text includes the body.
- **(c)** The injection woke the idle worker: its log contains an
  `assistant/message` after the relay event (a new turn answered it; note the
  claimed `user/message` is appended _inside_ its turn, so `turn/start`
  precedes it in seq order).

The scenario prints `[e2e] PASS` and exits 0; the driver mirrors the child
output and propagates the exit code. The runner self-times-out after 120 s and
the driver kills the child after 170 s.

## Not covered here (M2+)

Cross-process delivery through the socket broker, `ask`/`reply`, the busy-peer
`steer` path end to end (covered by unit tests in `tests/transport-local.test.ts`).
