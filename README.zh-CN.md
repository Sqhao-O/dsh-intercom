# dsh-intercom

[English](README.md) | [中文](README.zh-CN.md) | [Install prompt](INSTALL.md)

[![CI](https://github.com/Sqhao-O/dsh-intercom/actions/workflows/ci.yml/badge.svg)](https://github.com/Sqhao-O/dsh-intercom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](CHANGELOG.md)

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 intercom 插件：让同一台机器上多个相互独立的 dsh session 互相发现、一对一收发消息、请求-应答。

移植自 [pi-intercom](https://github.com/nicobailon/pi-intercom)（MIT，Copyright Nico Bailon）—— 署名说明见 [NOTICE](NOTICE)。

## 一段提示词完成安装

无需提前克隆本仓库，也不需要构建工具链。把一段提示词粘贴到正在运行的
DSH 会话里，代理会完成从 GitHub 安装、profile 校验到双会话互发消息验证的
全部步骤。见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md)（[English](INSTALL.md)），
或者继续往下读手动 quickstart。

## 功能

- **跨 session 消息** —— `send`（即发即弃，对暂时离线的具名对端支持 mailbox 排队）与
  `ask`/`reply`（阻塞式请求-应答），覆盖同一 dsh 进程内的 session **以及**同一台机器上
  相互独立的 dsh 进程。
- **发现** —— `list` / `list-cwd` 列出本机所有存活 session，含名称、工作目录、模型和
  实时状态（`idle`、`thinking`、`tool:<name>`）。
- **session 别名** —— `name` action 给 session 一个稳定地址；对端可用别名、完整
  session id 或唯一 id 前缀寻址。
- **入站中继** —— 消息以具名发送方的 relay 形式到达：空闲 session 用它开启新 turn，
  忙碌 session 在下一个 step 边界作为 steering 接收。
- **协作技能** —— 安装插件即自动向 dsh 技能注册表注册 `dsh-intercom` 技能
  （planner-worker 协作范式、send 与 ask 的选择指引），无需手动安装。
- **Web UI 面板** —— 在 `web` profile 中，Settings 面板里的「Intercom」页展示实时
  roster，并能以该 dsh 进程托管的任一 session 身份发送消息。

## 工作原理

每个装载了本插件的 dsh 进程都会把它的每个 agent 注册到一个本地 broker 进程
（自动以 `node lib/broker/broker.js` 拉起；每个 `$DSH_HOME/intercom` 一个 socket ——
unix socket 或 Windows 命名管道）。session 之间通过 broker 互相发现和收发消息；
如果 broker 无法启动，同进程 session 仍可通过内存直投降级工作（`status` 会显示当前模式）。

## 快速上手

安装到 web profile 并重启 dsh：

```bash
dsh plugin --profile web add github:Sqhao-O/dsh-intercom
```

`lib/` 构建产物已提交进仓库，GitHub 安装无需任何构建步骤。然后打开两个 session
并命名（`intercom` 工具对每个 session 可用）：

```
intercom({ action: "name", alias: "planner" })    → 在 session 1 中
intercom({ action: "name", alias: "worker" })     → 在 session 2 中
intercom({ action: "list" })                      → 任意一侧都能看到对方
intercom({ action: "send", to: "worker", message: "hello from planner" })
intercom({ action: "ask", to: "planner", message: "what is the status?" })
intercom({ action: "reply", message: "all good" }) → planner 回复该 ask
```

也可以把整段验收场景作为一段提示词交给 dsh：

> 安装 github:Sqhao-O/dsh-intercom 插件，重启后开两个 session（分别命名 planner 和 worker），从 planner 给 worker 发一条消息并确认送达。

## 用法

先给每个 session 命名，然后从任意其他 session 呼叫它：

```
intercom({ action: "name", alias: "worker" })                  → 给当前 session 命名
intercom({ action: "list" })                                   → 列出存活 session（所有进程）
intercom({ action: "list-cwd" })                               → 列出同一工作目录下的 session
intercom({ action: "list-cwd", cwd: "/path" })                 → 列出指定目录下的 session
intercom({ action: "send", to: "worker", message: "..." })     → 发送消息（对端离线时排队）
intercom({ action: "ask", to: "worker", message: "..." })      → 发送并阻塞直到收到回复
intercom({ action: "reply", message: "..." })                  → 回复当前 / 唯一待答的 ask
intercom({ action: "reply", to: "planner", message: "..." })   → 多个待答 ask 时消除歧义
intercom({ action: "pending" })                                → 列出未解决的入站 ask
intercom({ action: "cancel", messageId: "..." })               → 请求取消自己发出的消息
intercom({ action: "status" })                                 → 插件 / 传输层状态
```

可以用别名、完整 session id 或 `list` 输出括号里的唯一 id 前缀来寻址。
`send`/`ask` 还支持 `replyTo`、`messageId`、`supersedes`、`retryOf` 以及 `cwd`
目录范围（省略 `to` 时寻址该目录下唯一存活的对端）。`ask` 从不排队：对端未连接时立即失败；
而发给"刚断开连接的具名 session"的 `send` 会进入 broker 的 mailbox，当相同别名且相同工作目录的
session 重连时投递。`DSH_INTERCOM_ASK_TIMEOUT_MS` 可覆盖默认 10 分钟的 ask 超时。

## Web UI 面板

在 `web` profile 中打开 Settings 面板 → **Intercom**。页面展示自动刷新的实时
roster（名称、状态、目录）和一个发送框。发送框不会虚构身份：你需要从该 dsh 进程
托管的 session 中选择发送方，消息经由该 session 自己的 broker 连接发出 —— 接收方
看到的发送方就是真实的 session。

面板由插件在 dsh web server 上注册的两个路由提供服务（`GET /intercom/roster`、
`POST /intercom/send`）。与 broker socket 一样，它们信任本机：`dsh web` 运行期间，
任何本机进程都可以读取 roster 并以宿主本地 session 身份发送消息。

## 配置

可选的 `$DSH_HOME/intercom/config.json` —— 完整配置项参考（所有键均可选；未知键被忽略）：

| 键               | 类型                               | 默认值     | 含义                                                                                                                                                                                  |
| ---------------- | ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | boolean                            | `true`     | 为 `false` 时插件仍会加载，但绝不拉起或连接 broker；除 `status` 外的所有 action 都返回明确的禁用提示。                                                                                |
| `inboundTrigger` | `"always" \| "replies" \| "never"` | `"always"` | 入站 broker 消息是否可以唤醒 session 产生新 turn：`"always"` 每条消息都唤醒；`"replies"` 仅当消息是对本 session 所发消息的回复时唤醒；`"never"` 只把消息作为上下文排队，不触发 turn。 |
| `replyHint`      | boolean                            | `true`     | 在期待回复的入站消息后附上 `intercom({ action: "reply" ... })` 提示。                                                                                                                 |
| `status`         | string                             | ——         | 附加在自动 `idle`/`thinking` 状态后的自定义后缀，展示给对端（如 `"idle · on-call"`）。                                                                                                |
| `confirmSend`    | boolean                            | `false`    | 仅为兼容 pi-intercom 配置而接受该键，但**不生效（no-op）**：dsh 宿主层的工具审批流程就是等价的确认闸门，插件不会自行弹出确认框。                                                      |

示例：

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "replyHint": true,
  "status": "自定义后缀"
}
```

配置文件损坏时插件 fail-closed：除 `inboundTrigger: "never"` 外全部使用默认值，并记录警告日志。
配置在**插件加载时读取一次**——之后修改 `config.json` 需重启 dsh 才生效。

## 安装

```bash
dsh plugin --profile web add github:Sqhao-O/dsh-intercom
```

GitHub 安装与下文的 tarball 安装组合方式完全一致（由 `pnpm test:dod` 针对临时
`DSH_HOME` 端到端验证）。协作技能会自行注册 —— 没有额外的技能安装步骤。

### 从 tarball 安装

GitHub 安装的本地等价物，全程针对临时 `DSH_HOME` 验证（绝不触碰真实的 `~/.dsh`）：

```bash
pnpm build
pnpm pack --pack-destination "$(mktemp -d)"   # 产出 dsh-intercom-<version>.tgz
export DSH_HOME="$(mktemp -d)"                # 临时 home（Git Bash 语法）
dsh plugin --profile web add /path/to/dsh-intercom-<version>.tgz
dsh --profile web --dump-config | grep dsh-intercom   # 验证组合后的插件行
```

tarball 只包含 `lib/`、`client.js`、`skills/`、`cordis.patch.yml`、`package.json`、
`README*`、`LICENSE` 和 `NOTICE` —— 不含源码与测试。本地检出的挂载方式见下文「本地开发」。

## 开发

需要 Node.js ≥ 20 和 pnpm。

```bash
pnpm install
pnpm build       # 编译源码到 lib/（产物会提交进仓库）
pnpm test        # node:test + tsx
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm format      # prettier
```

协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 本地开发（挂载到真实 dsh）

在不触碰真实 `~/.dsh` 的前提下，把本仓库挂载进 dsh 配置文件：

```bash
pnpm install && pnpm build   # dsh 加载编译产物 lib/，安装时无需构建

# 先把 DSH_HOME 指向一个临时目录（Git Bash 语法）：
export DSH_HOME="$PWD/tests/e2e/.tmp/dsh-home-link"

dsh plugin --profile web add link:"$PWD"   # 在 profile 中软链本仓库
dsh --profile web --dump-config | grep dsh-intercom   # 验证组合后的插件行
dsh web                                    # 带插件启动
```

`link:` 会在 profile 的 `node_modules` 里创建符号链接，所以改了源码只需
`pnpm build`，不用重新安装。以上命令同样适用于 `--profile headless`（或任意其他 profile）。

## 端到端测试

所有 e2e 脚本都针对临时 `DSH_HOME` 目录运行，配合脚本化 mock LLM —— 不消耗真实
API key，也绝不触碰真实的 `~/.dsh`。它们不包含在 `pnpm test` 中；
详见 [tests/e2e/README.md](tests/e2e/README.md)。

- `pnpm test:e2e` 启动**三个真实 `dsh` 进程**（两个并发，外加一次 worker 重启），覆盖
  跨进程路径：通过 `list` 的 roster 发现、`send` relay 唤醒对端进程、`ask` 阻塞直到对端
  `reply` 解锁，以及 worker 进程被杀后 `ask` 立即失败、`send` 进入 mailbox、重启后的
  worker（同别名同目录）收到排队消息。
- `pnpm test:install` 运行 tarball 安装预览：打包、检查产物清单、用真实 dsh CLI 装进临时
  `DSH_HOME`，并无头启动验证插件模块能真正加载（且技能已注册）。
- `pnpm test:panel` 用 link 安装的插件启动真实 `dsh web` 服务器：浏览器端产物被伺服并接入
  boot graph，roster 路由通过 broker 列出两个探针 session，send 路由把真实消息投递进对端的
  session 日志。
- `pnpm test:dod` 是最终验收：在全新临时 home 中对已推送的 GitHub 仓库执行
  `dsh plugin --profile web add github:Sqhao-O/dsh-intercom`，然后启动两个 dsh 进程，验证
  planner→worker 的送达以及 worker→planner 的 ask/reply。

## 本机验收

`pnpm test:accept`（`tests/accept/`，同样不包含在 `pnpm test` 中）是唯一一套刻意针对
CURRENT `DSH_HOME`（默认为真实的 `~/.dsh`）的测试，用于插件装进真实 web profile 后的
就地验收。它用仓库自带的 mock LLM 启动真实 `dsh web`（通过子进程环境变量
`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY=test`；绝不触碰 `settings.yaml`，也不会发起真实
模型调用），临时向 web profile 的 `cordis.patch.yml` 追加一行探针配置（先备份，退出时按
sha256 校验逐字节恢复），并断言真实环境接线：tool 与 skill 注册、broker 在
`~/.dsh/intercom` 下自动拉起、面板的 roster/send 路由（relay 落进 worker session 日志并唤醒，
非本地 sender 返回 400）、两个探针 session 之间的 ask/reply，以及 `client.js` 的伺服。探针
session（`accept-planner-*` / `accept-worker-*`）会留在 `~/.dsh/sessions/` 并在结尾列出；
验收启动的 `dsh web` 会被停止（broker 空闲后自行退出）。

```bash
pnpm test:accept
```

## 已知限制

- **仅限同一台机器。** 发现与投递都走以 `$DSH_HOME/intercom` 为键的本地 socket
  （unix socket 或 Windows 命名管道），没有跨主机传输。
- **仅支持纯文本消息。** attachment（file/snippet/context）虽存在于 vendored 协议类型中，
  但工具暂不接收也不渲染。
- **`confirmSend` 不生效**（见配置表）。
- **Web UI 面板仅限 web profile**，且暂为纯英文（未接 locale 命名空间）。没有 TUI overlay。
- **面板的 React 渲染只按契约验证，没有浏览器自动化测试**：e2e 断言了产物被伺服、接入
  boot graph、数据路由端到端可用，但没有驱动真实浏览器。

## 许可证

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
