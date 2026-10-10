// 同步目标的视觉标识：一个**颜色点**（同地址永远同色）＋ **悬停／读屏**时才给地址。
// 三处共用：`PageTree` 的空间行 ／ `TitleBar` 的状态芯片 ／ `SyncPanel` 的空间标签 ——
// 同一个地址在不同位置必须是同一个颜色，否则这套颜色编码就失去意义了。
//
// ⚠️ 2026-10-10（owner 亲口报「这个 ip 地址胶囊怎么去掉？」，拍 C）：
//   ⛔ **地址不再渲染成文字** ✗（以前是 `syncTagLabel(...)` 直接摆出来，服务器是 IP 时就是那个 IP）；
//   ✅ 平时**只留颜色点**，地址只在 `title` / `aria-label` 里给（悬停看得见 ＋ 读屏读得到 ✓）。
//
// ⚠️ owner 同日补的更准的规则：⭐「**个人空间没有服务器，就不显示**」✓
//   ⇒ 这条规则**只有一处实现**：[`showsServerTag`]（⛔ 别在三处渲染层各写一遍 kind 判断 ✗）。
//   ✅ **2026-10-10 已接线**：`kind` 原先到不了渲染层（Rust `workspaces.rs` 的 `WS_COLS` 没选它 ✗）
//      ⇒ 三处补齐（Rust `WS_COLS` ＋ `models.rs::WorkspaceMeta` ＋ `src/types.ts`）＋
//      三处渲染各加一句 `showsServerTag(kind, url) &&` ⇒ 「个人空间 ⇒ 一个字节都不显示」✓
//      （判据：`src/lib/syncTag.test.ts`；⛔ 界面里不许出现 `kind === "team"` 那种第二份判断 ✗）。

/** 服务器地址 → 短标签（host，去掉 www.）。
 *  ⚠️ 只留给"有地方放文字"的场景（同步面板的空间标签）；侧栏/标题栏**不再**用它渲染文字 ✗。 */
export function syncTagLabel(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    return u.host.replace(/^www\./, "");
  } catch {
    return serverUrl.replace(/^https?:\/\//, "").split("/")[0] || "同步";
  }
}

/**
 * ⭐ 悬停提示与读屏用的**那句话** —— 给的是**完整地址**（含协议与端口 ✓）。
 *
 * ⚠️ 为什么是完整地址而不是 host：owner 要看的是"同步到**哪台**"，
 *    而 host 会丢端口（自建服务器的端口正是关键信息）；⛔ 而且**只有这一处**拼前缀 ✗ ——
 *    以前 `PageTree` 与 `TitleBar` 各拼一种（「同步目标：」／「同步：」），同一字段两种说法 ✓。
 */
export function syncTagTitle(serverUrl: string | null | undefined): string {
  const url = typeof serverUrl === "string" ? serverUrl.trim() : "";
  return url ? `同步目标：${url}` : "同步目标";
}

/**
 * ⭐ owner 的口径：**只有团队空间**才显示那个颜色点。
 *
 * · `kind === "team"` ⇒ 显示 ✓
 * · 个人空间 ／ 未分类（`""`）／ 其它 ⇒ ⛔ **一个字节都不显示** ✗
 *   （⭐ 不是"把地址藏起来" ✗，⭐ 而是"个人空间本来就不该有服务器标识" ✓ ——
 *     `src/components/SpacePrivacySection.tsx` 那条文案与 `set_sync_profile` 的 team-only 拒同口径）
 * · 没配服务器（空/空串/`null`）⇒ 不显示 ✓
 *
 * ⚠️ `kind === undefined`（拿不到空间类型）⇒ **一律不显示**（fail-closed ✓）。
 *    ⛔ 这里**没有**"过渡期先显示"那条分支 ✗ —— `kind` 已于 2026-10-10 补进数据流 ✓，
 *    所以"传丢了就恰好放行"这种事不该再发生；真丢了就**不显示**（宁可不显示也不误显示 ✓）。
 */
export function showsServerTag(
  kind: string | undefined,
  serverUrl: string | null | undefined,
): boolean {
  const hasServer = typeof serverUrl === "string" && serverUrl.trim().length > 0;
  if (!hasServer) return false;
  // ⚠️ `kind === undefined`（拿不到空间类型）**一律不显示**（fail-closed ✓）——
  //    2026-10-10 那一格已经补上（Rust `WS_COLS` ＋ `WorkspaceMeta` ＋ `src/types.ts` ✓）
  //    ⇒ 这里**没有**"过渡期放行"那条分支 ✓（谁把 `kind` 传丢，标识就消失：宁可不显示也不误显示 ✗）。
  return kind === "team";
}

/** 服务器地址 → 稳定的 HSL 颜色（同地址永远同色）。
 *  ⚠️ **算法一个字都不许动** ✗ —— 同地址永远同色是这套编码的意义（判据钉着真值）✓。 */
export function syncTagColor(serverUrl: string): string {
  let h = 0;
  for (let i = 0; i < serverUrl.length; i++) h = (h * 31 + serverUrl.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 65% 45%)`;
}
