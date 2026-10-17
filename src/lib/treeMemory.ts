// 「侧栏页面树：哪些节点展开 / 哪些折叠」的**纯存取那一半**（DOM 那一半在 `components/PageTree.tsx` ✓）。
//
// 来由（owner 2026-10-18）：「一个空间的那个文件夹展开、哪个折叠、最后的文档位置，可否记录下来？」
// —— 在此之前 `TreeItem` 的 `expanded` 只是**组件内 `useState(true)`**：刷新/切空间/重开之后
// 全部回到展开 ⇒ 用户折起来的那些**每轮都要重折一遍** ✗。
//
// 五条口径（与 `scrollMemory.ts` / `lastPageMemory.ts` 同一套惯例 ✓）：
//  ① 存 **localStorage**（这是**这台设备的界面状态**，不是用户数据 ⇒ 不进用户数据表 ✓）；
//  ② **按空间分键**（`shuyonote:treeExpanded:<spaceId>`）—— 每个空间各有各的展开形状 ✓；
//  ③ **只记用户显式点过的节点**（`[id, 0|1]`）：没记录的节点仍按老行为**默认展开** ✓
//     （⛔ 不因为"没有记录"就把别人的树全折起来 ✗）；
//  ④ 有上限（每个空间最多 [`TREE_MEMORY_MAX_ENTRIES`] 条；超了丢**最旧**的那几笔 ✓）；
//  ⑤ 读写一律 `try/catch`：隐私模式/配额异常时**记不住也不该影响用** ✓（退化成"不还原"）。
export const TREE_MEMORY_KEY_PREFIX = "shuyonote:treeExpanded:";

/** 每个空间最多记多少条（展开/折叠决策合并计）。用久了也不会让这条键无限长 ✓。 */
export const TREE_MEMORY_MAX_ENTRIES = 2000;

/** 一条决策：`[节点 id, 1=展开 / 0=折叠]`（数组形态 ⇒ **写入顺序可保留**，剪枝按它丢最旧的 ✓）。 */
type TreeDecision = [string, 0 | 1];

function keyOf(spaceId: string): string {
  return TREE_MEMORY_KEY_PREFIX + spaceId;
}

/** 读某个空间的全部决策（坏 JSON / 形状不认识 ⇒ 当"没有" ✓，⛔ 不抛 ✗）。 */
function readDecisions(spaceId: string): TreeDecision[] {
  try {
    const raw = localStorage.getItem(keyOf(spaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TreeDecision[] = [];
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const id = row[0];
      const value = row[1];
      if (typeof id !== "string" || !id) continue;
      if (value !== 0 && value !== 1) continue;
      out.push([id, value]);
    }
    return out;
  } catch {
    return []; // 坏数据/隐私模式 ⇒ 当没有记录（默认展开 ✓）
  }
}

/**
 * 这一节点该不该展开：用户点过 ⇒ 按记忆；**没点过 ⇒ `fallback`（缺省展开，与旧行为一致 ✓）**。
 *
 * `spaceId` 缺省（空间还没加载出来）⇒ 也回 `fallback` ✓ —— 之后空间 id 到位时调用方会再问一次
 * （见 `PageTree.tsx::TreeItem` 的那个 `useEffect`）。
 */
export function isNodeExpanded(
  spaceId: string | null | undefined,
  pageId: string,
  fallback = true,
): boolean {
  if (!spaceId || !pageId) return fallback;
  const row = readDecisions(spaceId).find(([id]) => id === pageId);
  return row ? row[1] === 1 : fallback;
}

/**
 * 记下用户这一次的展开/折叠。
 *
 * · 同一节点只留**最后一笔** ✓（不累积同 id 的历史）；
 * · 超过上限 ⇒ 丢最旧的那几笔 ✓；
 * · 写不进去（隐私模式/配额）⇒ 静默放弃（记不住不影响用 ✓）。
 */
export function rememberNodeExpanded(
  spaceId: string | null | undefined,
  pageId: string,
  expanded: boolean,
): void {
  if (!spaceId || !pageId) return;
  try {
    const rows = readDecisions(spaceId).filter(([id]) => id !== pageId);
    rows.push([pageId, expanded ? 1 : 0]);
    while (rows.length > TREE_MEMORY_MAX_ENTRIES) rows.shift();
    localStorage.setItem(keyOf(spaceId), JSON.stringify(rows));
  } catch {
    /* 记不住不影响用 */
  }
}

/** 清掉某个空间的树记忆（测试/将来「恢复默认展开」入口用 ✓）。 */
export function clearTreeMemory(spaceId: string): void {
  if (!spaceId) return;
  try {
    localStorage.removeItem(keyOf(spaceId));
  } catch {
    /* 同上 */
  }
}
