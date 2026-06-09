# wechat-acp-codex

把微信私聊消息桥接到当前目录里的 [Codex](https://github.com/openai/codex) agent。

`wechat-acp-codex` 是 [wechat-acp](https://github.com/formulahendry/wechat-acp) 的 Codex 定制版。它通过微信 iLink Bot API 扫码登录，轮询收到的私聊消息，把消息转发给运行在项目目录中的 Codex agent（或其他兼容 ACP 的 agent），再把 agent 回复发回微信。

## 功能特点

- 终端渲染微信扫码登录二维码
- 默认使用 `codex` preset；在项目目录里直接运行即可
- Owner 白名单：只有一个微信账号能驱动 bot，其他发送者会被静默忽略
- 单实例接管：同一微信账号只保留最新启动的 bridge，旧进程会退出
- 默认剥离 agent 回复中的 Markdown，让微信消息更干净
- 每个会话独立 ACP agent session
- 自动允许 agent 的权限请求
- 只处理私聊；群聊会被忽略
- 支持后台 daemon 模式
- 支持接收微信文件并把本地路径交给 agent
- 支持本地注入消息，适合 cron、launchd 等自动化场景
- 不采集遥测数据

## 环境要求

- Node.js 20+
- 可使用 iLink Bot API 的微信环境
- 本地已安装 Codex，或其他兼容 ACP 的 agent

## 快速开始

在你的 Codex 项目目录中运行。无需传 `--agent`，默认就是 `codex`；`--cwd` 默认是启动命令时所在的目录。

```bash
npx -y wechat-acp-codex@latest --allow-first
```

首次启动时，bridge 会：

1. 发起微信二维码登录
2. 在终端打印二维码
3. 把登录 token 保存到 `~/.wechat-acp-codex`
4. 开始轮询微信私聊消息

因为传入了 `--allow-first`，第一个给 bot 发消息的微信账号会被绑定为 owner。请用你自己的微信先发一条消息；绑定完成后，只有这个账号会被处理，其他发送者会被静默忽略。

之后如需重新绑定 owner：

```bash
wechat-acp-codex owner clear   # 清除当前 owner
wechat-acp-codex owner show    # 查看当前 owner id
```

## 单实例接管

同一个微信账号同一时间只会有一个 live bridge。你在另一个项目目录里再次启动 `wechat-acp-codex` 时，新进程会接管这个微信账号，旧进程会自动退出。

这意味着：你在微信里对话的项目，始终是最后一次启动 `wechat-acp-codex` 的项目目录。

## 可选：`codex wechat` 快捷入口

`wechat-acp-codex` 是独立命令。如果希望用 `codex wechat` 调用它，可以在 `~/.zshrc` 或 `~/.bashrc` 里添加 shell 函数：

```sh
codex() { if [ "$1" = wechat ]; then shift; command wechat-acp-codex "$@"; else command codex "$@"; fi }
```

之后 `codex wechat` 会运行 `wechat-acp-codex`，其他 `codex ...` 命令仍会透传给真正的 Codex CLI。

这里不提供自动安装脚本。Codex 本身不能挂载第三方子命令，手动 shell alias 是最干净的兼容方式。

## CLI 参考

```text
wechat-acp-codex [options]
wechat-acp-codex agents
wechat-acp-codex owner show
wechat-acp-codex owner clear
wechat-acp-codex inject --text <text>
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
| `--daemon` | 登录后在后台运行 |
| `--config <file>` | 读取 JSON 配置文件 |
| `--instance <name>` | 以命名实例运行；见“运行多个实例” |
| `--idle-timeout <m>` | session 空闲超时时间，单位分钟；默认 `1440`，传 `0` 表示不限时 |
| `--max-sessions <n>` | 最大并发用户 session 数；默认 `10` |
| `--inbox-dir <path>` | 保存微信二进制文件的目录；默认 `<storage.dir>/inbox` |
| `--no-inbox` | 不保存微信二进制文件，agent 只会看到文件大小提示 |
| `--hide-thoughts` | 不把 agent thinking 转发到微信；默认转发 |
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
| `inject --text <text>` | 向正在运行的 daemon 注入一条本地文本消息 |
| `inject --file <path>` | 从本地文件读取注入消息文本 |
| `inject --to <target>` | 指定注入目标；默认 `last-active-user` |
| `inject --context-token <t>` | 覆盖注入消息使用的 context token |
| `stop` | 停止正在运行的 daemon |
| `status` | 查看 daemon 运行状态 |

### 示例

```bash
# 在当前项目目录用 Codex 运行（默认）
npx -y wechat-acp-codex@latest --allow-first

# 指定项目目录
npx -y wechat-acp-codex@latest --cwd ~/code/my-project --allow-first

# 使用其他 agent preset
npx -y wechat-acp-codex@latest --agent claude --allow-first

# 后台运行
npx -y wechat-acp-codex@latest --daemon --allow-first

# 使用原始 agent 命令
npx -y wechat-acp-codex@latest --agent "npx my-agent --acp"
```

## 微信内命令

把下面这些内容作为普通微信消息发送给 bot，即可控制当前 agent session。

| 消息 | 效果 |
|---|---|
| `/acp-cancel` | 取消正在执行的 agent turn；`/acp-cancel all` 还会丢弃排队中的后续消息 |
| `/acp-prompt-start` ... `/acp-prompt-done` | 组合多段 prompt：先发 `/acp-prompt-start`，再发送多条文本、图片或文件，最后发 `/acp-prompt-done` 一次性提交 |
| `/acp-config` | 查看并调整当前 ACP session 暴露的配置项 |

可以通过 `--config` 指定 JSON 配置文件，用 `commandAliases` 给这些命令设置别名：

```json
{
  "commandAliases": {
    "/acp-cancel": ["/cancel", "取消"]
  }
}
```

不带 `/` 的裸词别名只有在整条消息完全匹配时才会触发，适合微信语音转文字。

## 内置 Agent Presets

```bash
npx wechat-acp-codex agents
```

当前内置 presets：

```text
codex, claude, copilot, gemini, qwen, opencode, openclaw, kiro, hermes, kimi, pi
```

## 运行多个实例

默认情况下，运行时文件都保存在 `~/.wechat-acp-codex/`，也就是一台机器默认只有一个 bridge。传入 `--instance <name>` 后，所有运行时文件会放到 `~/.wechat-acp-codex/instances/<name>/`，从而可以并排运行多个 bridge。每个实例都有自己的微信账号、项目目录、登录 token、daemon pid/log 和同步状态。

```bash
# Terminal 1
npx -y wechat-acp-codex@latest --instance projA --cwd ~/code/repo-a --allow-first

# Terminal 2
npx -y wechat-acp-codex@latest --instance projB --cwd ~/code/repo-b --allow-first
```

`stop`、`status`、`owner`、`inject` 子命令都会识别 `--instance`：

```bash
npx -y wechat-acp-codex@latest status --instance projA
npx -y wechat-acp-codex@latest stop   --instance projB
npx -y wechat-acp-codex@latest owner show --instance projA
```

## 存储位置

运行时文件保存在 `~/.wechat-acp-codex/`。使用 `--instance` 时，文件会保存在 `~/.wechat-acp-codex/instances/<name>/`。

- 微信登录 token
- daemon pid 文件和日志
- 单实例锁文件
- 同步状态
- `owner.json`：当前 owner 绑定
- `inbox/`：从微信收到的二进制文件
- `state.json`：本地注入使用的最近活跃用户和 context token
- `inject/`：本地注入消息队列

## 接收文件

当微信用户发送二进制文件时，`wechat-acp-codex` 会从微信 CDN 下载并解密文件，保存到本地磁盘。agent 会在 prompt 里收到文件的绝对路径，因此可以直接读取：

```text
[Received file: report.pdf (484067 bytes) — saved to: /Users/me/.wechat-acp-codex/inbox/2026-05-21T09-29-12-492Z-report.pdf]
```

使用 `--inbox-dir <path>` 可以改保存目录；使用 `--no-inbox` 可以完全关闭文件保存。

文本文件（如 `.md`、`.json`、源码）和图片会直接嵌入 prompt，不需要写入磁盘。

## 本地注入消息

`wechat-acp-codex inject` 会给正在运行的 daemon 排入一条本地消息。它适合 cron、launchd 或其他自动化任务：

```bash
npx wechat-acp-codex inject --text "今日 AI 资讯"
```

如果 daemon 当前未运行，消息会留在队列里，等 daemon 启动后再处理。

## 尝试预览版

稳定版使用 `@latest`：

```bash
npx -y wechat-acp-codex@latest --allow-first
```

预览版发布在 `@next`：

```bash
npx -y wechat-acp-codex@next --allow-first
```

`@next` 适合提前试用主分支上的修复；生产环境建议继续使用 `@latest`。

## 遥测

`wechat-acp-codex` 不采集遥测数据。上游项目中的用量采集逻辑已经移除。

## 当前限制

- 只处理私聊；群聊会被忽略
- bridge 自身不使用 MCP server；底层 agent 是否使用 MCP 取决于 agent 自己的配置
- agent 权限请求会被自动允许
- 与 agent 的通信只通过子进程 stdio
- 部分 agent preset 需要单独完成认证
- 回复仍是纯文本；暂不支持向微信发送媒体文件

## 开发

```bash
npm install
npm run build
node dist/bin/wechat-acp-codex.js --help
```

监听模式：

```bash
npm run dev
```

运行测试：

```bash
npm test
```

## License

MIT
