import fs from "node:fs";
import path from "node:path";

const OWNER_FILE = "owner.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ownerFile(storageDir: string): string {
  return path.join(storageDir, OWNER_FILE);
}

export function loadOwner(storageDir: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(ownerFile(storageDir), "utf-8")) as { ownerId?: string };
    return data.ownerId ?? null;
  } catch {
    return null;
  }
}

export function saveOwner(storageDir: string, ownerId: string): void {
  fs.mkdirSync(storageDir, { recursive: true, mode: DIR_MODE });
  const tmp = path.join(storageDir, `.${OWNER_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ownerId, updatedAt: new Date().toISOString() }, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, ownerFile(storageDir));
}

export function clearOwner(storageDir: string): void {
  try { fs.rmSync(ownerFile(storageDir), { force: true }); } catch { /* ignore */ }
}

export interface OwnerGateInput { storedOwner: string | null; sender: string; allowFirst: boolean; }
export interface OwnerGateResult { allowed: boolean; bind?: string; }

/**
 * Decide whether a sender may drive the agent. Owner is matched against the
 * message sender (from_user_id). With no owner bound, --allow-first binds the
 * first sender; otherwise the sender is rejected (never silent-bind).
 */
export function decideOwnerGate(input: OwnerGateInput): OwnerGateResult {
  if (input.storedOwner) return { allowed: input.sender === input.storedOwner };
  if (input.allowFirst) return { allowed: true, bind: input.sender };
  return { allowed: false };
}

/** CLI handler for `wechat-acp-codex owner <show|clear>`. Returns a process exit code. */
export function runOwnerCommand(storageDir: string, action: string | undefined, out: (m: string) => void): number {
  switch (action) {
    case "show": {
      const id = loadOwner(storageDir);
      out(id ? `owner: ${id}` : "no owner bound");
      return 0;
    }
    case "clear":
      clearOwner(storageDir);
      out("owner cleared");
      return 0;
    default:
      out("usage: wechat-acp-codex owner <show|clear>");
      return 1;
  }
}
