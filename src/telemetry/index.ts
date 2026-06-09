/**
 * Telemetry is disabled in wechat-acp-codex. These are no-op stubs that keep the
 * public surface stable so call sites do not change. No network, no Azure,
 * no applicationinsights dependency. hashUserId remains a pure local hash in
 * case any non-telemetry caller relies on it.
 */
import crypto from "node:crypto";

export type EventName =
  | "app.start" | "app.stop" | "login.success" | "login.failure"
  | "token.reused" | "message.received" | "message.injected"
  | "command.acp_config.view" | "command.acp_config.set" | "command.acp_cancel"
  | "command.buffer_start" | "command.buffer_done" | "session.created"
  | "prompt.completed" | "reply.sent";

type PropValue = string | number | boolean;

export function initTelemetry(_opts: {
  version: string; storageDir: string; agentPreset?: string; daemon?: boolean;
}): void {
  /* no-op */
}

export function trackEvent(_name: EventName, _props?: Record<string, PropValue>, _sessionId?: string): void {
  /* no-op */
}

export function trackException(_err: unknown, _area: string, _sessionId?: string): void {
  /* no-op */
}

export function hashUserId(userId: string): string {
  if (!userId) return "";
  return crypto.createHash("sha256").update("wechat-acp-codex").update(userId).digest("hex").slice(0, 16);
}

export async function shutdownTelemetry(): Promise<void> {
  /* no-op */
}
