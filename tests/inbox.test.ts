import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inboxKey, writePending, ackPending, listPending, listFailedIds, failPending, bumpForReplay, settleInbox,
} from "../src/inbox/store.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "wc-inbox-")); }
function rec(id, ts, attempts = 0) {
  return { id, userId: "u", contextToken: "ct", msg: { message_id: 1 }, ts, attempts };
}

test("inboxKey prefers message_id, then seq, then composite hash", () => {
  assert.equal(inboxKey({ message_id: 7, seq: 3 }), "m7");
  assert.equal(inboxKey({ seq: 3 }), "s3");
  const h = inboxKey({ from_user_id: "a", create_time_ms: 5, item_list: [{ type: 1 }] });
  assert.match(h, /^h[0-9a-f]{16}$/);
  assert.equal(h, inboxKey({ from_user_id: "a", create_time_ms: 5, item_list: [{ type: 1 }] }));
});

test("write/list/ack round-trip, sorted by ts", async () => {
  const dir = tmp();
  await writePending(dir, rec("b", "2026-01-02T00:00:00Z"));
  await writePending(dir, rec("a", "2026-01-01T00:00:00Z"));
  assert.deepEqual((await listPending(dir)).map((r) => r.id), ["a", "b"]);
  await ackPending(dir, "a");
  assert.deepEqual((await listPending(dir)).map((r) => r.id), ["b"]);
  await ackPending(dir, "missing"); // safe no-op
});

test("settleInbox acks only when ok=true", async () => {
  const dir = tmp();
  await writePending(dir, rec("k", "t"));
  await settleInbox(dir, "k", false);
  assert.equal((await listPending(dir)).length, 1);
  await settleInbox(dir, "k", true);
  assert.equal((await listPending(dir)).length, 0);
});

test("bumpForReplay increments until MAX, then moves to failed/", async () => {
  const dir = tmp();
  await writePending(dir, rec("x", "t", 0));
  const r1 = await bumpForReplay(dir, rec("x", "t", 0), 2);
  assert.equal(r1?.attempts, 1);
  const r2 = await bumpForReplay(dir, r1, 2);
  assert.equal(r2?.attempts, 2);
  const r3 = await bumpForReplay(dir, r2, 2);
  assert.equal(r3, null);
  assert.equal((await listPending(dir)).length, 0);
  assert.ok(fs.existsSync(path.join(dir, "queue", "failed", "x.json")));
  assert.deepEqual(await listFailedIds(dir), ["x"]);
});

test("listFailedIds is empty (no throw) before any record fails", async () => {
  assert.deepEqual(await listFailedIds(tmp()), []);
});

test("failPending keeps pending if the tombstone write fails (#14)", async () => {
  const dir = tmp();
  await writePending(dir, rec("p", "t", 0));
  // Force the failed/ rename to fail: pre-create failed/p.json as a directory so
  // `rename(tmp, failed/p.json)` throws because the destination is a directory
  // (EISDIR on macOS even when empty; ENOTEMPTY/EEXIST for a non-empty dir on
  // Linux — the child file below makes it reject on every platform).
  fs.mkdirSync(path.join(dir, "queue", "failed", "p.json"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue", "failed", "p.json", "x"), "");
  await assert.rejects(() => failPending(dir, "p", "boom"));
  assert.equal((await listPending(dir)).length, 1, "pending kept when tombstone write fails");
});
