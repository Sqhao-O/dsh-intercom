# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: replace with real badges once the repo is public
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

An intercom plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): discovery, 1:1 messaging, and request/reply between independent dsh sessions running on the same machine.

Ported from [pi-intercom](https://github.com/nicobailon/pi-intercom) (MIT, Copyright Nico Bailon) — see [NOTICE](NOTICE).

## Status

**Work in progress.** M0 (repository scaffold + vendored broker) is complete; the dsh plugin shell is under active development.

## Installation

> Not published yet. Once released:
>
> ```
> dsh plugin add github:<owner>/dsh-intercom
> ```

## Development

Requires Node.js ≥ 20 and pnpm.

```bash
pnpm install
pnpm build       # compile broker sources to lib/ (artifacts are committed)
pnpm test        # node:test via tsx
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
