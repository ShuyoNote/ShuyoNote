// M23.4 — pure helper: extract searchable text from an Excalidraw scene so the
// drawing block's `content_text` (and thus search/backlinks) sees its labels.
// Kept free of platform/excalidraw imports so the smoke harness can bundle it.

export interface ExcalidrawSceneElementLike {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Collect the text of every Excalidraw text element (labels, notes). */
export function excalidrawSceneText(elements: readonly ExcalidrawSceneElementLike[] | undefined): string {
  const out: string[] = [];
  for (const el of elements ?? []) {
    if (el && el.type === "text" && typeof el.text === "string" && el.text.trim()) {
      out.push(el.text);
    }
  }
  return out.join(" ");
}

/** True when a scene has at least one drawable element (non-deleted). */
export function excalidrawSceneHasContent(elements: readonly ExcalidrawSceneElementLike[] | undefined): boolean {
  return (elements ?? []).some((e) => e && e.isDeleted !== true);
}

// ── P3-①（2026-09-23）：**节点 / 连线结构**进正文 ────────────────────────────────────────
//
// 上面那半边（`excalidrawSceneText`）只取**图上文字标签** —— 于是"审批 → 发布"这种**关系**
// 在图里有、在正文里没有：搜"审批"找得到这一页，搜"谁指向发布"找不到。
//
// ⚠️ **结构那一半的实现不在这里**：它在 `src/lib/drawingStructureText.ts`（AMD，2026-09-23，
// 方案 P3-① 的纯函数那半）。本文件只负责**把两半合成"进正文的全文"** —— 这是刻意的：
// 一开始我在本文件里也写了一份结构实现，与他的**同一分钟内撞车**（两套方言、同一个函数名）；
// 处置＝**保留他那一份**（它的定序与输入顺序无关，比"按元素顺序"更强），本文件退回"合成层"。
// 这段历史写在这里，是为了让后人别再各写一套 —— 方案 P3 的"方言要定死"说的就是这个。
//
// 合成口径（**单一来源**）：`sceneText` 在前、`structureText` 在后，换行分隔；
// 任一半为空就不加空行。散在调用点上拼，迟早出现"某处漏拼结构文本" —— 那正是这格要消灭的缺口。
//
// ★ 一条**被接受的口径**（2026-09-23，Windows 侧复核出来的读数）：合成后**同一句话会出现两次** ——
//   标签那一半（`审批`/`发布`）与结构行里的形状名各出一次，孤节点（`独立说明`）也各出一次。
//   实测：`"审批 发布 独立说明\n审批 → 发布\n独立说明"`。**接受它，不去重** ——
//   这两处重复的**形态不同**（一个是原文词、一个是关系行），为省长度去重反而要新定一套
//   "哪一半算重复"的方言；而方言正是这一格最贵的东西（撞车那次的教训）。
//
// 边界（两条，写清楚免得被读成"全都覆盖了"）：
//   · ★ **存量绘图块仍是旧快照**：节点里的 `text` 是**保存那一刻**算出来的 ⇒ 已存在的绘图要带上
//     结构文本，得**重新打开并保存**那一次绘图（或另做批量重算入口）。这是"正文文本由编辑器那一侧算"
//     这条既有模式的必然结果（与 P3-② 同源），不是遗漏；
//   · **总长有上限**：一张上千节点的图足以把搜索索引那一列撑爆，所以这里按字符数封顶并**明说截断**
//     （结构那一半自己不加上限，因为它不知道标签占了多少）。

import { excalidrawStructureText } from "./drawingStructureText";

/** 进正文全文的字符上限（标签 ＋ 结构）。超了就截断并标注 —— 不许安静地写一个巨型正文。 */
export const MAX_DRAWING_TEXT_CHARS = 20_000;

/** 截断标注（同时是判据的抓手）。 */
export const DRAWING_TEXT_TRUNCATED = "…（绘图文本已截断）";

/**
 * 一个绘图块**进正文的全文**：标签（scene text）＋ 结构（连线/节点）。
 *
 * 为什么要有这一个函数、而不是让调用点自己拼：**拼接顺序、分隔符与长度上限都属于口径**。
 */
export function excalidrawSearchText(elements: ExcalidrawStructureInput): string {
  const joined = [excalidrawSceneText(elements), excalidrawStructureText(elements).text]
    .filter(Boolean)
    .join("\n");
  if (joined.length <= MAX_DRAWING_TEXT_CHARS) return joined;
  return `${joined.slice(0, MAX_DRAWING_TEXT_CHARS)}${DRAWING_TEXT_TRUNCATED}`;
}

/** 两半都只认这几个字段（结构那一半的输入形状见 `drawingStructureText.ts`）。 */
type ExcalidrawStructureInput = Parameters<typeof excalidrawStructureText>[0];
