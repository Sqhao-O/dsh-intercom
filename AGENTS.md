# AGENTS.md

Guidance for AI agents and humans maintaining this repository.

## What this is

`dsh-intercom` is an MIT-licensed plugin for DeepSeek Harness (dsh) that lets
independent dsh sessions on the same machine discover each other and exchange
messages (send / ask / reply). It is a port of
[pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT, Copyright Nico
Bailon) — attribution lives in `NOTICE`.

## Architecture

- `broker/` — **vendored from pi-intercom** (see `NOTICE`). Harness-agnostic
  Node code: a standalone broker process plus the client library that talks to
  it over a unix socket (or Windows named pipe; opt-in TCP on Windows via
  `DSH_INTERCOM_TRANSPORT=tcp`). Protocol framing, spawn locking, liveness
  heartbeats, and the extension bus all live here. Keep diffs to vendored files
  minimal and record adaptations in `NOTICE`.
- `types.ts`, `cwd.ts` — vendored shared protocol types and the same-directory
  helper used by the broker.
- `src/` — the dsh/Cordis plugin shell: named-export entry (`index.ts`),
  in-memory session registry (`registry.ts`), pure message formatting
  (`message.ts`), the `MessageSourceMap` merge for the `intercom` relay kind
  (`source.ts`), the `intercom` tool (`tool.ts`: `list` / `list-cwd` / `send`
  / `ask` / `reply` / `pending` / `status` / `cancel` / `name`), config
  loading (`config.ts`, `$DSH_HOME/intercom/config.json`, malformed →
  fail-closed), the reply tracker (`reply-tracker.ts`, ported from
  pi-intercom), the transport layer (`transport/types.ts` interface,
  `transport/local.ts` same-process direct delivery used as fallback,
  `transport/broker.ts` cross-process delivery — one `IntercomClient` per
  registered agent, auto-spawning the broker, with reconnect backoff,
  receipts, dedup, and the reply waiter), the bundled-skill registration
  (`skill.ts`, see below), and the Web UI panel host routes (`panel.ts`).
- `skills/dsh-intercom/SKILL.md` — the coordination-playbook skill. dsh rc.6
  discovers skills only from project/user roots, so `src/skill.ts` reads this
  packaged file and registers it as a runtime skill via `ctx.skills.register()`
  at plugin load (no manual install step; skipped when the profile has no
  skill registry).
- `client.js` — the Web UI panel **browser half**, hand-written in dsh's
  client-module format (`window.__ModuleLoader__.load` envelope around a CJS
  factory exporting `inject`/`apply`; React via the loader's `require`). It
  registers an "Intercom" page into the `settings.section` slot and talks to
  the host routes (`GET /intercom/roster`, `POST /intercom/send`). Wired by
  the `dsh.client` field + `exports["./client"]` in package.json; NOT built by
  tsdown — edit it directly. The panel sends only as a session hosted by the
  same dsh process (no pseudo-identity).
- `tests/` — cross-module tests that are not part of the vendored set:
  `tests/smoke.mjs` (compiled broker), `tests/*.test.ts` (plugin unit tests;
  `tests/intercom.integration.test.ts` runs the tool + BrokerTransport and a
  ported pi-intercom broker protocol suite against a real broker spawned from
  source; `tests/tool-abort.test.ts` audits `exec.signal` cancellation across
  every tool action; `tests/config-lifecycle.test.ts` proves `enabled: false`
  never spawns the broker; `tests/docs.test.ts` is the docs-as-tests check that
  every runnable README command is really executed somewhere),
  `tests/e2e/` (real-dsh cross-process end-to-end and the tarball install
  preview, see its README).
- `lib/` — **committed build output** (see below).

### Runtime layout

- State directory: `$DSH_HOME/intercom`, defaulting to `~/.dsh/intercom`.
- All env vars are `DSH_*`: `DSH_HOME`, `DSH_INTERCOM_TRANSPORT`,
  `DSH_INTERCOM_TCP`, `DSH_INTERCOM_LIVENESS_INTERVAL_MS`,
  `DSH_INTERCOM_LIVENESS_TIMEOUT_MS`, `DSH_INTERCOM_ASK_TIMEOUT_MS`.
- The broker is spawned as `node lib/broker/broker.js` via `process.execPath` —
  no tsx/npx at runtime. On Windows a hidden VBS launcher avoids a console
  window flash. A custom `brokerCommand`/`brokerArgs` pair overrides the
  executable while keeping the broker script path as the last argument.

## Commands

```bash
pnpm install     # then `pnpm setup-hooks` once per clone (git hooks via simple-git-hooks)
pnpm build       # tsdown → lib/ (ESM, one file per source file)
pnpm test        # tsx --test over broker/cwd/plugin unit tests (incl. abuse + docs tests)
pnpm test:e2e    # real-dsh end-to-end (tests/e2e/; needs pnpm build + global dsh)
pnpm test:install# tarball install preview (pack → install → boot in a scratch DSH_HOME)
pnpm lint        # oxlint
pnpm format      # prettier --write
pnpm typecheck   # tsc --noEmit (strict, NodeNext)
pnpm changeset   # add a changeset
```

## Hard rules

1. **`lib/` is committed.** dsh installs plugins from GitHub without a build
   step, so build artifacts ship in the repo. After changing any source under
   `broker/` or `src/` (or `types.ts`/`cwd.ts`), run `pnpm build` and commit
   the updated `lib/`. CI enforces this with `git diff --exit-code lib/`.
2. **`reference/` is never committed.** It holds a local clone of upstream
   pi-intercom for comparison only (gitignored).
3. **Conventional Commits** for commit messages and PR titles (commitlint).
4. Don't add dsh/Cordis API usage to the vendored broker — it must stay
   harness-agnostic Node code.

## Testing notes

- Broker unit/integration tests live next to the sources in `broker/*.test.ts`
  and run on the TypeScript sources via tsx.
- `broker/extension.test.ts` and `broker/abuse.test.ts` spawn a real broker
  subprocess from source using the dev-dependency tsx CLI; `abuse.test.ts`
  injects malformed frames, protocol violations, and rate-limit floods and
  asserts the offending connection dies while the broker stays alive.
- `tests/smoke.mjs` verifies the **compiled** artifact: it spawns
  `node lib/broker/broker.js` with `DSH_HOME` pointed at a temp dir and passes
  a message between two compiled clients. Run `pnpm build` first.
- Windows specifics: named pipes (`\\.\pipe\dsh-intercom-*`), optional TCP
  transport, and permission-chmod tests are skipped on win32.
