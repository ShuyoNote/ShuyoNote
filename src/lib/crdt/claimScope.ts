// S9 · **claim 到底该发给谁**（纯函数）：页所属工作空间 ⇒ 它绑定的（服务器，**远端空间 id**）。
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
// ## 口径（**两侧成对**：Rust 那份在 `src-tauri/src/sync.rs::claim_config`，改一边必须看另一边）
//   · 只认**这一页所属工作空间**那一条档案 —— 不是"随便挑第一个配了 `server_url` 的"；
//   · 档案缺 `server_url`，或**缺远端 `space_id`**（登录了但还没选空间）⇒ `null`
//     ⇒ 上层回 `unavailable`（**连请求都不发**：发出去只会换来 403，然后把 403 误读成裁定）；
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

/** 一次 claim 的目标（服务器 ＋ 远端空间 ＋ token 兜底）。 */
export interface ClaimScope {
  server: string;
  spaceId: string;
  token: string;
}

/**
 * 决定这次 claim 发给谁。`null` ⇒ **问不到**（上层回 `unavailable`，不发请求）。
 *
 * @param rows  `sync_profiles` 的行（至少含本文件声明的四列）
 * @param workspaceId **页所属工作空间**的 id（本地 id —— 由调用方从页那一行取）
 */
export function resolveClaimScope(rows: ClaimScopeRow[], workspaceId: string): ClaimScope | null {
  const row = rows.find((r) => r.ws_id === workspaceId);
  if (!row) return null;
  const server = String(row.server_url ?? "").trim().replace(/\/+$/, "");
  const spaceId = String(row.space_id ?? "").trim();
  // 缺任一件都不发请求：只填了服务器还没选空间（登录+选空间是两步）是**正常中间态**，
  // 那时候发出去必然是 403 —— 而 403 会被读成"裁决过"。
  if (!server || !spaceId) return null;
  return { server, spaceId, token: String(row.token ?? "").trim() };
}
