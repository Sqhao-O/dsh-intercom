# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: replace with real badges once the repo is public
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

An intercom plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): discovery, 1:1 messaging, and request/reply between independent dsh sessions running on the same machine.

Ported from [pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT, Copyright Nico Bailon) — see [NOTICE](NOTICE).

## Status

**Work in progress.** M0 (repository scaffold + vendored broker), M1 (dsh
plugin shell with same-process delivery), and M2 (cross-process broker
transport + ask/reply) are complete. The `intercom` tool supports the full
action set below between sessions living in one dsh process **and** across
independent dsh processes on the same machine. Remaining: M3 (robustness and
config hardening) and M4 (Web UI panel, SKILL.md, v1.0).

## How it works

Every dsh process hosting the plugin registers each of its agents with a
local broker process (auto-spawned as `node lib/broker/broker.js` from the
installed plugin, one socket — unix socket or Windows named pipe — per
`$DSH_HOME/intercom`). Sessions discover and message each other through the
broker; if the broker cannot start, same-process sessions still work through
a direct in-memory fallback (`status` reports which mode you are in).

## Usage

Give each session a name, then talk to it from any other session:

```
intercom({ action: "name", alias: "worker" })                  → name this session
intercom({ action: "list" })                                   → list live sessions (all processes)
intercom({ action: "list-cwd" })                               → list sessions in this working directory
intercom({ action: "list-cwd", cwd: "/path" })                 → list sessions in a specific directory
intercom({ action: "send", to: "worker", message: "..." })     → send a message (queued if the named peer is offline)
intercom({ action: "ask", to: "worker", message: "..." })      → send and block until the reply arrives
intercom({ action: "reply", message: "..." })                  → reply to the current / single pending ask
intercom({ action: "reply", to: "planner", message: "..." })   → disambiguate between multiple pending asks
intercom({ action: "pending" })                                → list unresolved inbound asks
intercom({ action: "cancel", messageId: "..." })               → request cancellation of a message you sent
intercom({ action: "status" })                                 → plugin/transport status
```

Address sessions by alias, full session id, or the unique id prefix shown in
parentheses by `list`. `send`/`ask` also accept `replyTo`, `messageId`,
`supersedes`, `retryOf`, and a `cwd` scope (omit `to` to target the sole live
peer in a directory). `ask` never queues: a disconnected target fails
immediately, while `send` to a recently disconnected _named_ session queues
in the broker mailbox and is delivered when a session with the same alias and
working directory reconnects. `DSH_INTERCOM_ASK_TIMEOUT_MS` overrides the
10-minute default ask timeout.

## Configuration

Optional `$DSH_HOME/intercom/config.json`:

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "replyHint": true,
  "status": "custom suffix"
}
```

- `enabled` (default `true`) — when `false` the plugin loads but never
  connects to the broker and the tool answers with a clear disabled message.
- `inboundTrigger` — `"always"` (default) wakes the session on every inbound
  message; `"replies"` only wakes on replies to messages this session sent;
  `"never"` queues inbound messages as context without triggering a turn.
- `replyHint` (default `true`) — append the `intercom({ action: "reply" ... })`
  hint to inbound messages that expect a reply.
- `status` — custom suffix appended to the automatic `idle`/`thinking`
  presence status shown to peers.
- `confirmSend` — accepted for pi-intercom config compatibility but a
  **no-op**: dsh's host-level tool-approval flow is the equivalent
  confirmation gate, so the plugin never opens its own dialog.

A malformed config file fails closed: the plugin keeps working with defaults
except `inboundTrigger: "never"`, and logs a warning.

## Installation

> Not published yet. Once released:
>
> ```
> dsh plugin add github:<owner>/dsh-intercom
> ```

For a local checkout, see "Local development" below.

## Development

Requires Node.js ≥ 20 and pnpm.

```bash
pnpm install
pnpm build       # compile sources to lib/ (artifacts are committed)
pnpm test        # node:test via tsx
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## Local development (mount into a real dsh)

Mount the checkout into a dsh profile without touching your real `~/.dsh`:

```bash
pnpm install && pnpm build   # dsh loads the compiled lib/, no build at install time

# Point DSH_HOME at a scratch directory first (Git Bash syntax):
export DSH_HOME="$PWD/tests/e2e/.tmp/dsh-home-link"

dsh plugin --profile web add link:"$PWD"   # symlinks the repo into the profile
dsh --profile web --dump-config | grep dsh-intercom   # verify the composed row
dsh web                                    # boot with the plugin mounted
```

`link:` creates a symlink in the profile's `node_modules`, so `pnpm build`
after a source edit is enough — reinstalling is never needed. The same
commands work with `--profile headless` (or any other profile).

## End-to-end test

`pnpm test:e2e` (kept out of `pnpm test`) boots **three real `dsh` processes**
(two concurrently, plus a worker relaunch) against scripted mock LLMs with a
shared scratch `DSH_HOME`, and covers the cross-process path: roster discovery
via `list`, a `send` relay waking the peer process, an `ask` blocking until
the peer's `reply` unblocks it, and — after the worker process is killed — an
immediately failing `ask`, a mailbox-queued `send`, and delivery of that
queued message to the relaunched worker (same alias + cwd). No real API key is
used and the real `~/.dsh` is never touched. See
[tests/e2e/README.md](tests/e2e/README.md).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
