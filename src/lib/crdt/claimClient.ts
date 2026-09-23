// 冲刺 **S9 · 客户端接线（第一片）**：把服务端那条 claim 端点包成 `PageClaimPort` 的**真实现**。
//
// 分工（与 `bootstrap.ts` 的口径对齐）：
//   · 这里只管"**怎么跟服务端说话**"（HTTP 形状、状态码怎么读）；
//   · "拿不到怎么办"由 `claimVerdict` 决定（`throw` ⇒ `unavailable` ⇒ 离线降级照旧能写）；
//   · "服务端地址/token/空间 id 从哪来"由**同步那一层**给（下一片接：`platform/web.ts` 的
//     `syncFetch` 那套配置）⇒ 本文件只收一个 `endpoint` ＋ 一个 `token`。
//
// 三条口径（判据钉住）：
//   ① `200 {"granted":true|false}` ⇒ 原样回布尔；
//   ② **401/5xx/网络错** ⇒ **抛**（＝"现在问不到" ⇒ 上层归一成 `unavailable` ⇒ 离线临时建血统，
//      照旧能写、不挡住用户）；
//   ③ ★ **403 ⇒ `false`（denied）**：那不是"问不到"，而是"**你没这个权利／这一页不是你的**"
//      ⇒ 不许混进离线那一支（混进去就会静默地又建一条血统）。
import type { PageClaimPort } from "./bootstrap";

/** claim 端点的相对路径（与 `shuyonote-sync-server` 的 `sync_routes` 对齐）。 */
export const LINEAGE_CLAIM_PATH = "/sync/lineage-claim";

/** 注入点（判据用假 fetch；生产用全局 fetch）。**不许**在这一层 import 平台实现。 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * 造一个真端口。
 *
 * @param opts.server   服务端根地址（结尾斜杠可有可无）
 * @param opts.token    当前会话的 Bearer token（`null` ⇒ 不带 Authorization 头，服务端会 401 ⇒ 抛）
 * @param opts.spaceId  这一页所在空间（服务端按它做 `require_space(..., "editor")`）
 * @param opts.fetchImpl 注入的 fetch（生产不传 ⇒ 用全局 `fetch`）
 */
export function createHttpClaimPort(opts: {
  server: string;
  token: string | null;
  spaceId: string;
  fetchImpl?: FetchLike;
}): PageClaimPort {
  const url = `${opts.server.replace(/\/+$/, "")}${LINEAGE_CLAIM_PATH}`;
  return {
    async claim(pageId: string, deviceId: string): Promise<boolean> {
      const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      if (typeof f !== "function") {
        throw new Error("createHttpClaimPort: 这个环境没有 fetch（判据请注入 fetchImpl）");
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await f(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ space_id: opts.spaceId, page_id: pageId, device_id: deviceId }),
      });
      // ★ ③ 403 是"没权利/不是你的"，不是"问不到" ⇒ 明确当 denied（不许静默建血统）
      if (res.status === 403) return false;
      if (!res.ok) {
        // ② 别的失败（401 没登录／5xx／网关）⇒ 抛 ⇒ 上层归一成 unavailable（离线降级）
        throw new Error(`claim 失败：HTTP ${res.status}`);
      }
      const body = (await res.json()) as { granted?: unknown };
      return body?.granted === true; // ① 只有明确 true 才算拿到（缺字段/别的类型 ⇒ false）
    },
  };
}
