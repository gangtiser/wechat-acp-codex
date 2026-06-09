# wechat-acp-codex

把微信私聊消息桥接到本机项目里的 Codex，或任何兼容 ACP（Agent Client Protocol）的 agent。

`wechat-acp-codex` 是 [wechat-acp](https://github.com/formulahendry/wechat-acp) 的 Codex 定制版。它通过微信 iLink Bot API 扫码登录，轮询私聊消息，把消息交给当前项目目录中的 ACP agent，再把 agent 回复发回微信。

## 适合做什么

- 在手机微信里给本机项目里的 Codex 发任务
- 在多个项目之间快速切换微信对话目标
- 让 cron、launchd 等本地自动化任务通过微信触发 agent
- 把微信文件保存到本地，并把文件路径交给 agent 处理
- 用同一套桥接逻辑接入 Claude、Gemini、Copilot、Qwen、OpenCode 等 ACP agent

## 核心概念

### 项目目录就是 agent 工作目录

默认情况下，`wechat-acp-codex` 会在启动命令所在目录运行 agent。也就是说，你在哪个项目目录启动，微信消息就会发送给哪个项目里的 agent。需要指定目录时使用 `--cwd <dir>`。

### 默认 agent 是 Codex

不传 `--agent` 时默认使用 `codex` preset。也可以切换到内置 preset，或传入任意原始 ACP agent 命令。

### Owner 控制谁能驱动 bot

bridge 只处理一个 owner 的私聊消息，其他发送者会被静默忽略。首次使用推荐传 `--allow-first`，让第一个给 bot 发消息的微信账号自动绑定为 owner。

### 会话会保留上下文

每个微信用户对应一个 ACP agent session，默认空闲 1440 分钟后清理。可以用 `--idle-timeout <m>` 调整，传 `0` 表示不限时。

### 微信输出默认做过整理

默认会剥离 agent 回复里的 Markdown，让微信消息更干净；默认隐藏 agent thinking 和 ACP 文件 diff。分别可以用 `--no-strip-markdown`、`--show-thoughts`、`--show-diffs` 调整。

### 单实例最新启动者接管

同一个 storage 实例同一时间只运行一个 bridge。你在另一个项目里重新启动后，新进程会接管，旧进程会退出。因此微信当前对着哪个项目，取决于最后一次启动的目录。

需要并排运行多个 bridge 时，用 `--instance <name>` 隔离存储、登录 token、owner、daemon pid 和日志。

## 环境要求

- Node.js 20+
- 可使用 iLink Bot API 的微信环境
- 本机已安装并认证要使用的 agent，或可通过对应 preset 启动

## 快速开始

在要让 Codex 处理的项目目录里运行：

```bash
npx -y wechat-acp-codex@latest --allow-first
```

首次启动会做这些事：

1. 发起微信二维码登录，并在终端显示二维码
2. 登录成功后把 token 保存到 `~/.wechat-acp-codex/`
3. 开始轮询微信私聊消息
4. 因为传了 `--allow-first`，第一个给 bot 发消息的微信账号会被绑定为 owner

之后你就可以在微信里给 bot 发消息，消息会进入当前项目目录里的 Codex agent。

日常使用建议全局安装一次：

```bash
npm install -g wechat-acp-codex
```

下文示例都使用全局命令 `wechat-acp-codex`。如果没有全局安装，把它替换成 `npx -y wechat-acp-codex@latest` 即可。

## 日常使用

### 后台运行

首次使用建议前台启动，方便扫码和观察日志。登录完成后，日常可以后台运行：

```bash
wechat-acp-codex --daemon
```

查看状态或停止后台 daemon：

```bash
wechat-acp-codex status
wechat-acp-codex stop
```

### 在项目间切换

在哪个项目目录启动，微信就对哪个项目。要切换项目，直接在新目录启动即可：

```bash
cd ~/code/project-a
wechat-acp-codex --daemon

cd ~/code/project-b
wechat-acp-codex --daemon
```

也可以不切目录，直接指定：

```bash
wechat-acp-codex --cwd ~/code/project-b --daemon
```

新启动的 bridge 会接管同一个实例下的旧 bridge。

### 管理 owner

查看当前 owner：

```bash
wechat-acp-codex owner show
```

清除 owner 后，可以用 `--allow-first` 重新绑定：

```bash
wechat-acp-codex owner clear
wechat-acp-codex --allow-first
```

也可以启动时显式绑定：

```bash
wechat-acp-codex --owner <wechat-user-id>
```

`--login` 只会强制重新扫码登录，不会清除 owner。

### 卡住时清理

极少数情况下，如果进程被 `Ctrl-Z` 挂起、`stop` 失效，或残留锁文件导致启动时报 `lock held by ...`，可以手动清理默认实例：

```bash
pkill -9 -f "wechat-acp-codex.js"
pkill -9 -f "wechat-acp-codex@latest"
rm -f ~/.wechat-acp-codex/wechat.lock
```

命名实例的锁文件在 `~/.wechat-acp-codex/instances/<name>/wechat.lock`。

## 微信内命令

把下面这些内容作为普通微信消息发送给 bot，即可控制当前 ACP session。

| 消息 | 效果 |
|---|---|
| `/acp-cancel` | 取消正在执行的 agent turn |
| `/acp-cancel all` | 取消当前 turn，并丢弃队列里的后续消息 |
| `/acp-prompt-start` | 开始组合多段 prompt |
| `/acp-prompt-done` | 把已组合的多条文本、图片或文件一次性提交给 agent |
| `/acp-config` | 查看当前 ACP session 暴露的配置项 |
| `/acp-config set <id> <value>` | 修改 agent 暴露的某个配置项 |

### 命令别名

可以通过 `--config` 指定 JSON 配置文件，用 `commandAliases` 给这些命令设置别名：

```json
{
  "commandAliases": {
    "/acp-cancel": ["/cancel", "取消"]
  }
}
```

以 `/` 开头的别名像普通命令一样匹配命令 token；不带 `/` 的裸词别名只有在整条消息完全匹配时才会触发，适合微信语音转文字。

## Agent 选择

列出内置 presets：

```bash
wechat-acp-codex agents
```

当前内置 presets：

```text
claude, codex, copilot, gemini, hermes, kimi, kiro, openclaw, opencode, pi, qwen
```

常见用法：

```bash
# 默认 Codex
wechat-acp-codex --allow-first

# 使用 Claude preset
wechat-acp-codex --agent claude --allow-first

# 使用原始 ACP agent 命令
wechat-acp-codex --agent "npx my-agent --acp" --allow-first
```

如果某个 preset 对应的 agent 需要登录或授权，请先按该 agent 自己的方式完成认证。

## 可选：`codex wechat` 快捷入口

`wechat-acp-codex` 是独立命令。如果希望用 `codex wechat` 调用它，可以在 `~/.zshrc` 或 `~/.bashrc` 里添加 shell 函数：

```sh
codex() { if [ "$1" = wechat ]; then shift; command wechat-acp-codex "$@"; else command codex "$@"; fi }
```

之后 `codex wechat` 会运行 `wechat-acp-codex`，其他 `codex ...` 命令仍会透传给真正的 Codex CLI。这里不提供自动安装脚本；Codex 本身不能挂载第三方子命令，手动 shell 函数是最干净的兼容方式。

## 文件和多段输入

### 接收微信文件

当微信用户发送二进制文件时，bridge 会从微信 CDN 下载并解密，默认保存到 `<storage.dir>/inbox/`。agent 会在 prompt 里收到文件绝对路径，因此可以直接读取：

```text
[Received file: report.pdf (484067 bytes) — saved to: /Users/me/.wechat-acp-codex/inbox/2026-05-21T09-29-12-492Z-report.pdf]
```

可以改保存目录，或关闭文件保存：

```bash
wechat-acp-codex --inbox-dir ~/Downloads/wechat-agent-files
wechat-acp-codex --no-inbox
```

关闭文件保存后，agent 只会看到文件名和大小提示，不能读取文件内容。

文本文件、源码、Markdown、JSON 和图片会直接嵌入 prompt，不需要先写入磁盘。

### 组合多段 prompt

微信不方便一次发送混合内容。需要把多条文本、图片和文件合成一个 prompt 时：

1. 发送 `/acp-prompt-start`
2. 继续发送要组合的多条内容
3. 发送 `/acp-prompt-done`

bridge 会把中间收集到的内容一次性提交给 agent。

## 本地注入消息

`inject` 会把一条本地消息排入正在运行 daemon 的队列，适合 cron、launchd 或其他自动化任务：

```bash
wechat-acp-codex inject --text "今日 AI 资讯"
wechat-acp-codex inject --file ./prompt.txt
```

默认目标是最近活跃的微信用户。需要指定目标或覆盖 context token：

```bash
wechat-acp-codex inject --to last-active-user --context-token <token> --text "继续刚才的任务"
```

如果 daemon 当前未运行，消息会留在队列里，等同一 storage 实例的 daemon 启动后再处理。

## 运行多个实例

默认运行时文件保存在 `~/.wechat-acp-codex/`，也就是默认只有一个 bridge。传入 `--instance <name>` 后，运行时文件会保存到 `~/.wechat-acp-codex/instances/<name>/`，从而可以并排运行多个 bridge。

```bash
wechat-acp-codex --instance projA --cwd ~/code/repo-a --allow-first --daemon
wechat-acp-codex --instance projB --cwd ~/code/repo-b --allow-first --daemon
```

每个实例都有自己的微信登录 token、owner、项目目录、daemon pid/log、同步状态、inbox 和 inject 队列。通常并排运行多个实例也需要多个微信账号。

实例相关子命令也要带同一个 `--instance`：

```bash
wechat-acp-codex status --instance projA
wechat-acp-codex stop --instance projB
wechat-acp-codex owner show --instance projA
wechat-acp-codex inject --instance projA --text "检查今天的计划"
```

## 配置文件

使用 `--config <file>` 读取 JSON 配置。CLI 参数会覆盖对应配置。注意：配置文件里的 `session.idleTimeoutMs` 使用毫秒，CLI 的 `--idle-timeout` 使用分钟。

```json
{
  "agent": {
    "preset": "codex",
    "cwd": "/Users/me/code/my-project",
    "showThoughts": false,
    "showDiffs": false,
    "stripMarkdown": true
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10
  },
  "commandAliases": {
    "/acp-cancel": ["/cancel", "取消"]
  }
}
```

常用 CLI 参数通常已经够用；配置文件更适合固定 agent、目录、命令别名或运行时路径。

## CLI 参考

```text
wechat-acp-codex [options]
wechat-acp-codex agents
wechat-acp-codex owner show
wechat-acp-codex owner clear
wechat-acp-codex inject --text <text>
wechat-acp-codex inject --file <path>
wechat-acp-codex stop
wechat-acp-codex status
```

### 选项

| 参数 | 说明 |
|---|---|
| `--agent <value>` | 内置 preset 名称或原始 agent 命令；默认 `codex` |
| `--cwd <dir>` | agent 工作目录；默认当前目录 |
| `--owner <user-id>` | 启动时绑定指定微信 user id 为 owner |
| `--allow-first` | 无 owner 时，把第一个给 bot 发消息的发送者绑定为 owner |
| `--no-strip-markdown` | 不剥离 agent 回复里的 Markdown；默认会剥离 |
| `--login` | 强制重新扫码登录；不会清除 owner |
| `--daemon` | 后台运行 daemon |
| `--config <file>` | 读取 JSON 配置文件 |
| `--instance <name>` | 以命名实例运行 |
| `--idle-timeout <m>` | session 空闲超时时间，单位分钟；默认 `1440`，传 `0` 表示不限时 |
| `--max-sessions <n>` | 最大并发用户 session 数；默认 `10` |
| `--inbox-dir <path>` | 保存微信二进制文件的目录；默认 `<storage.dir>/inbox` |
| `--no-inbox` | 不保存微信二进制文件，agent 只会看到文件大小提示 |
| `--show-thoughts` | 把 agent thinking 转发到微信；默认隐藏 |
| `--hide-thoughts` | 不把 agent thinking 转发到微信；用于覆盖配置文件 |
| `--show-diffs` | 把 ACP 文件 diff 转发到微信；默认隐藏 |
| `-v, --verbose` | 输出详细日志 |
| `-V, --version` | 打印版本号并退出 |
| `-h, --help` | 显示帮助 |

### 子命令

| 命令 | 说明 |
|---|---|
| `agents` | 列出内置 agent presets |
| `owner show` | 打印当前绑定的 owner 微信 user id |
| `owner clear` | 清除当前 owner，回到可重新绑定状态 |
| `inject --text <text>` | 向 daemon 注入一条本地文本消息 |
| `inject --file <path>` | 从本地文件读取注入消息文本 |
| `inject --to <target>` | 指定注入目标；默认 `last-active-user` |
| `inject --context-token <t>` | 覆盖注入消息使用的 context token |
| `stop` | 停止正在运行的 daemon |
| `status` | 查看 daemon 运行状态 |

## 存储位置

默认存储目录：

```text
~/.wechat-acp-codex/
```

命名实例存储目录：

```text
~/.wechat-acp-codex/instances/<name>/
```

目录里会包含：

- 微信登录 token
- daemon pid 文件和日志
- 单实例锁文件 `wechat.lock`
- `owner.json`：当前 owner 绑定
- `state.json`：本地注入使用的最近活跃用户和 context token
- `inbox/`：从微信收到的二进制文件
- `inject/`：本地注入消息队列
- 同步状态文件

不要提交这些运行时文件，也不要提交包含 token 或 owner id 的本地配置。

## 预览版

稳定版使用 `@latest`：

```bash
npx -y wechat-acp-codex@latest --allow-first
```

预览版发布在 `@next`：

```bash
npx -y wechat-acp-codex@next --allow-first
```

`@next` 适合提前试用主分支上的修复；生产环境建议继续使用 `@latest`。

## 当前限制

- 只处理私聊；群聊会被忽略
- bridge 自身不使用 MCP server；底层 agent 是否使用 MCP 取决于 agent 自己的配置
- agent 权限请求会被自动允许，请只在你信任的项目目录中运行
- 与 agent 的通信只通过子进程 stdio
- 部分 agent preset 需要单独完成认证
- 回复仍是纯文本；暂不支持向微信发送媒体文件

## 开发

```bash
npm install
npm run build
npm test
node dist/bin/wechat-acp-codex.js --help
```

监听 TypeScript 编译：

```bash
npm run dev
```

## 遥测

`wechat-acp-codex` 不采集遥测数据。上游项目中的用量采集逻辑已经移除。

## License

MIT
