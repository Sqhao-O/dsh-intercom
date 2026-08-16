# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: 仓库公开后替换为真实徽章
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 intercom 插件：让同一台机器上多个相互独立的 dsh session 互相发现、一对一收发消息、请求-应答。

移植自 [pi-intercom](https://github.com/nicobailon/pi-intercom)(MIT,Copyright Nico Bailon)—— 署名说明见 [NOTICE](NOTICE)。

## 状态

**开发中(WIP)。** M0(仓库脚手架 + vendor broker)已完成;dsh 插件壳正在开发中。

## 安装

> 尚未发布。发布后将支持:
>
> ```
> dsh plugin add github:<owner>/dsh-intercom
> ```

## 开发

需要 Node.js ≥ 20 和 pnpm。

```bash
pnpm install
pnpm build       # 编译 broker 到 lib/(产物会提交进仓库)
pnpm test        # node:test + tsx
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier
```

协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
