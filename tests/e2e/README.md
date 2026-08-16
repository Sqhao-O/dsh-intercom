# dsh-intercom e2e

`pnpm test:e2e` (not part of `pnpm test`) boots **multiple real dsh
processes** against scripted mock LLM servers and exercises the cross-process
intercom path end to end. Requires a built `lib/` (`pnpm build` first) and a
globally installed `dsh` (resolved from `npm root -g`, or point `DSH_BIN` at
`.../@deepseek-ai/dsh/lib/bin.js`).

`pnpm test:install` (`install-preview.ts`, also not part of `pnpm test`) is
the local equivalent of `dsh plugin add github:<owner>/dsh-intercom`: it runs
`pnpm pack`, inspects the tarball (must contain `lib/`, `cordis.patch.yml`,
`NOTICE`, no sources), installs the tarball into a scratch `DSH_HOME` via the
real dsh CLI, checks `--dump-config` lists the plugin, and boots a headless
profile with `install-check.mjs` to prove the installed module loads and
registers the `intercom` tool. It also runs the README `link:` install flow in
a second scratch home. The real `~/.dsh` is never touched.

## What runs

`run.ts` (driver, in-process):

1. Starts two `@deepseek-ai/dsh-llm-mock-server` instances — one per process,
   because request sequences are positional per server. The planner mock
   answers its first request with `intercom({action:"send", to:"worker"})`,
   the worker mock answers its first (relay-woken) request with
   `intercom({action:"ask", to:"planner"})`; everything after is plain text.
2. Creates a **per-run scratch `DSH_HOME`** under `tests/e2e/.tmp/` shared by
   all child processes (broker discovery is keyed by the intercom state dir;
   the real `~/.dsh` is never touched) and generates the patch overlay: the
   LLM session titler and headless one-shot runner are disabled, and both
   `lib/src/index.js` (plugin under test) and `runner-plugin.mjs` are inserted
   by file URL.
3. Spawns proc A (`E2E_ROLE=planner`) and, once A's runner is up, proc B
   (`E2E_ROLE=worker`) — the stagger avoids a dsh profile-boot race on a fresh
   shared `DSH_HOME`. The first process to attach an agent auto-spawns the
   socket broker under the shared state dir; the second connects to it.
4. After B reports PASS and exits, spawns proc B2 (`E2E_PHASE=reconnect`):
   same session id, alias and cwd as B, against the same `DSH_HOME`.

`runner-plugin.mjs` (scenario, inside each dsh process) creates one agent
through `ctx.agents.create`, names it via the tool's `name` action, and then:

- **planner (A)**: waits for `worker` in the `list` roster; runs the scripted
  send turn; waits for the worker's inbound ask and answers it by driving the
  tool's `reply` action directly; once the worker process dies, verifies
  `ask` fails immediately and `send` queues; keeps its session alive (so the
  broker does not idle-exit and drop the mailbox) until the relaunched worker
  re-registers.
- **worker (B)**: waits for `planner` in the roster; the relayed send wakes it
  and its scripted ask blocks until the planner's reply arrives.
- **worker (B2, reconnect)**: the broker flushes the queued mailbox message on
  registration; the relay wakes a turn.

## Assertions

- **Scenario 1**: each process sees the other via `list` (broker roster across
  processes).
- **Scenario 2**: A's `send` tool result reports `Message sent to worker`;
  B's session log holds the `user/message` relay (source kind `intercom`,
  `senderSessionId: 'e2e-planner'`) containing the body.
- **Scenario 3**: B's `ask` tool result contains the planner's reply text —
  the ask genuinely blocked across processes until A's `reply` action ran.
- **Scenario 4**: with B dead, A's `ask` fails immediately
  (`not currently connected`), A's `send` reports queued delivery, and B2
  (same alias + cwd) receives the queued message and answers it.

Each runner prints `[e2e:<role>] PASS` and exits 0; the driver mirrors all
child output, propagates exit codes, and kills any leftover broker keyed to
the scratch home. Runners self-time-out after 100 s; the driver kills a child
after 150 s.
