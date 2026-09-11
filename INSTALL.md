# Install dsh-intercom with a DSH agent

[English](INSTALL.md) | [中文](INSTALL.zh-CN.md)

No local checkout or build toolchain is needed. Paste the prompt below into a
running DSH session (for example `dsh web`) — the agent installs the plugin
straight from GitHub, verifies the composed profile, and proves the intercom
tool is live. The only prerequisite is a working `dsh` CLI on Node `^22.19` or
`>= 24`. The plugin's `lib/` build artifacts are committed, so the install runs
no build step; the broker it auto-spawns is plain Node.js on any shell (cmd,
PowerShell, pwsh, Git Bash).

## The install prompt

```text
Install the dsh-intercom plugin into my DSH web profile, end to end. Do every
step yourself in the terminal and verify the result.

1. Install the plugin package:
   dsh plugin --profile web add github:Sqhao-O/dsh-intercom
2. Run `dsh --profile web --dump-config` and confirm the composed profile
   contains the dsh-intercom entry (inject includes agents and tools).
3. Optional tuning: if <home>/.dsh/intercom/config.json does not exist yet,
   create it with:
   { "inboundTrigger": "always", "replyHint": true }
   These are already the defaults — writing them out just makes them easy to
   change later. Replace <home> with my absolute home directory.
4. Remind me to restart `dsh web`. After the restart, in this session call the
   intercom tool twice:
   intercom({ action: "name", alias: "planner" })
   intercom({ action: "status" })
   Confirm the tool is registered and the broker is connected (status reports
   the broker transport, not the local fallback), then report the roster.

Hard constraints: do not install Docker or any global build tool; do not edit
cordis.patch.yml, settings.yaml, or any other profile entry; apart from the
config.json in step 3, do not touch anything else under ~/.dsh.
```

## Verify with a peer session

After the install prompt finishes and `dsh web` is back up, open a second
session (another terminal, or a new conversation in the same `dsh web`) and
paste:

```text
Call the intercom tool three times and report what you get:
intercom({ action: "name", alias: "worker" })
intercom({ action: "list" })
intercom({ action: "ask", to: "planner", message: "install check: reply with 'pong'" })
Show me the planner's reply.
```

The `ask` blocks until the planner session answers — its agent was woken by
your question and should reply through `intercom({ action: "reply", ... })`.
If you see the reply text as the tool result, cross-session messaging is
working end to end.

## Optional: teach your project's agents when to coordinate

Paste this block into your project's `AGENTS.md` so agents reach for the
intercom at the right moments instead of duplicating work across sessions:

```markdown
<dsh-intercom>
Coordinate with other local dsh sessions on related codebases via the
`intercom` tool; the bundled `dsh-intercom` skill has copy-paste patterns.

**When:** same codebase (parallel work), reference codebase (consulting
patterns), related repos (shared libraries).
**Not when:** unrelated codebases, trivial questions, or when you can proceed
independently.
**Principle:** prefer `send` for notifications; `ask` only when blocked
waiting for input.
</dsh-intercom>
```

## Manual procedure

1. Install the plugin into the active profile. `dsh web` always uses the
   `web` profile; do not install into another profile and expect it to show
   up in `dsh web`.

   ```bash
   dsh plugin --profile web add github:Sqhao-O/dsh-intercom
   ```

2. Confirm the composed profile carries the plugin:

   ```bash
   dsh --profile web --dump-config
   ```

   Look for the `dsh-intercom` row with `inject: [agents, tools]`.

3. Restart `dsh web`. Every session now has the `intercom` tool — name each
   session (`intercom({ action: "name", alias: "..." })`) so peers can
   address it by alias.

4. Optional: tune `$DSH_HOME/intercom/config.json` (see the configuration
   reference in [README.md](README.md#configuration)). Malformed JSON fails
   closed to `inboundTrigger: "never"`, so a typo can never make a message
   wake a session you did not intend.

## Troubleshooting

- **`status` shows the local fallback instead of the broker** — the broker
  failed to spawn; check `$DSH_HOME/intercom/` for `broker.pid` and rerun
  `intercom({ action: "status" })` after a restart. Cross-process messaging
  requires the broker; same-process sessions keep working either way.
- **A peer is missing from `list`** — only sessions that have loaded the
  plugin and registered with the broker appear. Restart that session's dsh
  process after installing.
- **A message to a disconnected peer** — `ask` fails fast; `send` queues in
  the broker mailbox and is delivered when a session reconnects with the
  same alias and working directory.
