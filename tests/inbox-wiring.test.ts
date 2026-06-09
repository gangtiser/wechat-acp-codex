import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeChatAcpBridge } from "../src/bridge.js";
import { listPending } from "../src/inbox/store.js";
import { saveOwner } from "../src/storage/owner.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

function makeBridge(dir: string) {
  const config = defaultConfig();
  config.storage.dir = dir;
  config.storage.stateFile = path.join(dir, "state.json");
  config.storage.inboxDir = path.join(dir, "inbox");
  config.owner = { id: "owner@x", allowFirst: false };
  saveOwner(dir, "owner@x");
  const bridge = new WeChatAcpBridge(config, () => {});
  const enqueued: any[] = [];
  (bridge as any).sessionManager = { enqueue: async (userId: string, m: any) => { enqueued.push({ userId, m }); } };
  return { bridge: bridge as any, enqueued };
}
function textMsg(id: number, from = "owner@x") {
  return {
    message_type: MessageType.USER, message_id: id, from_user_id: from,
    context_token: "ct", item_list: [{ type: 1, text_item: { text: "hi" } }],
  };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test("content message: persisted + enqueued with inboxId; duplicate skipped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiring-"));
  const { bridge, enqueued } = makeBridge(dir);
  await bridge.handleMessage(textMsg(1));
  await tick();
  assert.equal((await listPending(dir)).length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].m.inboxId, "m1");
  await bridge.handleMessage(textMsg(1)); // duplicate id
  await tick();
  assert.equal(enqueued.length, 1, "duplicate must be skipped");
});

test("non-owner message: not persisted, not enqueued", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiring2-"));
  const { bridge, enqueued } = makeBridge(dir);
  await bridge.handleMessage(textMsg(2, "stranger@x"));
  await tick();
  assert.equal((await listPending(dir)).length, 0);
  assert.equal(enqueued.length, 0);
});

test("seeded failed/ id is a tombstone: handleMessage skips it (no re-persist, no enqueue) (H#7/#13)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-wiring3-"));
  fs.mkdirSync(path.join(dir, "queue", "failed"), { recursive: true });
  fs.writeFileSync(path.join(dir, "queue", "failed", "m5.json"), "{}");
  const { bridge, enqueued } = makeBridge(dir);
  await bridge.seedFailedInbox(); // what start() runs after the replay loop
  await bridge.handleMessage(textMsg(5));
  await tick();
  assert.equal((await listPending(dir)).length, 0, "failed id must not be re-persisted");
  assert.equal(enqueued.length, 0, "failed id must not be enqueued");
});
