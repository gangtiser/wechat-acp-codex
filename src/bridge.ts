/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import type { DeliveryResult } from "./weixin/send.js";
import { ReplyPipeline } from "./weixin/reply.js";
import { MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { formatConfigList, formatConfigUsage, resolveConfigValue, type ConfigCommandUsage } from "./acp/config-options.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { MessageBufferManager } from "./message-buffer.js";
import type { WeChatAcpConfig } from "./config.js";
import { BRIDGE_COMMANDS, resolveCommandAliases, resolveCommandNames } from "./config.js";
import { InjectionMonitor } from "./inject/monitor.js";
import type { InjectedMessage } from "./inject/types.js";
import { resolveUserTarget, updateLastActiveUser } from "./storage/state.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";
import { maybeStrip } from "./text/strip-markdown.js";
import { decideOwnerGate, loadOwner, saveOwner } from "./storage/owner.js";
import { inboxKey, writePending, listPending, listFailedIds, bumpForReplay, settleInbox, MAX_ATTEMPTS } from "./inbox/store.js";
import type { InboxRecord } from "./inbox/types.js";

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;

/**
 * Owner-gate a sender: returns true if allowed. When allowFirst binds a new
 * owner, persist it. Pure enough to unit-test against a temp storage dir.
 */
export function applyOwnerGate(opts: { storageDir: string; sender: string; allowFirst: boolean }): boolean {
  const decision = decideOwnerGate({
    storedOwner: loadOwner(opts.storageDir),
    sender: opts.sender,
    allowFirst: opts.allowFirst,
  });
  if (decision.bind) saveOwner(opts.storageDir, decision.bind);
  return decision.allowed;
}

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private injectionMonitor: InjectionMonitor | null = null;
  private tokenData: TokenData | null = null;
  private stateUpdate = Promise.resolve();
  // Outbound delivery: per-user ordering, segment retries, pacing, typing
  private reply: ReplyPipeline;
  // /acp-prompt-start … /acp-prompt-done multi-part compose
  private composeBuffer: MessageBufferManager;
  // Per-user promise chain serializing enqueues. Prompt conversion can take
  // seconds (media downloads), so without the chain a fast-converting text
  // message could reach the session queue ahead of an earlier image message.
  private enqueueChains = new Map<string, Promise<unknown>>();
  private seenInbox = new Set<string>();
  // Poison tombstones (ids moved to failed/). SEPARATE, UNCAPPED set so they are
  // never FIFO-evicted from seenInbox (#12) — an evicted tombstone would let a
  // re-delivered poison message be re-persisted at attempts=0 and reset the cap.
  private failedInbox = new Set<string>();
  private static readonly DEDUP_CAP = 1000;
  private log: (msg: string) => void;

  constructor(config: WeChatAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-acp-codex] ${msg}`));
    this.reply = new ReplyPipeline({
      // tokenData is set by start() before anything can send
      auth: () => ({ baseUrl: this.tokenData!.baseUrl, token: this.tokenData!.token }),
      log: (msg) => this.log(msg),
    });
    this.composeBuffer = new MessageBufferManager({
      convert: (msg) =>
        weixinMessageToPrompt(msg, this.config.wechat.cdnBaseUrl, this.log, this.config.storage.inboxDir),
      enqueue: (userId, prompt, contextToken) => this.sessionManager!.enqueue(userId, { prompt, contextToken }),
      notify: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      labels: {
        start: `${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)}`,
        done: `${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}`,
      },
      log: (msg) => this.log(msg),
    });
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 1. Login or load token
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
      if (this.tokenData) {
        trackEvent("token.reused");
      }
    }

    if (!this.tokenData) {
      const loginStart = Date.now();
      try {
        this.tokenData = await login({
          baseUrl: this.config.wechat.baseUrl,
          botType: this.config.wechat.botType,
          storageDir: this.config.storage.dir,
          log: this.log,
          renderQrUrl,
        });
        trackEvent("login.success", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
        });
      } catch (err) {
        trackException(err, "auth");
        trackEvent("login.failure", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
          errorType: err instanceof Error ? err.name : "Unknown",
        });
        throw err;
      }
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log(`Use --login to force re-login`);
    }

    if (this.config.owner?.id) {
      saveOwner(this.config.storage.dir, this.config.owner.id);
    }

    // 2. Create SessionManager
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      agentPreset: this.config.agent.preset ?? "raw",
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      showDiffs: this.config.agent.showDiffs ?? false,
      log: this.log,
      onReply: (userId, contextToken, text) =>
        this.sendReply(userId, contextToken, maybeStrip(text, this.config.agent.stripMarkdown ?? true)),
      sendTyping: (userId, contextToken) => this.reply.sendTypingIndicator(userId, contextToken),
      onTurnSettled: (inboxId, ok) => settleInbox(this.config.storage.dir, inboxId, ok),
    });
    this.sessionManager.start();

    // Replay un-acked inbox messages from a previous run (at-least-once). Seed
    // the dedup set first so the poll loop won't re-process the same ids.
    const pendingInbox = await listPending(this.config.storage.dir);
    for (const rec of pendingInbox) {
      let bumped: InboxRecord | null;
      try {
        bumped = await bumpForReplay(this.config.storage.dir, rec);
      } catch (err) {
        // bumpForReplay threw but never loses the record: at max it's failPending
        // (keeps pending if the tombstone write fails, #14); below max it's
        // writePending's attempt-bump, an atomic rename whose failure is a no-op on
        // the existing pending file. Either way keep it for a retry next start.
        // Only a POISON record (already at max) gets an in-memory failedInbox
        // tombstone, so a cursor-not-advanced re-delivery is de-duped THIS run
        // instead of re-persisting at attempts=0 and resetting the cap. A non-poison
        // bump failure is NOT tombstoned — re-persisting it fresh is correct.
        if (rec.attempts >= MAX_ATTEMPTS) this.failedInbox.add(rec.id);
        this.log(`inbox: replay of ${rec.id} could not advance, kept pending: ${String(err)}`);
        continue;
      }
      if (!bumped) {
        this.log(`inbox: ${rec.id} exceeded max attempts — moved to failed/`);
        this.sendReply(
          rec.userId, rec.contextToken,
          "⚠️ 有一条消息多次处理失败已放弃(可能因当时网络/会话问题)。如仍需要请重发。",
        ).catch(() => {}); // best-effort; contextToken may be stale
        continue;
      }
      this.seenInbox.add(rec.id);
      this.chainEnqueue(rec.userId, () =>
        this.enqueueMessage(rec.msg, rec.userId, rec.contextToken, rec.id),
      ).catch((err) => {
        this.log(`inbox replay failed for ${rec.id}: ${String(err)}`);
        trackException(err, "inbox.replay");
      });
      this.log(`inbox: replaying ${rec.id} (attempt ${bumped.attempts})`);
    }

    // Seed poison tombstones (incl. any just moved to failed/ in the loop above)
    // into the uncapped failedInbox so a re-delivered poison message whose poll
    // cursor never advanced (crash before saveSyncBuf) is de-duped instead of
    // re-persisted at attempts=0 (which would reset the cap). Runs before
    // startMonitor, so the poll loop sees these ids from the start.
    await this.seedFailedInbox();

    if (this.config.storage.injectDir && this.config.storage.stateFile) {
      this.injectionMonitor = new InjectionMonitor({
        injectDir: this.config.storage.injectDir,
        log: this.log,
        onMessage: (job) => this.enqueueInjectedMessage(job),
      });
      await this.injectionMonitor.start();
      this.log(`Injection queue: ${this.config.storage.injectDir}`);
    }

    // 3. Start monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.injectionMonitor?.stop();
    await this.sessionManager?.stop();
    await this.stateUpdate.catch((err) => {
      this.log(`Failed to flush state before stop: ${String(err)}`);
      trackException(sanitizeStateError(err), "state");
    });
    this.log("Bridge stopped");
  }

  private markSeen(id: string): void {
    this.seenInbox.add(id);
    if (this.seenInbox.size > WeChatAcpBridge.DEDUP_CAP) {
      this.seenInbox.delete(this.seenInbox.values().next().value as string);
    }
  }

  /** Load failed/ ids into the uncapped failedInbox tombstone set (H#7/#12). */
  private async seedFailedInbox(): Promise<void> {
    for (const id of await listFailedIds(this.config.storage.dir)) {
      this.failedInbox.add(id);
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const senderId = msg.from_user_id;
    const allowFirst = this.config.owner?.allowFirst ?? false;
    if (!senderId || !applyOwnerGate({ storageDir: this.config.storage.dir, sender: senderId, allowFirst })) {
      this.log(`Ignoring message from non-owner ${senderId ?? "(no id)"}`);
      return;
    }

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    const inboxId = inboxKey(msg);
    // dedup: replay + poll re-delivery (seenInbox) + poison tombstone (failedInbox, #12)
    if (this.seenInbox.has(inboxId) || this.failedInbox.has(inboxId)) return;

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);
    this.rememberActiveUser(userId, contextToken);

    trackEvent(
      "message.received",
      {
        userIdHash: hashUserId(userId),
        kind: this.messageKind(msg),
      },
      hashUserId(userId),
    );

    const acpConfigCommand = this.extractAcpConfigCommand(msg);
    if (acpConfigCommand) {
      await this.handleAcpConfigCommand(acpConfigCommand, userId, contextToken).catch((err) => {
        this.log(`Failed to handle ACP config command from ${userId}: ${String(err)}`);
        trackException(err, "command", hashUserId(userId));
      });
      this.markSeen(inboxId);
      return;
    }

    const acpCancelCommand = this.extractAcpCancelCommand(msg);
    if (acpCancelCommand) {
      // Do NOT swallow-then-markSeen (#11): the only thing that throws here is a
      // failed drop-ack (ack-before-remove, T4 S5) — sendReply never throws and
      // the cancel notification is caught internally. Rethrow so handleMessage
      // throws, applyBatch skips saveSyncBuf, and the retry re-drains the still-
      // queued tail. markSeen only on success (a clean, fully-drained cancel).
      try {
        await this.handleAcpCancelCommand(acpCancelCommand, userId, contextToken);
      } catch (err) {
        this.log(`Failed to handle ACP cancel command from ${userId}: ${String(err)}`);
        trackException(err, "command", hashUserId(userId));
        throw err;
      }
      this.markSeen(inboxId);
      return;
    }

    // /acp-prompt-start — enter buffering mode
    if (this.isBufferStartCommand(msg)) {
      this.composeBuffer.start(userId, contextToken);
      this.markSeen(inboxId);
      return;
    }

    // /acp-prompt-done — flush buffer and send to agent (best-effort per spec)
    if (this.isBufferDoneCommand(msg)) {
      this.composeBuffer.done(userId, contextToken).catch((err) => {
        this.log(`Failed to flush message buffer for ${userId}: ${String(err)}`);
        trackException(err, "buffer", hashUserId(userId));
      });
      this.markSeen(inboxId);
      return;
    }

    // If user is in buffering mode, append to buffer instead of enqueuing
    if (this.composeBuffer.isBuffering(userId)) {
      this.composeBuffer.append(msg, userId, contextToken);
      this.markSeen(inboxId);
      return;
    }

    // Normal content: persist BEFORE enqueue, then mark seen, then fire-and-forget enqueue.
    const record: InboxRecord = {
      id: inboxId, userId, contextToken, msg, ts: new Date().toISOString(), attempts: 0,
    };
    await writePending(this.config.storage.dir, record); // throws -> not seen, cursor not advanced, retried
    this.markSeen(inboxId);

    const waitForFlush = this.composeBuffer.flushing(userId);
    this.chainEnqueue(userId, async () => {
      if (waitForFlush) await waitForFlush;
      await this.enqueueMessage(msg, userId, contextToken, inboxId);
    }).catch((err) => {
      this.log(`Failed to enqueue message from ${userId}: ${String(err)}`);
      trackException(err, "enqueue", hashUserId(userId));
      // Surface the failure (e.g. agent spawn error) — the record stays
      // pending and is only retried on the next bridge start, so without a
      // notice the user would just see silence.
      this.sendReply(
        userId, contextToken,
        `⚠️ 消息处理失败：${String(err)}\n消息已保存，bridge 重启后会自动重试。`,
      ).catch(() => {});
    });
  }

  /**
   * Append a task to the per-user enqueue chain so messages enter the session
   * queue in arrival order even when an earlier message's prompt conversion
   * (media download) is still in flight. A failed task does not break the
   * chain for later messages; its rejection propagates to this call's caller.
   */
  private chainEnqueue(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.enqueueChains.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.enqueueChains.set(
      userId,
      current.catch(() => {}),
    );
    return current;
  }

  private async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
    inboxId?: string,
  ): Promise<void> {
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      this.config.storage.inboxDir,
    );

    await this.sessionManager!.enqueue(userId, { prompt, contextToken, inboxId });
  }

  private async enqueueInjectedMessage(job: InjectedMessage): Promise<void> {
    if (!this.sessionManager || !this.config.storage.stateFile) {
      throw new Error("Bridge is not ready to process injected messages");
    }

    const target = await resolveUserTarget(this.config.storage.stateFile, job.target, job.contextToken);
    const prompt: acp.ContentBlock[] = [{ type: "text", text: job.text }];
    this.log(`[inject] enqueue ${job.id} for ${target.userId}`);
    trackEvent(
      "message.injected",
      {
        userIdHash: hashUserId(target.userId),
        targetKind: job.target === "last-active-user" ? "last-active-user" : "explicit",
      },
      hashUserId(target.userId),
    );
    await this.sessionManager.enqueueAndWait(target.userId, {
      prompt,
      contextToken: target.contextToken,
    });
  }

  private async handleAcpConfigCommand(
    command: string,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length === 1) {
      const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
      trackEvent(
        "command.acp_config.view",
        {
          userIdHash: hashUserId(userId),
          hasSession: !!configOptions,
          optionCount: configOptions?.length ?? 0,
        },
        hashUserId(userId),
      );
      await this.sendReply(userId, contextToken, this.acpConfigList(userId));
      return;
    }

    if (args[1] === "set") {
      if (args.length < 4) {
        await this.sendReply(userId, contextToken, formatConfigUsage(this.configUsage(), "Missing configId or value."));
        return;
      }

      const configId = args[2]!;
      const rawValue = args.slice(3).join(" ");
      try {
        const resolved = resolveConfigValue(
          this.sessionManager?.getSessionConfigOptions(userId),
          configId,
          rawValue,
        );
        await this.sessionManager!.setSessionConfigOption(userId, configId, resolved.rawValue);
        const optionType = this.sessionManager!
          .getSessionConfigOptions(userId)
          ?.find((o) => o.id === configId)?.type;
        trackEvent(
          "command.acp_config.set",
          {
            userIdHash: hashUserId(userId),
            configId,
            optionType: optionType ?? "unknown",
            optionValue: resolved.displayValue,
          },
          hashUserId(userId),
        );
        await this.sendReply(
          userId,
          contextToken,
          `✅ Updated ACP config: ${configId} = ${resolved.displayValue}\n\n${this.acpConfigList(userId)}`,
        );
      } catch (err) {
        await this.sendReply(
          userId,
          contextToken,
          formatConfigUsage(this.configUsage(), err instanceof Error ? err.message : String(err)),
        );
      }
      return;
    }

    await this.sendReply(
      userId,
      contextToken,
      formatConfigUsage(this.configUsage(), `Unknown subcommand: ${args[1]}`),
    );
  }

  private acpConfigList(userId: string): string {
    return formatConfigList(this.sessionManager?.getSessionConfigOptions(userId), this.configUsage());
  }

  private configUsage(): ConfigCommandUsage {
    return { command: ACP_CONFIG_COMMAND, aliasHint: this.aliasHint(ACP_CONFIG_COMMAND) };
  }

  private async handleAcpCancelCommand(
    command: string,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    const sub = args[1]?.toLowerCase();

    if (sub && sub !== "all") {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage(`Unknown subcommand: ${args[1]}`));
      return;
    }

    if (!this.sessionManager) {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage("Bridge is not ready yet."));
      return;
    }

    const drainQueue = sub === "all";
    const result = await this.sessionManager.cancelCurrent(userId, { drainQueue });

    trackEvent(
      "command.acp_cancel",
      {
        userIdHash: hashUserId(userId),
        drainQueue,
        cancelledTurn: result.cancelledTurn,
        droppedQueueCount: result.droppedQueueCount,
      },
      hashUserId(userId),
    );

    await this.sendReply(userId, contextToken, this.formatAcpCancelResult(result, drainQueue));
  }

  private formatAcpCancelResult(
    result: { cancelledTurn: boolean; droppedQueueCount: number },
    drainQueue: boolean,
  ): string {
    const lines: string[] = [];
    if (result.cancelledTurn) {
      lines.push("🛑 Cancel signal sent. The current ACP turn will stop shortly.");
    } else {
      lines.push("ℹ️ No active ACP turn to cancel.");
    }
    if (drainQueue && result.droppedQueueCount > 0) {
      lines.push(`Dropped ${result.droppedQueueCount} queued message(s).`);
    }
    lines.push("");
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private formatAcpCancelUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`);
      lines.push("");
    }
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private isBufferStartCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_START_COMMAND) !== null;
  }

  private isBufferDoneCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_DONE_COMMAND) !== null;
  }

  private rememberActiveUser(userId: string, contextToken: string): void {
    if (!this.config.storage.stateFile) return;
    this.stateUpdate = this.stateUpdate
      .catch(() => {})
      .then(() => updateLastActiveUser(this.config.storage.stateFile!, userId, contextToken));
    this.stateUpdate.catch((err) => {
      this.log(`Failed to persist last active user: ${String(err)}`);
      trackException(sanitizeStateError(err), "state", hashUserId(userId));
    });
  }

  private sendReply(userId: string, contextToken: string, text: string): Promise<DeliveryResult> {
    return this.reply.send(userId, contextToken, text);
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }

  private messageKind(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1) return "text";
      if (item.type === 2) return "image";
      if (item.type === 3) return "voice";
      if (item.type === 4) return "file";
      if (item.type === 5) return "video";
    }
    return "empty";
  }

  private extractAcpConfigCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CONFIG_COMMAND);
  }

  private extractAcpCancelCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CANCEL_COMMAND);
  }

  private extractBridgeCommand(msg: WeixinMessage, canonical: string): string | null {
    const items = msg.item_list ?? [];
    if (items.length !== 1) return null;

    const item = items[0];
    if (item?.type !== 1 || !item.text_item?.text) return null;

    const text = item.text_item.text.trim();
    const names = resolveCommandNames(canonical, this.config.commandAliases);
    for (const name of names) {
      // Exact match → normalize to the canonical command with no arguments.
      // This is the only matching mode for bare-phrase aliases (no leading
      // "/"), e.g. a voice-transcribed "取消", which must match the whole
      // message to avoid false positives.
      if (text === name) return canonical;
      // Slash-prefixed names (the canonical command and "/"-style aliases)
      // also support trailing arguments. Replace the matched name with the
      // canonical command so handlers always see a single, stable token.
      if (name.startsWith("/") && text.startsWith(`${name} `)) {
        return canonical + text.slice(name.length);
      }
    }
    return null;
  }

  /**
   * Render a usage hint suffix listing any configured aliases for a
   * canonical command, e.g. " (aliases: /cancel, /取消)". Returns an
   * empty string when no aliases are configured.
   */
  private aliasHint(canonical: string): string {
    const aliases = resolveCommandAliases(canonical, this.config.commandAliases);
    return aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
  }

}

function sanitizeStateError(err: unknown): Error {
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  const sanitized = new Error(code ? `State persistence failed (${code})` : "State persistence failed");
  sanitized.name = err instanceof Error ? err.name : "Error";
  sanitized.stack = undefined;
  return sanitized;
}
