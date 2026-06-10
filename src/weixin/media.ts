/**
 * AES-128-ECB decrypt for WeChat CDN media downloads.
 * Adapted from @tencent-weixin/openclaw-weixin cdn/aes-ecb.ts
 */

import crypto from "node:crypto";
import type { CDNMedia } from "./types.js";

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse the AES key from CDN media reference.
 * The key can be either:
 *   - base64 → 16 raw bytes (use directly)
 *   - base64 → 32 hex chars → parse hex → 16 bytes
 */
export function parseAesKey(media: CDNMedia): Buffer | null {
  const raw = media.aes_key;
  if (!raw) return null;

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hexStr = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, "hex");
    }
  }
  return decoded.subarray(0, 16);
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKey: Buffer,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: HTTP ${res.status}`);
  const ciphertext = Buffer.from(await res.arrayBuffer());
  return decryptAesEcb(ciphertext, aesKey);
}
