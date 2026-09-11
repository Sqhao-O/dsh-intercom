# 一段提示词安装 dsh-intercom

[English](INSTALL.md) | [中文](INSTALL.zh-CN.md)

无需提前克隆本仓库，也不需要构建工具链。把下面这段提示词直接粘贴到正在运行的
DSH 会话（例如 `dsh web`）里，Harness 代理会一次性完成从 GitHub 安装、profile
校验到工具可用性验证的全部步骤。唯一前置条件是可用的 `dsh` CLI（Node `^22.19`
或 `>= 24`）。插件的 `lib/` 构建产物已提交进仓库，安装过程不跑任何构建；它自动
拉起的 broker 是纯 Node.js 进程，cmd、PowerShell、pwsh、Git Bash 均可运行。

## 安装提示词

```text
请把 dsh-intercom 插件端到端安装到我的 DSH web profile，所有步骤由你在终端里
完成并验证结果。

1. 安装插件包：
   dsh plugin --profile web add github:Sqhao-O/dsh-intercom
2. 运行 `dsh --profile web --dump-config`，确认合成后的配置里出现 dsh-intercom
   条目（inject 包含 agents 和 tools）。
3. 可选优化：如果 <home>/.dsh/intercom/config.json 不存在，创建它并写入：
   { "inboundTrigger": "always", "replyHint": true }
   这两个就是默认值，写出来只是为了以后方便修改；把 <home> 替换成我的主目录
   绝对路径。
4. 提醒我重启 `dsh web`。重启之后，在当前会话里调用两次 intercom 工具：
   intercom({ action: "name", alias: "planner" })
   intercom({ action: "status" })
   确认工具已注册、broker 已连接（status 显示 broker 传输而不是 local
   fallback），然后把会话名单报告给我。

硬性约束：不要安装 Docker 或任何全局构建工具；不要修改 cordis.patch.yml、
settings.yaml 或 profile 里的其他条目；除了第 3 步的 config.json，不要改动
~/.dsh 下的任何其他文件。
```

## 用第二个会话验证

安装提示词完成、`dsh web` 重启之后，再开一个会话（另一个终端，或同一个
`dsh web` 里的新对话），粘贴：

```text
调用三次 intercom 工具并报告结果：
intercom({ action: "name", alias: "worker" })
intercom({ action: "list" })
intercom({ action: "ask", to: "planner", message: "安装验证：回复 pong" })
把 planner 的回复给我看。
```

`ask` 会阻塞到 planner 会话应答——对方 agent 会被你的问题唤醒，并通过
`intercom({ action: "reply", ... })` 回复。看到回复文本作为工具结果返回，
就说明跨会话消息已经端到端打通。

## 可选：让项目里的 agent 知道何时协作

把下面这段贴进你项目的 `AGENTS.md`，agent 就会在合适的时机主动使用
intercom，而不是在多个会话间重复劳动：

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

## 手动安装步骤

1. 把插件装进当前使用的 profile。`dsh web` 固定使用 `web` profile；不要装进
   别的 profile 再指望它出现在 `dsh web` 里。

   ```bash
   dsh plugin --profile web add github:Sqhao-O/dsh-intercom
   ```

2. 确认合成后的 profile 包含该插件：

   ```bash
   dsh --profile web --dump-config
   ```

   找到 `inject: [agents, tools]` 的 `dsh-intercom` 条目。

3. 重启 `dsh web`。此后每个会话都有 `intercom` 工具——给每个会话起名字
   （`intercom({ action: "name", alias: "..." })`），其他会话就能按别名
   寻址。

4. 可选：调整 `$DSH_HOME/intercom/config.json`（完整配置参考见
   [README.zh-CN.md](README.zh-CN.md)）。JSON 写坏了会 fail-closed 到
   `inboundTrigger: "never"`，笔误绝不会让消息唤醒你意料之外的会话。

## 排障

- **`status` 显示 local fallback 而不是 broker** —— broker 拉起失败；检查
  `$DSH_HOME/intercom/` 下是否有 `broker.pid`，重启后再调一次
  `intercom({ action: "status" })`。跨进程消息必须走 broker；同进程会话
  两种模式都能工作。
- **`list` 里看不到某个对端** —— 只有加载了插件并向 broker 注册过的会话
  才会出现。安装后请重启那个会话所在的 dsh 进程。
- **发给已断开对端的消息** —— `ask` 会立即失败；`send` 会进入 broker 的
  离线信箱，等相同别名 + 相同工作目录的会话重连后投递。
