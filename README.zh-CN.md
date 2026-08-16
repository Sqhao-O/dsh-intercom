# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: 仓库公开后替换为真实徽章
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 intercom 插件：让同一台机器上多个相互独立的 dsh session 互相发现、一对一收发消息、请求-应答。

移植自 [pi-intercom](https://github.com/nicobailon/pi-intercom)(MIT,Copyright Nico Bailon)—— 署名说明见 [NOTICE](NOTICE)。

## 状态

**开发中(WIP)。** M0(仓库脚手架 + vendor broker)与 M1(dsh 插件壳 + 同进程直投)已完成。M1 的 `intercom` 工具支持同一 dsh 进程内 session 之间的 `list` / `send` / `name` / `status`;跨进程 broker、ask/reply、mailbox 属于 M2。

## 安装

> 尚未发布。发布后将支持:
>
> ```
> dsh plugin add github:<owner>/dsh-intercom
> ```

本地检出的挂载方式见下文「本地开发」。

## 开发

需要 Node.js ≥ 20 和 pnpm。

```bash
pnpm install
pnpm build       # 编译源码到 lib/(产物会提交进仓库)
pnpm test        # node:test + tsx
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier
```

协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 本地开发(挂载到真实 dsh)

在不触碰真实 `~/.dsh` 的前提下,把本仓库挂载进 dsh 配置文件:

```bash
pnpm install && pnpm build   # dsh 加载编译产物 lib/,安装时无需构建

# 先把 DSH_HOME 指向一个临时目录(Git Bash 语法):
export DSH_HOME="$PWD/tests/e2e/.tmp/dsh-home-link"

dsh plugin --profile web add link:"$PWD"   # 在 profile 中软链本仓库
dsh --profile web --dump-config | grep dsh-intercom   # 验证组合后的插件行
dsh web                                    # 带插件启动
```

`link:` 会在 profile 的 `node_modules` 里创建符号链接,所以改了源码只需
`pnpm build`,不用重新安装。以上命令同样适用于 `--profile headless`(或任意其他 profile)。

## 端到端测试

`pnpm test:e2e`(不包含在 `pnpm test` 中)会用临时 `DSH_HOME` 启动一个真实的
`dsh` 进程,配合脚本化的 mock LLM:让一个 session 的模型调用
`intercom({action:"send"})`,并断言对端 session 日志收到了 relay 消息并产生了回复。
详见 [tests/e2e/README.md](tests/e2e/README.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
