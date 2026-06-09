import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyExistingLock, acquireLock, releaseLock, readLock } from "../src/lock.js";

test("classify: dead pid -> stale", () => {
  assert.equal(classifyExistingLock({ info: { pid: 1, tool: "wechat-acp-codex", storageDir: "/d" }, alive: false, ours: true, storageDir: "/d" }), "stale");
});

test("classify: alive + ours + same tool + same storage -> takeover", () => {
  assert.equal(classifyExistingLock({ info: { pid: 2, tool: "wechat-acp-codex", storageDir: "/d" }, alive: true, ours: true, storageDir: "/d" }), "takeover");
});

test("classify: alive + ps says NOT ours -> refuse even if metadata says wechat-acp-codex (PID-reuse guard)", () => {
  assert.equal(classifyExistingLock({ info: { pid: 3, tool: "wechat-acp-codex", storageDir: "/d" }, alive: true, ours: false, storageDir: "/d" }), "refuse");
});

test("classify: alive + ours but different storage -> refuse", () => {
  assert.equal(classifyExistingLock({ info: { pid: 4, tool: "wechat-acp-codex", storageDir: "/other" }, alive: true, ours: true, storageDir: "/d" }), "refuse");
});

test("acquire over a stale (dead-pid) lock succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-lock-"));
  const lockPath = path.join(dir, "wechat.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "x", tool: "wechat-acp-codex", storageDir: dir }));
  assert.equal(await acquireLock({ lockPath, storageDir: dir, log: () => {} }), true);
  assert.equal(readLock(lockPath)?.pid, process.pid);
  releaseLock(lockPath);
  assert.equal(fs.existsSync(lockPath), false);
});

test("acquire creates a missing lock parent directory (fresh install)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wc-lock-fresh-"));
  const lockPath = path.join(base, "nested", "storage", "wechat.lock");
  assert.equal(await acquireLock({ lockPath, storageDir: path.dirname(lockPath), log: () => {} }), true);
  assert.equal(fs.existsSync(lockPath), true);
  releaseLock(lockPath);
});
