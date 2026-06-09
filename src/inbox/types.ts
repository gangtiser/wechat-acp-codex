import type { WeixinMessage } from "../weixin/types.js";

export interface InboxRecord {
  id: string;
  userId: string;
  contextToken: string;
  msg: WeixinMessage;
  ts: string;
  attempts: number;
}
