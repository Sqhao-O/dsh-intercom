# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

[![CI](https://github.com/Sqhao-O/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/Sqhao-O/dsh-intercom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](CHANGELOG.md)

An intercom plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): discovery, 1:1 messaging, and request/reply between independent dsh sessions running on the same machine.

Ported from [pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT, Copyright Nico Bailon) — see [NOTICE](NOTICE).

## Features

- **Cross-session messaging** — `send` (fire-and-forget, with mailbox queueing for
  temporarily disconnected named peers) and `ask`/`reply` (blocking request-reply)
  between sessions in one dsh process or across independent dsh processes.
- **Discovery** — `list` / `list-cwd` show every live session on the machine with
  name, working directory, model, and live status (`idle`, `thinking`, `tool:<name>`).
- **Session aliases** — the `name` action gives a session a stable address; peers
  resolve aliases, full session ids, or unique id prefixes.
- **Inbound relay** — messages arrive as a relay from the named sender: idle
  sessions start a new turn with it, busy sessions receive it as steering at the
  next step boundary.
- **Coordination skill** — installing the plugin also registers a `dsh-intercom`
  skill (planner-worker playbooks, send-vs-ask guidance) with dsh's skill
  registry; no manual install step.
- **Web UI panel** — in the `web` profile, an "Intercom" page in the Settings
  panel lists the live roster and can send a message as any session hosted by
  that dsh process.

## How it works

Every dsh process hosting the plugin registers each of its agents with a
local broker process (auto-spawned as `node lib/broker/broker.js` from the
installed plugin, one socket — unix socket or Windows named pipe — per
`$DSH_HOME/intercom`). Sessions discover and message each other through the
broker; if the broker cannot start, same-process sessions still work through
a direct in-memory fallback (`status` reports which mode you are in).

## Quickstart

Install into the web profile and restart dsh:

```bash
dsh plugin --profile web add github:Sqhao-O/dsh-intercom
```

`lib/` build artifacts are committed, so the GitHub install runs no build
step. Then open two sessions and name them (the `intercom` tool is available
to every session):

```
intercom({ action: "name", alias: "planner" })    → in session 1
intercom({ action: "name", alias: "worker" })     → in session 2
intercom({ action: "list" })                      → see each other, from either
intercom({ action: "send", to: "worker", message: "hello from planner" })
intercom({ action: "ask", to: "planner", message: "what is the status?" })
intercom({ action: "reply", message: "all good" }) → planner answers the ask
```

Or hand dsh the whole acceptance scenario as one prompt:

> 安装 github:Sqhao-O/dsh-intercom 插件，重启后开两个 session（分别命名 planner 和 worker），从 planner 给 worker 发一条消息并确认送达。

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

## Web UI panel

In the `web` profile, open the Settings panel → **Intercom**. The page lists
the live roster (auto-refreshing) with name, status, and directory, plus a
send box. The send box never invents an identity: you pick a sender among the
sessions hosted by that dsh process, and the message rides that session's own
broker connection — the receiver sees the real session as the sender.

The panel is served by two plugin routes on the dsh web server
(`GET /intercom/roster`, `POST /intercom/send`). Like the broker socket, they
trust the local machine: any local process can read the roster and send as a
host-local session while `dsh web` runs.

## Configuration

Optional `$DSH_HOME/intercom/config.json` — full reference (every key is
optional; unknown keys are ignored):

| Key              | Type                               | Default    | Meaning                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean                            | `true`     | When `false` the plugin loads but never spawns or connects to the broker; every tool action except `status` answers with a clear disabled message.                                                                                                  |
| `inboundTrigger` | `"always" \| "replies" \| "never"` | `"always"` | Whether an inbound broker message may wake the session into a new model turn: `"always"` wakes on every message, `"replies"` only wakes on replies to messages this session sent, `"never"` only queues messages as context (no turn is triggered). |
| `replyHint`      | boolean                            | `true`     | Append the `intercom({ action: "reply" ... })` hint to inbound messages that expect a reply.                                                                                                                                                        |
| `status`         | string                             | —          | Custom suffix appended to the automatic `idle`/`thinking` presence status shown to peers (e.g. `"idle · on-call"`).                                                                                                                                 |
| `confirmSend`    | boolean                            | `false`    | Accepted for pi-intercom config compatibility but a **no-op**: dsh's host-level tool-approval flow is the equivalent confirmation gate, so the plugin never opens its own dialog.                                                                   |

Example:

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "replyHint": true,
  "status": "custom suffix"
}
```

A malformed config file fails closed: the plugin keeps working with defaults
except `inboundTrigger: "never"`, and logs a warning. The config is **loaded
once at plugin load** — changing `config.json` afterwards takes effect only
after restarting dsh.

## Installation

```bash
dsh plugin --profile web add github:Sqhao-O/dsh-intercom
```

The GitHub install composes exactly like the tarball install below (verified
end to end by `pnpm test:dod` against a scratch `DSH_HOME`). The coordination
skill registers itself — there is no separate skill install step.

### Install from tarball

The local equivalent of the GitHub install, verified end to end against a
scratch `DSH_HOME` (never the real `~/.dsh`):

```bash
pnpm build
pnpm pack --pack-destination "$(mktemp -d)"   # produces dsh-intercom-<version>.tgz
export DSH_HOME="$(mktemp -d)"                # scratch home (Git Bash syntax)
dsh plugin --profile web add /path/to/dsh-intercom-<version>.tgz
dsh --profile web --dump-config | grep dsh-intercom   # verify the composed row
```

The tarball contains only `lib/`, `client.js`, `skills/`, `cordis.patch.yml`,
`package.json`, `README*`, `LICENSE`, and `NOTICE` — no sources or tests. For
a local checkout, see "Local development" below.

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

## End-to-end tests

All e2e scripts run against scratch `DSH_HOME` directories with mock LLMs — no
real API key, and the real `~/.dsh` is never touched. They are kept out of
`pnpm test`; see [tests/e2e/README.md](tests/e2e/README.md).

- `pnpm test:e2e` boots **three real `dsh` processes** (two concurrently, plus
  a worker relaunch) and covers the cross-process path: roster discovery via
  `list`, a `send` relay waking the peer process, an `ask` blocking until the
  peer's `reply` unblocks it, and — after the worker process is killed — an
  immediately failing `ask`, a mailbox-queued `send`, and delivery of that
  queued message to the relaunched worker (same alias + cwd).
- `pnpm test:install` runs the tarball install preview: pack, inspect the
  tarball contents, install into a scratch `DSH_HOME` with the real dsh CLI,
  and boot headless to prove the module loads (and the skill registers).
- `pnpm test:panel` boots a real `dsh web` server with the plugin
  link-installed: the browser half is served and wired into the boot graph,
  the roster route lists two probe sessions through the broker, and the send
  route delivers a real message into the peer's session log.
- `pnpm test:dod` is the final acceptance: it runs
  `dsh plugin --profile web add github:Sqhao-O/dsh-intercom` against the
  pushed GitHub repo in a fresh scratch home, then boots two dsh processes and
  proves planner→worker delivery and a worker→planner ask/reply.

## Known limitations

- **Same machine only.** Discovery and delivery go through a local socket
  (unix socket or Windows named pipe) keyed by `$DSH_HOME/intercom` — there is
  no cross-host transport.
- **Text messages only.** Attachments (files/snippets/context) exist in the
  vendored protocol types but the tool does not accept or render them yet.
- **`confirmSend` is a no-op** (see the config table).
- **The Web UI panel is web-profile only** and English-only (no locale
  namespace yet). There is no TUI overlay.
- **The panel's React rendering is verified by contract, not by a browser
  test**: the e2e asserts the bundle is served, wired into the boot graph, and
  that its data routes work end to end, but does not automate a real browser.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
