import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAesKey } from "../src/weixin/media.js";

const b64 = (buf: Buffer) => buf.toString("base64");

test("parseAesKey returns 16 raw bytes directly", () => {
  const key = Buffer.alloc(16, 7);
  const out = parseAesKey({ aes_key: b64(key) });
  assert.deepEqual(out, key);
});

test("parseAesKey parses 32 hex chars into 16 bytes", () => {
  const hex = "00112233445566778899aabbccddeeff";
  const out = parseAesKey({ aes_key: b64(Buffer.from(hex, "ascii")) });
  assert.deepEqual(out, Buffer.from(hex, "hex"));
});

test("parseAesKey returns null for a missing key", () => {
  assert.equal(parseAesKey({}), null);
});

test("parseAesKey returns null for an unexpected length instead of truncating", () => {
  // 24 bytes: neither a raw 16-byte key nor 32 hex chars. Must not be silently
  // truncated to 16 bytes (which would decrypt to garbage) — caller skips it.
  const out = parseAesKey({ aes_key: b64(Buffer.alloc(24, 1)) });
  assert.equal(out, null);
});
