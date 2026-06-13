/**
 * Telemetry is disabled in wechat-acp-codex. These are no-op stubs that keep the
 * public surface stable so call sites do not change. No network, no Azure,
 * no applicationinsights dependency. hashUserId returns a constant — telemetry
 * is off, so there is nothing to hash and no reason to spend a sha256 per event.
 */

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

export function hashUserId(_userId: string): string {
  // Telemetry is a no-op, so there is nothing to hash for and no reason to burn
  // a sha256 per event. Kept on the public surface so call sites don't change.
  return "";
}

export async function shutdownTelemetry(): Promise<void> {
  /* no-op */
}
