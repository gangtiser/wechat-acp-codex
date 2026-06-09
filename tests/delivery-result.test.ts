import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryResult } from "../src/weixin/send.js";

test("allSent true only when every segment sent", () => {
  assert.deepEqual(deliveryResult(3, 3), { total: 3, sent: 3, allSent: true });
  assert.deepEqual(deliveryResult(3, 2), { total: 3, sent: 2, allSent: false });
  assert.deepEqual(deliveryResult(0, 0), { total: 0, sent: 0, allSent: true });
});
