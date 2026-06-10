import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageBufferManager } from "../src/message-buffer.js";

function makeManager() {
  const notices: string[] = [];
  const enqueued: Array<{ userId: string; texts: string[]; contextToken: string }> = [];
  const mgr = new MessageBufferManager({
    convert: async (msg) => [{ type: "text", text: (msg as { text?: string }).text ?? "" }] as never,
    enqueue: async (userId, prompt, contextToken) => {
      enqueued.push({
        userId,
        texts: (prompt as Array<{ text: string }>).map((b) => b.text),
        contextToken,
      });
    },
    notify: async (_userId, _contextToken, text) => {
      notices.push(text);
    },
    labels: { start: "/acp-prompt-start", done: "/acp-prompt-done" },
    log: () => {},
  });
  return { mgr, notices, enqueued };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("start → append → done composes one prompt in order", async () => {
  const { mgr, enqueued } = makeManager();
  mgr.start("u", "ct1");
  assert.equal(mgr.isBuffering("u"), true);

  mgr.append({ text: "a" } as never, "u", "ct2");
  mgr.append({ text: "b" } as never, "u", "ct3");
  await tick();
  assert.equal(enqueued.length, 0, "nothing enqueued before done");

  await mgr.done("u", "ct3");
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]!.texts, ["a", "b"]);
  assert.equal(enqueued[0]!.contextToken, "ct3", "uses the last appended contextToken");
  assert.equal(mgr.isBuffering("u"), false, "buffer cleared after flush");
});

test("done without start sends a usage notice and enqueues nothing", async () => {
  const { mgr, notices, enqueued } = makeManager();
  await mgr.done("u", "ct");
  assert.equal(enqueued.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Nothing buffered/);
});

test("done with an empty buffer notifies instead of enqueuing", async () => {
  const { mgr, notices, enqueued } = makeManager();
  mgr.start("u", "ct");
  await mgr.done("u", "ct");
  assert.equal(enqueued.length, 0);
  assert.ok(notices.some((n) => /Buffer is empty/.test(n)));
});
