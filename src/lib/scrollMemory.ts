// 「记住每个页面的滚动位置」—— **纯存取那一半**（DOM 那一半在 `hooks/useScrollMemory.ts` ✓）。
//
// 来由（owner 2026-10-06）：「刷新页面，当前页面位置丢失了」。
// 应用里已经有"记得当前**文档**"（`store/notes.ts` 的 `lastPageId` ✓）但**没有**记得**滚动位置** ——
// 刷新/切页回来都回到顶部 ✗。这一层只做"按 key 存一个数"，好测、也便于换存储。
//
// ⚠️ 为什么不直接用 `history.scrollRestoration = "auto"`：那是**浏览器对整页滚动**的机制，
//    而这里的滚动容器是 `.note-scroll`（应用自绘的一列，页面本身不滚 ✓）⇒ 它管不到 ✗（实测口径见下）。
// ⚠️ 存 `localStorage`（与本仓其它界面记忆同一套 ✓：面板宽、emoji 最近用、文件视图…）：
//    它是**这台设备的界面状态**，不该进用户数据表 ✓。
// ⚠️ 顺手做**上限剪枝**：按 `at`（写入时刻）丢掉最旧的那些 —— 否则用得久了这条键会一直长 ✗。

export const SCROLL_KEY_PREFIX = "shuyonote:scroll:";

/** 最多留多少个页面的位置（超过就按写入时刻丢最旧的 ✓）。 */
export const SCROLL_MAX_ENTRIES = 200;

/** 一个 key 的滚动位置（`0` = 没有记录 / 记录就是顶）。 */
export function readScroll(key: string): number {
  if (!key) return 0;
  try {
    const raw = localStorage.getItem(SCROLL_KEY_PREFIX + key);
    const y = raw === null ? 0 : Number(raw);
    return Number.isFinite(y) && y > 0 ? y : 0;
  } catch {
    return 0;
  }
}

/** 记下位置（`y <= 0` ⇒ 直接删掉那条，别留一堆 0 ✓）。 */
export function writeScroll(key: string, y: number): void {
  if (!key) return;
  try {
    if (!Number.isFinite(y) || y <= 0) {
      localStorage.removeItem(SCROLL_KEY_PREFIX + key);
      return;
    }
    localStorage.setItem(SCROLL_KEY_PREFIX + key, String(Math.round(y)));
    pruneScrolls(key);
  } catch {
    /* 存不进不影响用（隐私模式 / 配额）—— 退化成"不记位置" */
  }
}

/**
 * 剪枝：把带时间戳的那本索引裁到上限（`keep` 是刚写过、必须留着的那个 key ✓）。
 *
 * ⚠️ 索引与"位置值"分两条键存：位置值要能被 `readScroll` 一次读出来（热路径 ✓），
 *    索引只用来判"谁最旧" ✓。
 */
export function pruneScrolls(keep: string): void {
  try {
    const idxRaw = localStorage.getItem(SCROLL_KEY_PREFIX + "__index");
    const idx: Record<string, number> = idxRaw ? JSON.parse(idxRaw) : {};
    idx[keep] = Date.now();
    const keys = Object.keys(idx);
    if (keys.length > SCROLL_MAX_ENTRIES) {
      keys
        .sort((a, b) => (idx[a] ?? 0) - (idx[b] ?? 0))
        .slice(0, keys.length - SCROLL_MAX_ENTRIES)
        .forEach((k) => {
          delete idx[k];
          localStorage.removeItem(SCROLL_KEY_PREFIX + k);
        });
    }
    localStorage.setItem(SCROLL_KEY_PREFIX + "__index", JSON.stringify(idx));
  } catch {
    /* 剪枝失败不影响用 */
  }
}
