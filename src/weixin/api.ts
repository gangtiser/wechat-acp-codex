/**
 * WeChat iLink HTTP API client.
 * Adapted from @tencent-weixin/openclaw-weixin api/api.ts
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

const CHANNEL_VERSION = "1.0.2";

// The long-poll duration is the server's (learned via longpolling_timeout_ms).
// The client must abort the socket only AFTER that window plus a margin —
// aborting right at the boundary would discard the batch the server was about
// to return and force a redundant re-poll (added latency, no lost messages).
const GETUPDATES_LONG_POLL_MS = 35_000;
const GETUPDATES_ABORT_MARGIN_MS = 10_000;

// A WeChat UIN identifies the client, not the request, so compute it once per
// process and reuse it. A fresh value per request is neither meaningful nor
// free, and could defeat any gateway-side session affinity.
const WECHAT_UIN = ((): string => {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
})();

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": WECHAT_UIN,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

async function apiGet<T>(baseUrl: string, path: string, token?: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = 15_000,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: buildBaseInfo() };
  const bodyStr = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  get_updates_buf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  try {
    return await apiPost<GetUpdatesResp>(
      params.baseUrl,
      "ilink/bot/getupdates",
      { get_updates_buf: params.get_updates_buf },
      params.token,
      (params.timeoutMs ?? GETUPDATES_LONG_POLL_MS) + GETUPDATES_ABORT_MARGIN_MS,
    );
  } catch (err) {
    // Long-poll client-side timeout just means "no new messages this cycle".
    // This mapping is ONLY valid for getupdates — for sendmessage etc. a
    // timeout must throw so the caller retries (with the same client_id).
    if ((err as Error).name === "AbortError") {
      return { ret: 0, msgs: [] };
    }
    throw err;
  }
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  body: SendMessageReq;
}): Promise<void> {
  const resp = await apiPost<{ ret?: number; errcode?: number; errmsg?: string }>(
    params.baseUrl,
    "ilink/bot/sendmessage",
    params.body as unknown as Record<string, unknown>,
    params.token,
  );
  // The gateway can reject with HTTP 200 + a business error code (getupdates
  // does this, e.g. errcode -14). Treat an explicit non-zero code as failure
  // so delivery accounting doesn't ack a message that was never sent.
  const code = resp.ret ?? resp.errcode;
  if (code !== undefined && code !== 0) {
    throw new Error(`sendmessage rejected: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
  }
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  return apiPost<GetConfigResp>(
    params.baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: params.ilinkUserId,
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
    },
    params.token,
    10_000,
  );
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  await apiPost(
    params.baseUrl,
    "ilink/bot/sendtyping",
    params.body as unknown as Record<string, unknown>,
    params.token,
    10_000,
  );
}

export async function getBotQrcode(params: {
  baseUrl: string;
  botType?: string;
}): Promise<{ qrcode: string; qrcode_img_content: string }> {
  return apiGet(
    params.baseUrl,
    `ilink/bot/get_bot_qrcode?bot_type=${params.botType ?? "3"}`,
  );
}

export async function getQrcodeStatus(params: {
  baseUrl: string;
  qrcode: string;
}): Promise<{
  status: string;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}> {
  return apiGet(
    params.baseUrl,
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
  );
}
