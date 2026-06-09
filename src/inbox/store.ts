import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WeixinMessage } from "../weixin/types.js";
import type { InboxRecord } from "./types.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const MAX_ATTEMPTS = 3;

export function queueDir(storageDir: string): string {
  return path.join(storageDir, "queue");
}
function pendingDir(storageDir: string): string {
  return path.join(queueDir(storageDir), "pending");
}
function failedDir(storageDir: string): string {
  return path.join(queueDir(storageDir), "failed");
}

/** Stable id for an inbound message: message_id ?? seq ?? hash(from+ctime+content). */
export function inboxKey(msg: WeixinMessage): string {
  if (msg.message_id != null) return `m${msg.message_id}`;
  if (msg.seq != null) return `s${msg.seq}`;
  const basis = `${msg.from_user_id ?? ""}|${msg.create_time_ms ?? ""}|${JSON.stringify(msg.item_list ?? [])}`;
  return `h${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

async function ensureDirs(storageDir: string): Promise<void> {
  for (const d of [queueDir(storageDir), pendingDir(storageDir), failedDir(storageDir)]) {
    await fs.mkdir(d, { recursive: true, mode: DIR_MODE });
    await fs.chmod(d, DIR_MODE).catch(() => {});
  }
}

/** Atomically persist a pending inbox record (overwrites if same id). */
export async function writePending(storageDir: string, record: InboxRecord): Promise<void> {
  await ensureDirs(storageDir);
  const dir = pendingDir(storageDir);
  const tmp = path.join(dir, `.${record.id}.tmp`);
  const dst = path.join(dir, `${record.id}.json`);
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf-8", mode: FILE_MODE });
  await fs.rename(tmp, dst);
}

/** Remove a pending record (ack). Safe if already gone. */
export async function ackPending(storageDir: string, id: string): Promise<void> {
  await fs.rm(path.join(pendingDir(storageDir), `${id}.json`), { force: true });
}

/** Ack iff ok; on !ok leave it pending (replayed with an attempt bump next start). */
export async function settleInbox(storageDir: string, id: string, ok: boolean): Promise<void> {
  if (ok) await ackPending(storageDir, id);
}

/** All pending records, oldest first (by ts). Skips corrupt files. */
export async function listPending(storageDir: string): Promise<InboxRecord[]> {
  const dir = pendingDir(storageDir);
  const files = await fs.readdir(dir).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw e;
  });
  const out: InboxRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")) as InboxRecord);
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Move a pending record to failed/ ATOMICALLY (#14): write the failed/ tombstone
 * via tmp+rename, and only THEN delete the pending source. If the tombstone write
 * fails it throws WITHOUT deleting pending — the record must never end up in
 * NEITHER dir, because the failed/ tombstone gates dedup on restart (#12) and
 * losing it could reset the poison cap.
 */
export async function failPending(storageDir: string, id: string, reason: string): Promise<void> {
  await ensureDirs(storageDir);
  const src = path.join(pendingDir(storageDir), `${id}.json`);
  const raw = await fs.readFile(src, "utf-8").catch(() => "");
  const tmp = path.join(failedDir(storageDir), `.${id}.tmp`);
  const dst = path.join(failedDir(storageDir), `${id}.json`);
  await fs.writeFile(
    tmp,
    JSON.stringify({ failedAt: new Date().toISOString(), reason, record: raw }, null, 2) + "\n",
    { encoding: "utf-8", mode: FILE_MODE },
  );
  await fs.rename(tmp, dst); // tombstone durable BEFORE deleting the pending source
  await fs.rm(src, { force: true });
}

/**
 * Prepare a pending record for a replay attempt: if it has already used up
 * maxAttempts, move it to failed/ and return null; otherwise increment attempts,
 * persist, and return the bumped record.
 */
export async function bumpForReplay(
  storageDir: string,
  record: InboxRecord,
  maxAttempts = MAX_ATTEMPTS,
): Promise<InboxRecord | null> {
  if (record.attempts >= maxAttempts) {
    await failPending(storageDir, record.id, `exceeded ${maxAttempts} attempts`);
    return null;
  }
  const bumped = { ...record, attempts: record.attempts + 1 };
  await writePending(storageDir, bumped);
  return bumped;
}

/** Ids of records already moved to failed/ (basename without `.json`). Empty if none. */
export async function listFailedIds(storageDir: string): Promise<string[]> {
  const files = await fs.readdir(failedDir(storageDir)).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw e;
  });
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
}
