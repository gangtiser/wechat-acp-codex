/**
 * Multi-part prompt compose buffer (/acp-prompt-start … /acp-prompt-done).
 *
 * Per-user, in-memory, with an inactivity TTL and a block cap. Buffered
 * messages are deliberately NOT inbox-protected: a crash while buffering
 * loses them (the user is warned when buffering starts).
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { WeixinMessage } from "./weixin/types.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";

const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_BLOCKS = 50;

interface BufferState {
  blocks: acp.ContentBlock[];
  contextToken: string;
  pending: Promise<void>;
  lastUpdatedAt: number;
}

export class MessageBufferManager {
  private buffers = new Map<string, BufferState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Users currently flushing their buffer (between /done and enqueue).
  // Maps userId to a promise that resolves when the flush completes, so
  // messages arriving during the flush wait for the buffered prompt to
  // enqueue first, preserving turn order.
  private flushingByUser = new Map<string, Promise<void>>();

  constructor(
    private readonly opts: {
      /** Convert one WeChat message into prompt blocks (may download media). */
      convert: (msg: WeixinMessage) => Promise<acp.ContentBlock[]>;
      /** Enqueue the composed prompt (no inboxId — buffers are not replayed). */
      enqueue: (userId: string, prompt: acp.ContentBlock[], contextToken: string) => Promise<void>;
      /** Send a user-facing notice (the bridge's sendReply). */
      notify: (userId: string, contextToken: string, text: string) => Promise<unknown>;
      /** Command names incl. alias hints, for user-facing usage strings. */
      labels: { start: string; done: string };
      log: (msg: string) => void;
    },
  ) {}

  isBuffering(userId: string): boolean {
    return this.buffers.has(userId);
  }

  /** In-flight flush for this user, if any (new messages should queue behind it). */
  flushing(userId: string): Promise<void> | undefined {
    return this.flushingByUser.get(userId);
  }

  start(userId: string, contextToken: string): void {
    const { labels } = this.opts;
    if (this.buffers.has(userId)) {
      const buffer = this.buffers.get(userId)!;
      this.opts.notify(userId, contextToken, `📝 Already in buffering mode (${buffer.blocks.length} block(s) collected). Keep sending, then ${labels.done} to submit.`).catch((err) => {
        this.opts.log(`Failed to send buffer active notice to ${userId}: ${String(err)}`);
      });
      return;
    }

    this.buffers.set(userId, { blocks: [], contextToken, pending: Promise.resolve(), lastUpdatedAt: Date.now() });
    this.resetTimer(userId);
    this.opts.log(`Buffer started for ${userId}`);
    trackEvent(
      "command.buffer_start",
      { userIdHash: hashUserId(userId) },
      hashUserId(userId),
    );
    this.opts.notify(userId, contextToken, `📝 Buffering mode started. Send your messages (text, images, files), then send ${labels.done} to submit them all at once.\n⚠️ 缓冲期间的消息不享有断点重发保护，进程中断会丢失。`).catch((err) => {
      this.opts.log(`Failed to send buffer start confirmation to ${userId}: ${String(err)}`);
    });
  }

  done(userId: string, contextToken: string): Promise<unknown> {
    const { labels } = this.opts;
    const buffer = this.buffers.get(userId);
    if (!buffer) {
      return this.opts.notify(userId, contextToken, `⚠️ Nothing buffered. Send ${labels.start} first, then send messages before ${labels.done}.`);
    }

    // Remove from map immediately so new messages during the await
    // are not appended to a stale buffer.
    const pending = buffer.pending;
    this.buffers.delete(userId);
    this.clearTimer(userId);

    // Register a flushing promise so messages arriving during the await
    // queue behind the buffered prompt, preserving turn order.
    const flushPromise = this.doFlush(userId, contextToken, buffer, pending);
    this.flushingByUser.set(userId, flushPromise);
    // The .finally() branch re-throws flushPromise rejections into a promise
    // nobody else holds — swallow them here (the caller still sees the
    // rejection via the returned flushPromise itself).
    flushPromise
      .finally(() => {
        // Only clear if this is still our flush (not a newer one)
        if (this.flushingByUser.get(userId) === flushPromise) {
          this.flushingByUser.delete(userId);
        }
      })
      .catch(() => {});
    return flushPromise;
  }

  append(msg: WeixinMessage, userId: string, contextToken: string): void {
    const { labels } = this.opts;
    const buffer = this.buffers.get(userId);
    if (!buffer) return;

    // Chain the async conversion so /acp-prompt-done waits for all in-flight appends
    buffer.pending = buffer.pending
      .then(async () => {
        // Re-check buffer still exists (could have been flushed or expired)
        if (!this.buffers.has(userId)) return;

        // Check TTL
        if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
          this.buffers.delete(userId);
          this.opts.log(`Buffer expired for ${userId}`);
          await this.opts.notify(userId, contextToken, `⚠️ Buffering timed out (10 min without activity). Please send ${labels.start} again.`);
          return;
        }

        // Check block limit
        if (buffer.blocks.length >= BUFFER_MAX_BLOCKS) {
          await this.opts.notify(userId, contextToken, `⚠️ Buffer is full (${BUFFER_MAX_BLOCKS} blocks max). Send ${labels.done} to submit what you have.`);
          return;
        }

        const prompt = await this.opts.convert(msg);
        buffer.blocks.push(...prompt);
        buffer.contextToken = contextToken;
        buffer.lastUpdatedAt = Date.now();
        this.resetTimer(userId);

        this.opts.log(`Buffered message from ${userId}, now ${buffer.blocks.length} block(s)`);
      });

    buffer.pending.catch((err) => {
      this.opts.log(`Failed to buffer message from ${userId}: ${String(err)}`);
      trackException(err, "buffer", hashUserId(userId));
    });
  }

  private async doFlush(
    userId: string,
    contextToken: string,
    buffer: BufferState,
    pending: Promise<void>,
  ): Promise<void> {
    const { labels } = this.opts;
    // Wait for any in-flight appends to finish before reading
    try {
      await pending;
    } catch {
      // A prior append failed (e.g. image download error). The chain
      // already logged/tracked the error. Clear the buffer so the user
      // can start fresh.
      await this.opts.notify(userId, contextToken, `⚠️ A buffered message failed to process. Buffer cleared. Please send ${labels.start} to try again.`);
      return;
    }

    // Check expiry
    if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
      await this.opts.notify(userId, contextToken, `⚠️ Buffer expired (10 min without activity). Please send ${labels.start} to start over.`);
      return;
    }

    if (buffer.blocks.length === 0) {
      await this.opts.notify(userId, contextToken, `⚠️ Buffer is empty. Send some messages before ${labels.done}.`);
      return;
    }

    this.opts.log(`Buffer flushed for ${userId}: ${buffer.blocks.length} block(s)`);
    trackEvent(
      "command.buffer_done",
      {
        userIdHash: hashUserId(userId),
        blockCount: buffer.blocks.length,
      },
      hashUserId(userId),
    );

    await this.opts.enqueue(userId, buffer.blocks, buffer.contextToken);
  }

  private resetTimer(userId: string): void {
    this.clearTimer(userId);
    this.timers.set(userId, setTimeout(() => {
      const buffer = this.buffers.get(userId);
      if (!buffer) return;
      this.buffers.delete(userId);
      this.timers.delete(userId);
      this.opts.log(`Buffer expired (timer) for ${userId}`);
    }, BUFFER_TTL_MS));
  }

  private clearTimer(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(userId);
    }
  }
}
