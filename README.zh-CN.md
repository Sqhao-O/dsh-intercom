# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md)

<!-- TODO: 仓库公开后替换为真实徽章
[![CI](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/dsh-intercom/actions/workflows/ci.yml)
-->

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 intercom 插件：让同一台机器上多个相互独立的 dsh session 互相发现、一对一收发消息、请求-应答。

移植自 [pi-intercom](https://github.com/nicobailon/pi-intercom)(MIT,Copyright Nico Bailon)—— 署名说明见 [NOTICE](NOTICE)。

## 状态

**开发中(WIP)。** M0(仓库脚手架 + vendor broker)、M1(dsh 插件壳 + 同进程直投)、
M2(跨进程 broker 传输 + ask/reply)、M3(健壮性与配置加固)已完成。`intercom` 工具支持
下文列出的全部 action,覆盖同一 dsh 进程内的 session **以及**同一台机器上相互独立的
dsh 进程。剩余:M4(Web UI 面板、SKILL.md、v1.0)。

## 工作原理

每个装载了本插件的 dsh 进程都会把它的每个 agent 注册到一个本地 broker 进程
(自动以 `node lib/broker/broker.js` 拉起;每个 `$DSH_HOME/intercom` 一个 socket ——
unix socket 或 Windows 命名管道)。session 之间通过 broker 互相发现和收发消息;
如果 broker 无法启动,同进程 session 仍可通过内存直投降级工作(`status` 会显示当前模式)。

## 用法

先给每个 session 命名,然后从任意其他 session 呼叫它:

```
intercom({ action: "name", alias: "worker" })                  → 给当前 session 命名
intercom({ action: "list" })                                   → 列出存活 session(所有进程)
intercom({ action: "list-cwd" })                               → 列出同一工作目录下的 session
intercom({ action: "list-cwd", cwd: "/path" })                 → 列出指定目录下的 session
intercom({ action: "send", to: "worker", message: "..." })     → 发送消息(对端离线时排队)
intercom({ action: "ask", to: "worker", message: "..." })      → 发送并阻塞直到收到回复
intercom({ action: "reply", message: "..." })                  → 回复当前 / 唯一待答的 ask
intercom({ action: "reply", to: "planner", message: "..." })   → 多个待答 ask 时消除歧义
intercom({ action: "pending" })                                → 列出未解决的入站 ask
intercom({ action: "cancel", messageId: "..." })               → 请求取消自己发出的消息
intercom({ action: "status" })                                 → 插件 / 传输层状态
```

可以用别名、完整 session id 或 `list` 输出括号里的唯一 id 前缀来寻址。
`send`/`ask` 还支持 `replyTo`、`messageId`、`supersedes`、`retryOf` 以及 `cwd`
目录范围(省略 `to` 时寻址该目录下唯一存活的对端)。`ask` 从不排队:对端未连接时立即失败;
而发给"刚断开连接的具名 session"的 `send` 会进入 broker 的 mailbox,当相同别名且相同工作目录的
session 重连时投递。`DSH_INTERCOM_ASK_TIMEOUT_MS` 可覆盖默认 10 分钟的 ask 超时。

## 配置

可选的 `$DSH_HOME/intercom/config.json` —— 完整配置项参考(所有键均可选;未知键被忽略):

| 键               | 类型                               | 默认值     | 含义                                                                                                                                                                              |
| ---------------- | ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean                            | `true`     | 为 `false` 时插件仍会加载,但绝不拉起或连接 broker;除 `status` 外的所有 action 都返回明确的禁用提示。                                                                              |
| `inboundTrigger` | `"always" \| "replies" \| "never"` | `"always"` | 入站 broker 消息是否可以唤醒 session 产生新 turn:`"always"` 每条消息都唤醒;`"replies"` 仅当消息是对本 session 所发消息的回复时唤醒;`"never"` 只把消息作为上下文排队,不触发 turn。 |
| `replyHint`      | boolean                            | `true`     | 在期待回复的入站消息后附上 `intercom({ action: "reply" ... })` 提示。                                                                                                             |
| `status`         | string                             | ——         | 附加在自动 `idle`/`thinking` 状态后的自定义后缀,展示给对端(如 `"idle · on-call"`)。                                                                                               |
| `confirmSend`    | boolean                            | `false`    | 仅为兼容 pi-intercom 配置而接受该键,但**不生效(no-op)**:dsh 宿主层的工具审批流程就是等价的确认闸门,插件不会自行弹出确认框。                                                       |

示例:

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "replyHint": true,
  "status": "自定义后缀"
}
```

配置文件损坏时插件 fail-closed:除 `inboundTrigger: "never"` 外全部使用默认值,并记录警告日志。
配置在**插件加载时读取一次**——之后修改 `config.json` 需重启 dsh 才生效。

## 安装

> 尚未发布到 GitHub。仓库公开后将支持:
>
> ```
> dsh plugin add github:<owner>/dsh-intercom
> ```
>
> `lib/` 构建产物会提交进仓库,因此 GitHub 安装无需任何构建步骤 —— 其组合方式与下文的
> tarball 安装完全一致(由 `pnpm test:install` 端到端验证)。

### 从 tarball 安装

GitHub 安装的本地等价物,全程针对临时 `DSH_HOME` 验证(绝不触碰真实的 `~/.dsh`):

```bash
pnpm build
pnpm pack --pack-destination "$(mktemp -d)"   # 产出 dsh-intercom-<version>.tgz
export DSH_HOME="$(mktemp -d)"                # 临时 home(Git Bash 语法)
dsh plugin --profile web add /path/to/dsh-intercom-<version>.tgz
dsh --profile web --dump-config | grep dsh-intercom   # 验证组合后的插件行
```

tarball 只包含 `lib/`、`cordis.patch.yml`、`package.json`、`README*`、`LICENSE` 和
`NOTICE` —— 不含源码与测试。本地检出的挂载方式见下文「本地开发」。

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

`pnpm test:e2e`(不包含在 `pnpm test` 中)会用共享的临时 `DSH_HOME` 启动**两个独立的真实
`dsh` 进程**(配合各自的脚本化 mock LLM,不消耗真实 API key),覆盖:跨进程 roster 发现、
跨进程 `send` 唤醒对端、`ask` 阻塞直到对端 `reply` 解锁、对端进程被杀后 `ask` 立即失败、
`send` 进入 mailbox,以及同名同目录 worker 重启后收到排队消息。
详见 [tests/e2e/README.md](tests/e2e/README.md)。`pnpm test:install`(同样不在
`pnpm test` 中)运行安装预览:打包 tarball、检查产物清单、用真实 dsh CLI 把它装进临时
`DSH_HOME`,并无头启动验证插件模块能真正加载。

## 已知限制

- **仅限同一台机器。** 发现与投递都走以 `$DSH_HOME/intercom` 为键的本地 socket
  (unix socket 或 Windows 命名管道),没有跨主机传输。
- **仅支持纯文本消息。** attachment(file/snippet/context)虽存在于 vendored 协议类型中,
  但工具暂不接收也不渲染。
- **`confirmSend` 不生效**(见配置表)。
- **暂无 UI 面板。** 交互完全通过 `intercom` 工具进行;Web UI slot 面板计划在 M4,
  也没有 TUI overlay。

## 许可证

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
