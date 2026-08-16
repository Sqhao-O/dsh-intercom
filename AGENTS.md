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
- `src/` — the dsh/Cordis plugin shell (M1): named-export entry (`index.ts`),
  in-memory session registry (`registry.ts`), pure message formatting
  (`message.ts`), the `MessageSourceMap` merge for the `intercom` relay kind
  (`source.ts`), the `intercom` tool (`tool.ts`), and the transport layer
  (`transport/types.ts` interface + `transport/local.ts` same-process direct
  delivery; the cross-process `BrokerTransport` is M2).
- `tests/` — cross-module tests that are not part of the vendored set:
  `tests/smoke.mjs` (compiled broker), `tests/*.test.ts` (plugin unit tests),
  `tests/e2e/` (real-dsh end-to-end, see its README).
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
pnpm install     # also installs git hooks (simple-git-hooks)
pnpm build       # tsdown → lib/ (ESM, one file per source file)
pnpm test        # tsx --test over broker/cwd/plugin unit tests
pnpm test:e2e    # real-dsh end-to-end (tests/e2e/; needs pnpm build + global dsh)
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
- `broker/extension.test.ts` spawns a real broker subprocess from source using
  the dev-dependency tsx CLI.
- `tests/smoke.mjs` verifies the **compiled** artifact: it spawns
  `node lib/broker/broker.js` with `DSH_HOME` pointed at a temp dir and passes
  a message between two compiled clients. Run `pnpm build` first.
- Windows specifics: named pipes (`\\.\pipe\dsh-intercom-*`), optional TCP
  transport, and permission-chmod tests are skipped on win32.
