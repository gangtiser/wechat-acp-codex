/**
 * Tests for iLink API error mapping.
 *
 * A client-side timeout (AbortError) means "no new messages" ONLY for the
 * getUpdates long-poll; sendMessage must treat both a timeout and an
 * HTTP-200 business error code as a failure so delivery accounting never
 * acks a message that was not actually sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getUpdates, sendMessage } from "../src/weixin/api.js";

function withFetch(fn: typeof fetch, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const abortError = () => Object.assign(new Error("timed out"), { name: "AbortError" });

test("sendMessage throws on an HTTP-200 business error code", async () => {
  await withFetch(async () => jsonResponse({ ret: -1, errmsg: "boom" }), async () => {
    await assert.rejects(
      () => sendMessage({ baseUrl: "http://fake", body: { msg: {} } as never }),
      /sendmessage rejected: ret=-1/,
    );
  });
});

test("sendMessage resolves when the gateway returns ret=0", async () => {
  await withFetch(async () => jsonResponse({ ret: 0 }), async () => {
    await sendMessage({ baseUrl: "http://fake", body: { msg: {} } as never });
  });
});

test("sendMessage propagates a timeout instead of faking success", async () => {
  await withFetch(async () => { throw abortError(); }, async () => {
    await assert.rejects(
      () => sendMessage({ baseUrl: "http://fake", body: { msg: {} } as never }),
      { name: "AbortError" },
    );
  });
});

test("getUpdates maps a long-poll timeout to an empty batch", async () => {
  await withFetch(async () => { throw abortError(); }, async () => {
    const resp = await getUpdates({ baseUrl: "http://fake", get_updates_buf: "" });
    assert.deepEqual(resp, { ret: 0, msgs: [] });
  });
});
