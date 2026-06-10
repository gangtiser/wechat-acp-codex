/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";
import type { DeliveryResult } from "../weixin/send.js";

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<DeliveryResult>;
  onMessageFlush: (text: string) => Promise<DeliveryResult>;
  onConfigOptionsUpdate?: (configOptions: acp.SessionConfigOption[]) => void;
  log: (msg: string) => void;
  showThoughts: boolean;
  showDiffs?: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private producedMessageThisTurn = false;
  // Promise chain serializing onMessageFlush calls so concurrent boundary events
  // cannot interleave sends (e.g. chunk B reaching WeChat before chunk A).
  private messageFlushChain: Promise<void> = Promise.resolve();
  private static readonly TYPING_INTERVAL_MS = 5_000;

  /** Whether the agent emitted any non-empty message content during the current turn. */
  get hasProducedMessage(): boolean {
    return this.producedMessageThisTurn;
  }

  /** Reset per-turn delivery state. Call at the start of each prompt. */
  newTurn(): void {
    this.producedMessageThisTurn = false;
  }

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(callbacks: {
    sendTyping: () => Promise<void>;
    onThoughtFlush: (text: string) => Promise<DeliveryResult>;
    onMessageFlush: (text: string) => Promise<DeliveryResult>;
  }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
      onMessageFlush: callbacks.onMessageFlush,
    };
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option
    const allowOpt = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.maybeFlushThoughts();
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
          if (update.content.text.trim()) {
            this.producedMessageThisTurn = true;
          }
        }
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.maybeFlushThoughts();
        await this.maybeFlushMessage();
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        await this.maybeFlushMessage();
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (update.status === "completed" && update.content) {
          for (const c of update.content) {
            if (c.type === "diff") {
              if (this.opts.showDiffs === false) {
                continue;
              }
              const diff = c as acp.Diff;
              const header = `--- ${diff.path}`;
              const lines: string[] = [header];
              if (diff.oldText != null) {
                for (const l of diff.oldText.split("\n")) lines.push(`- ${l}`);
              }
              if (diff.newText != null) {
                for (const l of diff.newText.split("\n")) lines.push(`+ ${l}`);
              }
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
              this.producedMessageThisTurn = true;
            }
          }
        }
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        await this.maybeSendTyping();
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        await this.maybeSendTyping();
        break;

      case "config_option_update":
        this.opts.onConfigOptionsUpdate?.(update.configOptions);
        this.opts.log(`[config] ${update.configOptions.length} option(s) updated`);
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    await this.maybeFlushThoughts();
    // Drain any in-flight sends (queued by maybeFlushMessage) before reading
    // the buffer so a retried-and-restored flush cannot race with this read.
    await this.messageFlushChain.catch(() => {});
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (!thoughtText.trim()) return;
    try {
      const r = await this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`);
      if (!r.allSent) {
        this.opts.log(`[flush] thought delivered ${r.sent}/${r.total} segment(s)`);
      }
    } catch (err) {
      // Thoughts are decoration — drop on failure, never break the turn.
      this.opts.log(`[flush] dropping ${thoughtText.length} chars of thought: ${String(err)}`);
    }
  }

  /**
   * Stream the buffered agent message (and any embedded diffs) as its own
   * WeChat reply. Called at thought/tool_call boundaries so multi-step turns
   * surface narrative segments in order; the final segment is still returned
   * by `flush()` so the caller can append stop-reason suffixes.
   */
  private async maybeFlushMessage(): Promise<void> {
    if (this.chunks.length === 0) return;
    const text = this.chunks.join("");
    if (!text.trim()) {
      this.chunks = [];
      return;
    }
    // Clear the buffer synchronously BEFORE awaiting so that any concurrent
    // sessionUpdate calls (the ACP SDK fires notifications without awaiting
    // handlers) see an empty buffer and skip the flush instead of re-sending
    // the same text. New chunks arriving during the send are appended to the
    // now-empty array and flushed at the next boundary.
    this.chunks = [];

    // Acquire a send slot using a simple mutex chain: each caller saves the
    // current tail of the chain, replaces it with a new unresolved promise,
    // and awaits the old tail before sending. This guarantees strict FIFO
    // ordering — chunk A always reaches WeChat before chunk B even when both
    // boundary events fire nearly simultaneously.
    const prev = this.messageFlushChain;
    let resolve!: () => void;
    this.messageFlushChain = new Promise<void>((r) => {
      resolve = r;
    });
    await prev.catch(() => {});

    try {
      // No retry layer here: per-segment retries (with a stable client_id)
      // already live inside deliverReply, and its failures are reported via
      // DeliveryResult instead of a throw.
      const r = await this.opts.onMessageFlush(text);
      if (!r.allSent) {
        // Partial delivery: the segments that DID send must not be re-sent
        // (re-sending the whole text would duplicate them), so don't restore
        // the buffer — the unacked turn is replayed from the inbox instead.
        this.opts.log(
          `[flush] message delivered ${r.sent}/${r.total} segment(s); relying on inbox replay`,
        );
      }
    } catch (err) {
      // The send callback threw (nothing delivered). Prepend the text back so
      // the final flush() returns it and session.ts re-attempts via onReply.
      // New chunks appended during the failed send are preserved after the
      // restored text.
      this.chunks = [text, ...this.chunks];
      this.opts.log(`[flush] message send threw; retaining ${text.length} chars for final flush: ${String(err)}`);
    } finally {
      resolve();
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
