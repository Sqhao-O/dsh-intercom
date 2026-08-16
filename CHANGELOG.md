# dsh-intercom

## 1.0.0

### Major Changes

- v1.0.0 — first stable release.

  dsh-intercom lets independent dsh sessions on the same machine discover each other and exchange messages (send / ask / reply). Highlights:

  - `intercom` tool with the full action set: `list`, `list-cwd`, `send`, `ask`, `reply`, `pending`, `cancel`, `status`, `name` — addressable by alias, session id, or id prefix.
  - Cross-process broker transport (auto-spawned vendored broker over unix socket / Windows named pipe, opt-in TCP) with reconnect backoff, delivery receipts, dedup, and a lost-wake redelivery watchdog; same-process in-memory fallback when the broker is unavailable.
  - Blocking `ask`/`reply` with reply tracking and a configurable timeout (`DSH_INTERCOM_ASK_TIMEOUT_MS`, default 10 min); `send` to a recently disconnected named session queues in the broker mailbox and is delivered on same-alias+same-cwd reconnect.
  - Inbound relay semantics: idle sessions start a new turn, busy sessions are steered at the next step boundary; `inboundTrigger` config (`always`/`replies`/`never`) controls waking.
  - `$DSH_HOME/intercom/config.json` with fail-closed parsing; `enabled: false` never spawns the broker.
  - Zero-build install: `lib/` artifacts are committed, so `dsh plugin --profile web add github:Sqhao-O/dsh-intercom` works with no build step and no API key requirements beyond dsh itself.
  - Bundled `dsh-intercom` skill (planner-worker coordination playbooks), self-registered with dsh's skill registry at plugin load.
  - Web UI panel (web profile): an "Intercom" Settings page with a live roster and a send box that sends as a host-local session, backed by the plugin's `/intercom/roster` and `/intercom/send` routes.

  Ported from pi-intercom (MIT, Copyright Nico Bailon) — see NOTICE.

### Minor Changes

- 15ff5ed: Cross-process intercom: broker transport over local socket/named pipe with auto-spawn and reconnect, full tool action set (ask/reply/pending/cancel/list-cwd), reply tracker, offline mailbox with name+cwd redelivery rules, config file ($DSH_HOME/intercom/config.json) with fail-closed parsing, and lost-wake redelivery watchdog for inbox injection.
