import { test } from "node:test";
import assert from "node:assert/strict";
import { turnSettledOk, SessionManager } from "../src/acp/session.js";

test("ok only when agent didn't die and every gated send delivered", () => {
  assert.equal(turnSettledOk({ agentDied: false, deliveryFailed: false }), true);
  assert.equal(turnSettledOk({ agentDied: false, deliveryFailed: true }), false);
  assert.equal(turnSettledOk({ agentDied: true, deliveryFailed: false }), false);
});

test("cancelCurrent({drainQueue:true}) awaits onTurnSettled ack for each dropped inboxId", async () => {
  const acked: Array<[string, boolean]> = [];
  const mgr = new SessionManager({
    agentCommand: "x", agentArgs: [], agentCwd: ".", idleTimeoutMs: 0,
    maxConcurrentUsers: 1, showThoughts: false, log: () => {},
    onReply: async () => ({ total: 0, sent: 0, allSent: true }),
    sendTyping: async () => {},
    // Defer the push to a *macrotask* (setTimeout), not a microtask. With a
    // microtask the assertion would pass even if cancelCurrent didn't await
    // (the pushes drain before the test's post-await continuation). A macrotask
    // only completes in time if cancelCurrent actually awaited onTurnSettled.
    onTurnSettled: async (inboxId, ok) => {
      await new Promise((r) => setTimeout(r, 0));
      acked.push([inboxId, ok]);
    },
  });
  // Inject a fake session whose turn is NOT in flight (processing:false) so the
  // drain path returns before touching agentInfo.connection — no real agent.
  (mgr as unknown as { sessions: Map<string, unknown> }).sessions.set("u", {
    userId: "u", processing: false, lastActivity: 0,
    queue: [
      { prompt: [], contextToken: "ct", inboxId: "m1" },
      { prompt: [], contextToken: "ct", inboxId: "m2" },
    ],
  });
  const res = await mgr.cancelCurrent("u", { drainQueue: true });
  assert.equal(res.droppedQueueCount, 2);
  // Both ids acked in order AND the macrotask above completed before this line —
  // which only happens if cancelCurrent awaited each onTurnSettled (drop the
  // await in Step 5 and this fails with acked === []).
  assert.deepEqual(acked, [["m1", true], ["m2", true]]);
});

test("cancelCurrent drain stops on ack failure: earlier dropped, failed+rest stay queued, throws (#11)", async () => {
  const acked: string[] = [];
  const mgr = new SessionManager({
    agentCommand: "x", agentArgs: [], agentCwd: ".", idleTimeoutMs: 0,
    maxConcurrentUsers: 1, showThoughts: false, log: () => {},
    onReply: async () => ({ total: 0, sent: 0, allSent: true }),
    sendTyping: async () => {},
    onTurnSettled: async (inboxId) => {
      if (inboxId === "m2") throw new Error("rm failed"); // simulate ackPending fs error
      acked.push(inboxId);
    },
  });
  const session = {
    userId: "u", processing: false, lastActivity: 0,
    queue: [
      { prompt: [], contextToken: "ct", inboxId: "m1" },
      { prompt: [], contextToken: "ct", inboxId: "m2" },
      { prompt: [], contextToken: "ct", inboxId: "m3" },
    ] as Array<{ prompt: unknown[]; contextToken: string; inboxId: string }>,
  };
  (mgr as unknown as { sessions: Map<string, unknown> }).sessions.set("u", session);
  await assert.rejects(() => mgr.cancelCurrent("u", { drainQueue: true }), /rm failed/);
  assert.deepEqual(acked, ["m1"]); // m1 acked+dropped; stopped at m2
  assert.deepEqual(session.queue.map((p) => p.inboxId), ["m2", "m3"]); // un-acked tail stays queued for retry
});
