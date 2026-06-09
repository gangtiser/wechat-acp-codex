import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBatch } from "../src/weixin/monitor.js";

test("awaits every onMessage before saving the cursor", async () => {
  const order: string[] = [];
  await applyBatch(
    [{ message_id: 1 }, { message_id: 2 }],
    async (m) => { await Promise.resolve(); order.push(`msg:${m.message_id}`); },
    () => order.push("cursor"),
  );
  assert.deepEqual(order, ["msg:1", "msg:2", "cursor"]);
});

test("a throwing onMessage prevents the cursor from being saved", async () => {
  const order: string[] = [];
  await assert.rejects(
    applyBatch([{ message_id: 1 }], async () => { throw new Error("persist failed"); }, () => order.push("cursor")),
  );
  assert.deepEqual(order, []);
});
