import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOOL = "wechat-acp-codex";

export interface LockInfo {
  pid: number;
  startedAt?: string;
  tool?: string;
  storageDir?: string;
  instance?: string;
}

export function readLock(lockPath: string): LockInfo | null {
  try { return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockInfo; } catch { return null; }
}

/** Liveness probe (treat EPERM as alive; ESRCH as dead). Never reports self. */
export function isAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Best-effort: does the live pid look like our tool? Used to avoid killing a reused pid. */
export function isOurProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    return cmd.includes(TOOL);
  } catch { return false; }
}

export type LockAction = "stale" | "takeover" | "refuse";

/** Pure decision: what to do about an existing lock. Takeover requires BOTH ps
 * confirmation (ours) AND matching metadata, so a stale lock file claiming
 * tool:"wechat-acp-codex" over a reused PID cannot make us kill an unrelated process. */
export function classifyExistingLock(input: {
  info: LockInfo; alive: boolean; ours: boolean; storageDir: string;
}): LockAction {
  if (!input.alive) return "stale";
  const sameTool = input.info.tool === TOOL;
  const sameStore = input.info.storageDir === input.storageDir;
  if (input.ours && sameTool && sameStore) return "takeover";
  return "refuse";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function terminate(pid: number): Promise<boolean> {
  for (const [sig, waitMs] of [["SIGTERM", 3000], ["SIGKILL", 1000]] as const) {
    try { process.kill(pid, sig); } catch (e: any) { return e?.code === "ESRCH"; }
    const deadline = Date.now() + waitMs;
    while (isAlive(pid) && Date.now() < deadline) await sleep(100);
    if (!isAlive(pid)) return true;
  }
  return false;
}

/**
 * Acquire the single-instance lock with verified takeover. Latest launcher wins,
 * but we only SIGTERM a live holder verifiably our tool on the same storage dir.
 * A live but unverifiable holder (possible pid reuse) is left alone and we refuse
 * to start — never kill the wrong process, never run two pollers on one account.
 */
export async function acquireLock(opts: {
  lockPath: string; storageDir: string; instance?: string; log: (m: string) => void;
}): Promise<boolean> {
  // Create the storage dir first: on a fresh install the lock is acquired before
  // login/bridge.start() creates ~/.wechat-acp-codex, so openSync would ENOENT.
  fs.mkdirSync(path.dirname(opts.lockPath), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), tool: TOOL,
    storageDir: opts.storageDir, instance: opts.instance,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(opts.lockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const info = readLock(opts.lockPath) ?? { pid: 0 };
      const alive = isAlive(info.pid);
      const ours = alive ? isOurProcess(info.pid) : false;
      const action = classifyExistingLock({ info, alive, ours, storageDir: opts.storageDir });
      if (action === "refuse") {
        opts.log(`Refusing to start: lock held by pid=${info.pid}, not a verifiable wechat-acp-codex instance for this storage. If it is a dead instance, remove ${opts.lockPath} and retry.`);
        return false;
      }
      if (action === "takeover") {
        opts.log(`Taking over running instance (pid=${info.pid})`);
        if (!(await terminate(info.pid))) {
          opts.log(`Could not terminate old instance (pid=${info.pid}); aborting to avoid double-poll.`);
          return false;
        }
      } else {
        opts.log(`Taking over stale lock (pid=${info.pid})`);
      }
      try { fs.rmSync(opts.lockPath, { force: true }); } catch { /* retry */ }
    }
  }
  return false;
}

/** Release the lock only if we still hold it. */
export function releaseLock(lockPath: string): void {
  try {
    const cur = readLock(lockPath);
    if (cur?.pid === process.pid) fs.rmSync(lockPath, { force: true });
  } catch { /* ignore */ }
}
