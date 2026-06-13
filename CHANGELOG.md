# Changelog

## 0.9.1

A hardening release: correctness, delivery, and inject-reliability fixes found in a full-codebase review. No new features and no API changes.

- Fix the startup replay path bypassing the dedup cap: it added inbox ids straight to `seenInbox` instead of the capped `markSeen()`, so a backlog larger than the 1000-id cap could grow the set unbounded and later evict still-pending ids. Replay now uses the same capped path as live messages.
- Fix a race in `/acp-cancel all`: the drain loop peeked the head of the per-user queue and `await`ed the inbox ack before shifting, so the concurrent `processQueue` loop could shift the same item mid-await and the drain would ack/drop the wrong record. The drain now takes an atomic snapshot (`splice`) of the queue; an ack failure still re-queues the un-acked tail so a stuck cursor retries it.
- Fix `maxConcurrentUsers` being exceeded: concurrent new-user enqueues all passed the size check during the `await createSession` window, and an all-busy session set evicted nothing yet still created a session. Session creation is now counted against the cap, and an unavoidable overage is logged instead of silent.
- Surface corrupt pending inbox files instead of silently skipping them: `listPending` now logs the file and renames it to `.corrupt` (so it stops being re-read every start) rather than leaving an invisible orphan.
- Fix the long-poll client timeout racing the server: `getUpdates` used the same value for the server long-poll window and the client-side socket abort, so a timeout at the boundary aborted the request and discarded the batch the server was about to return (added latency, redundant re-poll). The socket abort is now the server window plus a 10s margin.
- Invalidate the typing-ticket cache when a user's `contextToken` changes instead of reusing a ticket for the full 24h TTL (a stale ticket would make "typing…" silently stop). The cache stays bounded per user.
- Compute `X-WECHAT-UIN` once per process instead of a fresh random value per request — a UIN identifies the client, not the request.
- `parseAesKey` returns null on an unexpected key length instead of truncating to 16 bytes and decrypting media to garbage; the caller already skips media with no key.
- `requestPermission` (auto-allow) returns `cancelled` when the agent offers no options instead of replying with a fabricated `"allow"` optionId the agent never advertised.
- Inject: a finished job is deleted instead of being moved to a `done/` directory that grew without bound under cron/automation use.
- Inject (behavior change): a job left stranded in `processing/` by a crash is now parked in `failed/` rather than re-queued. Inject has no dedup, so blindly re-running it could execute the job twice; recovery is now at-most-once. A job interrupted mid-flight is no longer auto-retried — check `failed/` and re-inject if needed.
- Inject: secondary failures while moving a failed job to `failed/` are logged instead of swallowed.
- CLI: validate `--max-sessions` (reject NaN/0/negative), matching `--idle-timeout`; it was silently ignored before, falling back to the default. Value flags now reject a missing value or a value that is actually the next flag (e.g. `--agent --daemon` no longer silently swallows `--daemon`); the free-form `--text` still allows a leading dash. Fix a stale comment that described a non-existent `--no-daemon` internal flag.
- `hashUserId` no longer computes a sha256 on every telemetry call — telemetry is a disabled no-op, so the hash is unused; the no-op call surface is kept stable.

## 0.9.0

- Fix a WeChat send timeout being silently treated as success: `apiPost` mapped every `AbortError` to `{ret: 0}`, so a timed-out `sendmessage` was counted as delivered and the inbox record was acked without the reply ever reaching WeChat. The timeout→empty-batch mapping now applies only to the `getupdates` long-poll; send/typing/config timeouts throw and go through the existing per-segment retry (same `client_id`, so the gateway de-duplicates). `sendmessage` responses are also checked for an HTTP-200 business error code (`ret`/`errcode` ≠ 0) and treated as failure.
- Fix the SIGKILL fallback in `killAgent` never firing: `proc.killed` is true right after SIGTERM is *sent*, so the 5s escalation was dead code and agents that ignore SIGTERM lingered as zombies. It now checks actual exit state (`exitCode`/`signalCode`).
- Fix per-user message ordering: enqueues are now serialized per user, so a fast-converting text message can no longer overtake an earlier image/file message whose CDN download is still in flight (applies to live messages and startup replay).
- Surface enqueue failures (e.g. agent spawn error) to the user in WeChat instead of only logging — the message stays persisted and is retried on the next bridge start.
- Exit with a clear fatal error after 3 consecutive session-expired poll cycles (errcode -14, 1 hour apart) instead of retrying a dead token forever while `status` reports the daemon as running. Re-login requires `--login` + QR scan.
- `stop` now refuses to kill a PID that is not a verifiable wechat-acp-codex process (PID reuse), matching the lock takeover's safety rule.
- Save `token.json` with mode 0o600 (it was the only sensitive file without tightened permissions) and write `sync-buf.json` atomically (tmp+rename) so a crash mid-write can't reset the poll cursor.
- Cap inline text-file content at 256 KB — larger text files are saved to the inbox dir and referenced by path instead of being inlined into the prompt. Sniff the real image MIME type (png/gif/webp/jpeg) from magic bytes instead of always claiming `image/jpeg`. Don't split a surrogate pair (emoji) at the hard 4000-char segment boundary.
- Rotate the daemon log at startup when it exceeds 10 MB (keeps one `.old` generation).
- Remove the dead retry layer in `client.ts` (`sendWithRetry` retried only on throw, but delivery failures are reported via `DeliveryResult`, never thrown): partial deliveries now explicitly rely on inbox replay, a thrown send still retains the buffer for the final flush.
- Tooling: `npm test` now type-checks `tests/` first (`tsconfig.tests.json`, noEmit); add ESLint with only `no-floating-promises` + `no-misused-promises` (`npm run lint`, also in CI); enable `noUnusedLocals`.
- Refactor: split `bridge.ts` (1100+ lines) into focused modules with no behavior change — `weixin/reply.ts` (`ReplyPipeline`: per-user send serialization, segment retries, pacing, typing), `message-buffer.ts` (`MessageBufferManager`: `/acp-prompt-start…done` compose), and `acp/config-options.ts` (pure `/acp-config` formatting + value resolution, now unit-tested). The bridge keeps routing/wiring only.
- Remove the never-wired CDN upload path (`getUploadUrl`, `uploadToCdn`, `encryptAesEcb`, and the `GetUploadUrl*` types). Not part of the public package API (`src/index.ts` only exports the bridge + config helpers).
- Normalize the repo to LF line endings via `.gitattributes` (`* text=auto eol=lf`) and a one-time renormalize. Ends the upstream-CRLF era where `git diff --check` flagged every added line in CRLF files.

## 0.8.3

- Hide agent thinking by default to reduce short-burst WeChat message volume. Use `--show-thoughts` or `agent.showThoughts: true` to forward thinking messages; `--hide-thoughts` remains available to override config files.

## 0.8.0

- Hide ACP file diffs by default. Use `--show-diffs` or `agent.showDiffs: true` to forward diffs to WeChat.

## 0.7.1

- Fix intermediate WeChat messages being delivered multiple times, out of order, or losing the trailing segments. Concurrent boundary flushes now go through a per-client mutex chain; each reply segment retries with a stable `client_id` so the iLink gateway de-duplicates; and a failed segment no longer aborts the remaining segments in the same reply (#41).
- Auto-publish prereleases from `main` to the `@next` dist-tag on every push, versioned as `<base>-next.<UTC-timestamp>.<short-sha>` (where `<base>` is the next patch above `@latest`). Stable users keep using `@latest`. See README's "Trying preview builds".
- Run `npm test` in CI on every push and PR, and gate both `latest` and `next` publishes on passing tests.

## 0.7.0

- Add `/acp-prompt-start` and `/acp-prompt-done` bridge commands so users can buffer multiple WeChat messages (text + image + file, in any order) and flush them to the agent as a single prompt — works around WeChat's inability to send mixed content in one message. Buffering is per-user and held in memory, with a 10-minute inactivity TTL and a 50-block cap. Adds two telemetry events: `command.buffer_start` and `command.buffer_done` (with collected block count). Total event types: 15. See the README's "Multi-part message buffering" section.
- Add customizable aliases for bridge slash commands via the `commandAliases` config map. Map any built-in command (`/acp-config`, `/acp-cancel`, `/acp-prompt-start`, `/acp-prompt-done`) to one or more custom aliases (e.g. `{"commandAliases": {"/acp-cancel": ["/cancel", "/取消"]}}`); the original built-in names keep working as a fallback. Bare-phrase aliases (no leading `/`) match only when they equal the entire trimmed message, making WeChat voice input natural (e.g. transcribed `取消` triggers cancel). Aliases are validated at startup. See the README's "Customizing bridge command names (aliases)" section.
- Fix the final agent answer sometimes being silently dropped when a trailing thought / tool_call flushed it and the WeChat send failed transiently — the empty `catch {}` swallowed the error and left an empty buffer for the final `flush()`. `client.ts` now uses a bounded-retry `sendWithRetry()` (linear backoff + logging) and retains the buffer on message-send failure so `flush()` re-attempts via `onReply` (which surfaces failures to the user). A new `producedMessageThisTurn` flag lets the caller send a user-friendly empty-turn notice (mapped from `stopReason`) so a turn never ends with zero user-facing output. Fixes #36.
- Fix multi-segment replies sometimes arriving out of order in WeChat. Each reply segment is an independent iLink send with no ordering hint, and WeChat orders back-to-back bot messages by server-receive time, so near-simultaneous sends could race and be delivered reversed (issue #38). Replies to the same user are now serialized behind a per-user queue and spaced ~150ms apart so their server-side timestamps preserve send order. Sends to different users are unaffected.

## 0.6.0

- Add `/acp-cancel` WeChat chat command to stop the in-flight ACP prompt turn for the current user, since WeChat has no UI for it. `/acp-cancel` sends `session/cancel` (the agent's `prompt()` resolves with `stopReason: "cancelled"` and any partial output already streamed is delivered with a `[cancelled]` suffix); `/acp-cancel all` also drops any queued messages behind it. See the README's "WeChat ACP cancel command" section.
- Add one telemetry event: `command.acp_cancel` (with `drainQueue`, `cancelledTurn`, `droppedQueueCount`). Total event types: 13.
- Stream agent message segments to WeChat at `tool_call` and `agent_thought_chunk` boundaries instead of buffering the entire turn into a single reply. Multi-step turns (e.g. `thought → message → tool_call → message`) now surface each narrative segment in order, while single-shot turns still arrive as one reply. Stop-reason suffixes (`[cancelled]` / `[agent refused to continue]`) are still attached to the final segment.

## 0.5.0

- Add `/acp-config` WeChat chat command to inspect and change ACP session configuration options (`configOptions`) for the current user, without leaving WeChat. `/acp-config` lists options; `/acp-config set <configId> <value>` updates one. See the README's "WeChat ACP config command" section.
- Pass agent replies through to WeChat verbatim. The outbound formatter (`formatForWeChat`) and `src/adapter/outbound.ts` are removed; the bridge no longer strips markdown, rewrites links, or collapses blank lines from agent output.
- Add two telemetry events: `command.acp_config.view` (with `hasSession` and `optionCount`) and `command.acp_config.set` (with `configId`, `optionType`, `optionValue` — all from the agent's declared `configOptions`, never raw user input). Total event types: 12.

## 0.4.0

- Add five built-in agent presets: `openclaw`, `kiro`, `hermes`, `kimi`, and `pi`. Total bundled presets is now 11. See `wechat-acp agents` for the full list.

## 0.3.0

- Add local message injection via `wechat-acp inject`, backed by a file-based queue under `inject/` and persisted `last-active-user` targeting. This lets local automation enqueue prompts for the running daemon and have replies delivered through WeChat.

## 0.2.5

- Add `-V, --version` CLI flag that prints the version and exits, and include the version in the `--help` banner header. Useful for scripts (`$(wechat-acp --version)`) and for confirming which build is installed.

## 0.2.4

- Add `--hide-diffs` CLI flag and `agent.showDiffs` config option to suppress forwarding ACP file diffs to WeChat. Diffs are still forwarded by default.

## 0.2.3

- Downgrade `applicationinsights` from `^3.0.0` to `^2.9.6`. The v3 SDK is built on OpenTelemetry and explicitly drops support for manually setting User ID and Session ID (see its README's "Limitations" section), which caused the App Insights dashboard to show Users = 1 and Sessions = 1 even after 0.2.2's `tagOverrides` fix. v2 honors `context.tags` and per-event `tagOverrides` as documented, so `user_Id`, `session_Id`, and `application_Version` are now populated correctly. Simplified [src/telemetry/index.ts](src/telemetry/index.ts) to pin static tags once at init and keep per-event `tagOverrides` only for the dynamic session id.

## 0.2.2

- Fix anonymous telemetry so `user_Id`, `session_Id`, and `application_Version` are populated on every event. Application Insights v3 ignores the legacy `context.tags` / `commonProperties` APIs the previous code relied on, which caused the dashboard to always show Users = 1 and Sessions = 1. Each event now carries the install id as `ai.user.id`, a per-WeChat-user (or per-install for lifecycle events) `ai.session.id`, and the package version as `ai.application.ver`.

## 0.2.1

- Save received binary files to disk under `~/.wechat-acp/inbox/` so the agent can read them by absolute path instead of getting only a size notice. Customize with `--inbox-dir <path>` or `storage.inboxDir`; disable with `--no-inbox`. Default location is instance-scoped when `--instance` is used.
- Built-in `copilot` preset now passes `--enable-all-github-mcp-tools` so the agent can use the full GitHub MCP tool surface out of the box.
- Refresh WeChat typing indicator on `tool_call_update` and `plan` events so the indicator no longer lapses during long-running tool calls.

## 0.2.0

- Add `--instance <name>` to run multiple bridges side by side on one machine, each with its own WeChat account, project cwd, daemon pid/log, sync state, and telemetry id. Storage moves under `~/.wechat-acp/instances/<name>/`. Default (no `--instance`) is unchanged.

## 0.1.4

- Update `claude` preset to use `@agentclientprotocol/claude-agent-acp` (the deprecated `@zed-industries/claude-code-acp` was renamed)

## 0.1.3

- Forward agent thinking to WeChat by default; use `--hide-thoughts` to opt out (replaces `--show-thoughts`)
- Add anonymous usage telemetry via Azure Application Insights; set `WECHAT_ACP_TELEMETRY=0` to disable
- Hide Windows console windows for daemon and agent child processes

## 0.1.2

- Add `--show-thoughts` flag to forward agent thinking to WeChat (off by default)
- Stream thought messages in real-time at thought→tool and thought→message transitions
- Log all agent thought chunks to terminal for debugging

## 0.1.1

- Set default idle timeout to 1440 minutes (24 hours); use `--idle-timeout 0` for unlimited
- Send typing indicator immediately when prompt is received
- Cancel typing indicator after reply is delivered
- Add GitHub Actions CI workflow

## 0.1.0

- Initial release
- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in agent presets: copilot, claude, gemini, qwen, codex, opencode
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats ignored
- Background daemon mode with `--daemon`
- Config file support with `--config`
- Session idle timeout and max concurrent user limits
