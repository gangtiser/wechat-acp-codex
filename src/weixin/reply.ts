/**
 * Outbound reply pipeline: per-user send serialization, segment splitting
 * with idempotent retries, send pacing, and typing indicators.
 *
 * Extracted from WeChatAcpBridge so delivery behavior lives (and can be
 * tested) in one place; the bridge only wires it up.
 */

import crypto from "node:crypto";
import { sendTextMessage, splitText, deliveryResult, type DeliveryResult } from "./send.js";
import { sendTyping, getConfig } from "./api.js";
import { TypingStatus } from "./types.js";
import { trackEvent, trackException, hashUserId } from "../telemetry/index.js";

const TEXT_CHUNK_LIMIT = 4000;
const SEGMENT_SEND_MAX_ATTEMPTS = 3;
const SEGMENT_SEND_RETRY_BASE_MS = 300;
const TYPING_TICKET_TTL_MS = 24 * 60 * 60_000;

/**
 * Minimum spacing between two consecutive outbound text messages to the
 * same user. Each reply segment is an independent iLink API call with no
 * ordering hint, and WeChat appears to order back-to-back bot messages by
 * server-receive time. Without spacing, near-simultaneous sends can race
 * and be delivered to the user out of order (see issue #38). A short delay
 * separates their server-side timestamps and preserves order.
 */
const REPLY_SEND_SPACING_MS = 150;

export interface ReplyAuth {
  baseUrl: string;
  token?: string;
}

export class ReplyPipeline {
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  // Timestamp (ms) at which the last text message was issued to each user,
  // used to pace consecutive sends so they don't race and arrive reordered.
  private lastSendAt = new Map<string, number>();
  // Per-user promise chain serializing replies so concurrent send calls
  // (e.g. a command reply racing an active session flush) cannot interleave
  // their segments and arrive out of order (issue #38).
  private sendChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: {
      /** Resolved lazily per send — login completes after construction. */
      auth: () => ReplyAuth;
      log: (msg: string) => void;
    },
  ) {}

  async send(userId: string, contextToken: string, text: string): Promise<DeliveryResult> {
    // The stored chain link swallows errors so one failed reply doesn't break
    // the chain for the next caller, while the returned promise still
    // propagates.
    const previous = this.sendChains.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.deliver(userId, contextToken, text));
    this.sendChains.set(
      userId,
      current.catch(() => {}),
    );
    return current;
  }

  async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;

      const auth = this.opts.auth();
      await sendTyping({
        baseUrl: auth.baseUrl,
        token: auth.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // Typing is best-effort
    }
  }

  /** Never throws — failures are reported via DeliveryResult.allSent. */
  private async deliver(userId: string, contextToken: string, text: string): Promise<DeliveryResult> {
    const auth = this.opts.auth();
    const segments = splitText(text, TEXT_CHUNK_LIMIT);
    const startedAt = Date.now();
    let segmentsSent = 0;
    let anyFailed = false;

    for (const segment of segments) {
      // Generate one stable idempotency key per segment *before* the retry
      // loop so that all attempts for the same segment reuse the same
      // client_id. The iLink gateway de-duplicates by client_id, so a retry
      // after a transient hard error (connection reset, 5xx) will not produce
      // a duplicate message even if the first attempt was already received.
      const segmentClientId = `wechat-acp-codex-${crypto.randomUUID()}`;
      let sent = false;

      for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
        try {
          await this.paceConsecutiveSend(userId);
          await sendTextMessage(
            userId,
            segment,
            {
              baseUrl: auth.baseUrl,
              token: auth.token,
              contextToken,
            },
            segmentClientId,
          );
          sent = true;
          break;
        } catch (err) {
          trackException(err, "reply.segment", hashUserId(userId));
          if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
          }
        }
      }

      if (sent) {
        segmentsSent++;
      } else {
        // Log the drop but continue — a single failed segment must not
        // prevent the remaining segments from being delivered.
        anyFailed = true;
      }
    }

    if (anyFailed) {
      trackException(
        new Error(
          `deliverReply: ${segments.length - segmentsSent}/${segments.length} segment(s) failed to send after retries`,
        ),
        "reply",
        hashUserId(userId),
      );
    }

    trackEvent(
      "reply.sent",
      {
        userIdHash: hashUserId(userId),
        segments: segments.length,
        segmentsSent,
        chars: text.length,
        durationMs: Date.now() - startedAt,
      },
      hashUserId(userId),
    );

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});

    return deliveryResult(segments.length, segmentsSent);
  }

  /**
   * Wait, if necessary, so that consecutive text messages to the same user
   * are issued at least {@link REPLY_SEND_SPACING_MS} apart. This spaces
   * out their server-receive timestamps so WeChat preserves the order the
   * bridge sent them in, instead of racing and delivering them reversed
   * (issue #38). Sends to different users are tracked independently and do
   * not delay each other.
   */
  private async paceConsecutiveSend(userId: string): Promise<void> {
    const last = this.lastSendAt.get(userId);
    const now = Date.now();
    if (last !== undefined) {
      const wait = REPLY_SEND_SPACING_MS - (now - last);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    this.lastSendAt.set(userId, Date.now());
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    const auth = this.opts.auth();
    await sendTyping({
      baseUrl: auth.baseUrl,
      token: auth.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;

    try {
      const auth = this.opts.auth();
      const resp = await getConfig({
        baseUrl: auth.baseUrl,
        token: auth.token,
        ilinkUserId: userId,
        contextToken,
      });

      if (resp.typing_ticket) {
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
        });
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }
}
