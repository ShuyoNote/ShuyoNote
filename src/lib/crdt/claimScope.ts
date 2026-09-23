// **「这个工作空间绑定到哪个服务器/远端空间」的唯一一处解析**（纯函数）—— 两个调用方共用：
// ① claim（`platform/web.ts` ↔ `sync.rs::claim_config`）；② **SSE 变更流**（`hooks/useSyncStream.ts`）。
// ⚠️ 名字里的 `claim` 只是它**出生**的地方（claim 那片踩出来的 bug）；判定本身是通用的。
//
// ## 为什么非要有这一层（这是踩出来的，不是设计洁癖）
//
// 第一版把"页所属工作空间"的**本地 id** 直接当 `space_id` 发了出去。但：
//   · 服务端 `require_space` 查的是 `space_members(space_id, user_id)`，而它的 space id 是
//     **服务端生成的 32 位十六进制**（`shuyonote-sync-server/src/space.rs::gen_id`）；
//   · 本地工作空间 id 是 `uuid::Uuid::new_v4()` / 首库的 `default`
//     （`src-tauri/src/workspaces.rs::create_workspace`）；
//   · 两者是**两套 id 空间**，没有任何路径把它们对齐。
// ⇒ 那个请求**必然 403**。两端的后果还不一样：
//   · Web：`syncFetch` 见非 2xx 就抛 ⇒ 归一成 `unavailable` ⇒ **静默**降级回"离线临时建"
//     （功能不坏，但**首写者裁定从未生效、层里一条痕都没有**——违反本仓"不静默"的纪律）；
//   · 桌面：第一版把 403 读成 `denied` ⇒ 绑定被拒 ＋ 一句错话（"另一台设备正在编辑"）。
//
// ★ **同一个"挑错档案"的错还藏在 SSE 那条路上**（第 45 轮修）：`useSyncStream.ts` 原先挑的是
//   "第一个绑定过的档案"（`profiles.find(...)`）⇒ 多工作空间用户会**订到别的空间**上去。
//   一处解析、两个调用方 —— 正是为了让这类错只可能犯一次。
//
// ## 口径（**两侧成对**：Rust 那份在 `src-tauri/src/sync.rs::claim_config`，改一边必须看另一边）
//   · 只认**指定工作空间**那一条档案 —— 不是"随便挑第一个配了 `server_url` 的"；
//   · 档案缺 `server_url`，或**缺远端 `space_id`**（登录了但还没选空间）⇒ `null`
//     ⇒ 调用方**什么都不做**（**连请求都不发**：发出去只会换来 403，然后把 403 误读成裁定）；
//   · 服务端地址归一成**不带结尾斜杠**（与同步请求同一形状）。
//
// ## 为什么 403 不算 `denied`（口径只写一处，两端都按它实现）
// 服务端把"**别人先 claim 了这一页**"表达成 **200 ＋ `{granted:false}`**，把"**你不是这个空间的
// 成员/没权利**"表达成 **403**。两者是**不同的事**：把 403 读成"别人先建了血统"会给用户一句错话
// （"另一台设备正在编辑"），还会让这台设备在这一页上永远拿不到血统（`wait-for-remote`）。
// ⇒ 403 归 `unavailable`（离线临时建，照旧能写），`denied` **只认 200 ＋ `granted:false`**。

/** 档案行里本函数要用到的列（其余列不读、不猜）。 */
export interface ClaimScopeRow {
  ws_id: string;
  server_url: string;
  /** ⚠️ **远端**空间 id（服务端生成），**不是**本地工作空间 id。 */
  space_id: string;
  /** 档案里那份 token（会话表里那份优先，见调用方）。 */
  token: string;
}

/** 一次同步操作的目标（服务器 ＋ 远端空间 ＋ token 兜底）。 */
export interface ClaimScope {
  server: string;
  spaceId: string;
  token: string;
}

/**
 * 解析某个工作空间的同步绑定（**唯一一处**）。`null` ⇒ **没绑定/绑不全**
 * （claim 侧 ⇒ 回 `unavailable`；SSE 侧 ⇒ 什么都不做，退回轮询）。
 *
 * ⚠️ 名字：它出生在 claim 那片（历史上的 `resolveClaimScope`），但判定是通用的 ——
 *    "这个工作空间绑到哪个服务器/远端空间"；SSE 变更流与 claim 共用它。
 *
 * @param rows  `sync_profiles` 的行（至少含本文件声明的四列）
 * @param workspaceId **要问的工作空间**的 id（本地 id）
 */
export function resolveWorkspaceSyncScope(rows: ClaimScopeRow[], workspaceId: string): ClaimScope | null {
  const row = rows.find((r) => r.ws_id === workspaceId);
  if (!row) return null;
  const server = String(row.server_url ?? "").trim().replace(/\/+$/, "");
  const spaceId = String(row.space_id ?? "").trim();
  // 缺任一件都不发请求：只填了服务器还没选空间（登录+选空间是两步）是**正常中间态**，
  // 那时候发出去必然是 403 —— 而 403 会被读成"裁决过"。
  if (!server || !spaceId) return null;
  return { server, spaceId, token: String(row.token ?? "").trim() };
}
