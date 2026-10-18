// **被签名的字节**（2026-10-18）。这一片最贵的是"逐字" —— 拼错一个换行，发卡站回 401，
// 而 401 看起来像权限问题，排查会往完全错误的方向跑。
//
// 口径（与发卡站规格 §4 同一套；四条**各自**独立，⛔ 不共用一个拼装函数 —— 它们的分隔符与字段数不同）：
//
//   续期：    SHUYO-RENEW-1\n{卡文本}\n{dev}\n{ts}
//   轮询单：  SHUYO-ORDER-1\n{单号}\n{dev}\n{ts}
//   解绑：    SHUYO-UNBIND-1\n{卡文本}\n{by}\n{target}\n{ts}
//   普通请求：SHUYO-REQ-1\n{METHOD}\n{target（含 query）}\n{ts}\n{sha256(body) 的 hex}
//
// ⚠️ 三条硬规矩：
// ① **末尾没有换行**（`\n` 只是分隔符，不是终止符）—— 实测过：多一个 `\n` ⇒ 401；
// ② `ts` 是**客户端自己算的 Unix 秒**，⛔ 不许拿系统时区的显示值/本地格式串（容差 ±10 分钟在服务端判）；
// ③ 空 body 的 GET **也要参与哈希**：`sha256("")` ＝ `e3b0c442…b855`（下面有常量）。
export const SIGNED_BYTES = {
  renew: "SHUYO-RENEW-1",
  order: "SHUYO-ORDER-1",
  unbind: "SHUYO-UNBIND-1",
  request: "SHUYO-REQ-1",
} as const;

/** `sha256("")` 的十六进制 —— 空 body 的 GET 用得上（⛔ 不许写成 "0" 或省略这一格）。 */
export const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 续期要签的字节。 */
export function renewBytes(cardText: string, dev: string, ts: number | string): string {
  return [SIGNED_BYTES.renew, cardText, dev, String(ts)].join("\n");
}

/** 轮询单要签的字节。 */
export function orderBytes(outTradeNo: string, dev: string, ts: number | string): string {
  return [SIGNED_BYTES.order, outTradeNo, dev, String(ts)].join("\n");
}

/** 解绑要签的字节（⚠️ `target` 必须含 query 整串）。 */
export function unbindBytes(cardText: string, by: string, target: string, ts: number | string): string {
  return [SIGNED_BYTES.unbind, cardText, by, target, String(ts)].join("\n");
}

/** 普通请求要签的字节。`bodyHashHex` 传 `SHA256_EMPTY` 表示空 body。 */
export function requestBytes(
  method: string,
  targetWithQuery: string,
  ts: number | string,
  bodyHashHex: string,
): string {
  // ⚠️ 方法**原样**（调用方传大写；这里不 `toUpperCase()` —— 悄悄改大小写就等于改了被签的字）
  return [SIGNED_BYTES.request, method, targetWithQuery, String(ts), bodyHashHex.toLowerCase()].join("\n");
}

/** 客户端自己算的 Unix 秒（⛔ 不用本地时区格式串）。 */
export function nowTs(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000);
}
