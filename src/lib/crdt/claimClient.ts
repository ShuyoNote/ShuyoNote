// 冲刺 **S9 · 客户端接线（第一片）**：把服务端那条 claim 端点包成 `PageClaimPort` 的**真实现**。
//
// 分工（与 `bootstrap.ts` 的口径对齐）：
//   · 这里只管"**怎么跟服务端说话**"（HTTP 形状、状态码怎么读）；
//   · "拿不到怎么办"由 `claimVerdict` 决定（`throw` ⇒ `unavailable` ⇒ 离线降级照旧能写）；
//   · "服务端地址/token/空间 id 从哪来"由**同步那一层**给（下一片接：`platform/web.ts` 的
//     `syncFetch` 那套配置）⇒ 本文件只收一个 `endpoint` ＋ 一个 `token`。
//
// 三条口径（判据钉住；**与 Rust 侧 `sync::lineage_claim_verdict` 同一张表**）：
//   ① `200 {"granted":true|false}` ⇒ 原样回布尔（`false` ＝ **别人先 claim 了这一页** ⇒ `denied`）；
//   ② **401/403/5xx/网络错** ⇒ **抛**（＝"现在问不到" ⇒ 归一成 `unavailable` ⇒ 离线临时建血统，
//      照旧能写、不挡住用户）；
//   ③ ★ **403 不算 `denied`**（2026-09-23 第 42 轮改）：服务端把"**别人先 claim**"表达成
//      **200 ＋ `granted:false`**，把"**你不是这个空间的成员／空间没选**"表达成 **403** —— 两件不同的事。
//      第一版把 403 读成 denied ⇒ "没选空间"会变成一句错话（"另一台设备正在编辑"），而且这台设备
//      在这一页上会**永远**走 `wait-for-remote`。口径只写一处，见 `claimScope.ts` 文件头。
import type { PageClaimPort } from "./bootstrap";

/**
 * claim 端点的相对路径。
 *
 * ⚠️ **没有 `/sync` 前缀** —— 服务端把 `sync_routes` **挂在根上**（客户端调 `/push` 也是这个形状：
 * `syncFetch(profile.server_url, "/push", …)`）。第一版我写成 `/sync/lineage-claim`，**部署后探针实测
 * 404**（而 `/lineage-claim` 回 401 ＝ 路由在、只是没带鉴权）。⇒ 路径是**跨仓契约**，上线后必须用
 * 真探针核一遍，别靠"看起来对"。
 */
export const LINEAGE_CLAIM_PATH = "/lineage-claim";

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
 * @param opts.spaceId  **远端**空间 id（服务端按它做 `require_space(..., "editor")`）。
 *                      ⚠️ 不是本地工作空间 id —— 两者是两套 id，传错必然 403（`claimScope.ts` 文件头）。
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
      if (!res.ok) {
        // ② 一律抛（**403 也在内**）：401 没登录／403 不是这个空间的人／5xx ⇒ 都归"问不到"
        //    ⇒ `unavailable` ⇒ 离线临时建（不挡用户，也不把 403 误读成"别人先建了血统"）。
        throw new Error(`claim 失败：HTTP ${res.status}`);
      }
      const body = (await res.json()) as { granted?: unknown };
      return body?.granted === true; // ① 只有明确 true 才算拿到（缺字段/别的类型 ⇒ false ＝ denied）
    },
  };
}
