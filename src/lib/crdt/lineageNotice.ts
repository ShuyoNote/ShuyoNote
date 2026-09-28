// 「血统拒绝合并」这件事**给用户看的那一句话**（唯一措辞来源）。
//
// 为什么要抽出来（冲刺 §13.3 第 2 条）：同一件事在**两条路**上都会撞到 ——
//   · `mergeRemotePageState`（pull 落盘那条）⇒ `lineageConflict`（`main.tsx` 注册的那版报出去）；
//   · `bindPageToEditorViaPort`（**打开页面**那条）⇒ `pendingSkipped`（待并状态里被拒的**条数**）。
// 两条路都**必须不静默**，但"什么算有事 + 该怎么说"只该有**一处**实现 —— 否则迟早一条路静默、
// 另一条路吵（第 43 轮就是这样：`pendingSkipped` 算出来了，却没人读它）。
//
// ★ 判据（`lineageNotice.test.ts`）里有**反方向**的一条：`null` ＝ 没事发生就**不许**留痕/打扰用户。
//   "不静默"不等于"什么都说"—— 噪声日志会把真正的冲突淹掉（本仓对"假账"同一条纪律）。

/** 一次「血统拒绝合并」要报出去的东西。 */
export interface LineageRefusal {
  /** 日志那一行（**带 pageId**；出问题要能查到是哪一页）。 */
  log: string;
  /** 给用户看的一句话（走 toast）。 */
  message: string;
}

/**
 * 组装「拒绝合并」的措辞：**没有事发生 ⇒ `null`**（调用方据此什么都不做）。
 *
 * - `skipped > 0`：打开页面时，收下的待并状态里有这么多条**血统无关** ⇒ 拒绝合并（本机版本保留）；
 * - `mine` + `remote`：`mergeRemotePageState` 那条路（两条独立血统的 client id 指纹）。
 *
 * ⚠️ 两条都命中时以 `skipped` 为准：那是"**这次**打开页面实际丢下了几条"，比"血统指纹长什么样"
 * 更贴近用户看到的现象。
 */
export function lineageRefusalNotice(opts: {
  pageId: string;
  /** 两条独立血统的 client id 指纹（`lineageConflict.mine` / `.remote`）。 */
  mine?: number[];
  remote?: number[];
  /** 打开页面时被拒的**待并状态条数**（`AsyncPageBinding.pendingSkipped`）。 */
  skipped?: number;
}): LineageRefusal | null {
  const skipped = opts.skipped ?? 0;
  if (skipped > 0) {
    return {
      log: `[crdt] 血统冲突：拒绝合并（本机版本保留）page=${opts.pageId} 待并状态 ${skipped} 条`,
      message: `这一页有 ${skipped} 条来自另一条编辑历史的改动没有合进来（本机版本保留）`,
    };
  }
  if (opts.mine && opts.remote) {
    return {
      log:
        `[crdt] 血统冲突：拒绝合并（本机版本保留）page=${opts.pageId}` +
        ` mine=[${opts.mine.join(",")}] remote=[${opts.remote.join(",")}]`,
      message: "这一页出现了两条互不相关的编辑历史，已保留本机版本（未合并）",
    };
  }
  return null;
}
