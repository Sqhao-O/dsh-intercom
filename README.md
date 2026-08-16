# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: replace with real badges once the repo is public
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

An intercom plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): discovery, 1:1 messaging, and request/reply between independent dsh sessions running on the same machine.

Ported from [pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT, Copyright Nico Bailon) — see [NOTICE](NOTICE).

## Status

**Work in progress.** M0 (repository scaffold + vendored broker) and M1 (dsh plugin shell with same-process delivery) are complete. The M1 `intercom` tool supports `list` / `send` / `name` / `status` between sessions living in one dsh process; the cross-process broker, ask/reply, and mailbox land in M2.

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

`pnpm test:e2e` (kept out of `pnpm test`) boots a real `dsh` process with a
scratch `DSH_HOME` against a scripted mock LLM, lets one session's model call
`intercom({action:"send"})`, and asserts the peer's session log received the
relay message and answered it. See [tests/e2e/README.md](tests/e2e/README.md).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
