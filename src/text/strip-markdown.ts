/**
 * Strip common Markdown so WeChat (plain text only) shows clean output.
 * Ported from weixin-claude-bridge parse.ts. Regex pass, not a full parser:
 * covers the common constructs Codex emits.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => body.trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

export function maybeStrip(text: string, enabled: boolean): string {
  return enabled ? stripMarkdown(text) : text;
}
