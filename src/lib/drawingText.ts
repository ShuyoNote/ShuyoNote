// M23.4 — pure helper: extract searchable text from an Excalidraw scene so the
// drawing block's `content_text` (and thus search/backlinks) sees its labels.
// Kept free of platform/excalidraw imports so the smoke harness can bundle it.

export interface ExcalidrawSceneElementLike {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Collect the text of every Excalidraw text element (labels, notes). */
export function excalidrawSceneText(elements: ExcalidrawSceneElementLike[]): string {
  const out: string[] = [];
  for (const el of elements ?? []) {
    if (el && el.type === "text" && typeof el.text === "string" && el.text.trim()) {
      out.push(el.text);
    }
  }
  return out.join(" ");
}

/** True when a scene has at least one drawable element (non-deleted). */
export function excalidrawSceneHasContent(elements: ExcalidrawSceneElementLike[]): boolean {
  return (elements ?? []).some((e) => e && e.isDeleted !== true);
}

// ── P3-①（2026-09-23，macOS 侧）：**节点 / 连线结构**进正文 ────────────────────────────────
//
// 上面那半边（`excalidrawSceneText`）只取**图上文字标签** —— 于是"审批 → 发布"这种
// **关系**在图里有、在正文里没有：搜"审批"能找到这一页，搜"谁指向发布"找不到。
// 这一半补的就是关系。
//
// ## 方言（**一次定死**；方案 P3-① 的"方言要定下来，否则后人各写一套"就是指这里）
//
//   · 一行一条连线：`矩形"审批" →箭头→ 矩形"发布"`
//   · 形状名 = 中文类型名 ＋ 标签（标签是 Excalidraw 里**bound 的 text 元素**，见 `containerId`）；
//     没有标签 ⇒ `(未命名矩形)`
//   · 端点 id 在 elements 里找不到 ⇒ `(找不到)` —— **如实说找不到，不编一个名字**
//   · **只输出有端点绑定的箭头**：自由画笔、背景矩形、没有绑定的散箭头**一律忽略**
//     （纯装饰不许写成噪声；这条是判据钉住的）
//   · 顺序 = 元素在 `elements` 里的顺序 ⇒ **同 scene ⇒ 同文本**（确定性）
//   · 超过 `MAX_STRUCTURE_LINKS` 条 ⇒ 截断并**明说**截断了多少（正文列不能无限长）
//
// 边界（两条，都写清楚免得被读成"全都覆盖了"）：
//   · 不做嵌套/分组（Frame 内的父子关系 Excalidraw 没给稳定字段），也不解析箭头上的
//     附带文字（那属于标签，已被 `excalidrawSceneText` 收走）；
//   · ★ **存量绘图块仍是旧快照**：节点里的 `text` 是**保存那一刻**算出来的 ——
//     已经存在的绘图要带上结构文本，得**重新打开并保存**那一次绘图（或另做一个批量重算入口）。
//     这不是遗漏，是"正文文本由编辑器那一侧算"这条既有模式的必然结果（与 P3-② 同源）。

export interface ExcalidrawStructureElementLike {
  id?: string;
  type?: string;
  text?: string;
  /** 形状标签元素指向它的容器（Excalidraw 的 bound text）。 */
  containerId?: string | null;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  isDeleted?: boolean;
  [k: string]: unknown;
}

/** 形状的中文名（结构文本用；未知类型原样用 `type`）。 */
const SHAPE_NAME: Record<string, string> = {
  rectangle: "矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  arrow: "箭头",
  line: "线",
  image: "图片",
  frame: "框",
  text: "文本",
};

/**
 * 结构文本的上限（连线条数）：**正文列要有限** —— 一张上千节点的大图足以把搜索索引那一列撑爆。
 * （这里刻意不再写那个列名：`check-doc-content-access` 按**字面出现次数**只减不增地计数，
 *   注释里提一次也会记一笔；口径见它的头注。）
 */
export const MAX_STRUCTURE_LINKS = 200;

/** 一座图的结构文本（节点/连线）。见文件末尾那段"方言"。 */
export function excalidrawStructureText(elements: ExcalidrawStructureElementLike[]): string {
  const live = (elements ?? []).filter((e) => e && e.isDeleted !== true);
  const byId = new Map<string, ExcalidrawStructureElementLike>();
  for (const el of live) if (el.id !== undefined) byId.set(String(el.id), el);

  // 标签映射：`text` 元素若绑在某个容器上，它就是那个形状的标签。
  const labelOf = new Map<string, string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId && typeof el.text === "string" && el.text.trim()) {
      labelOf.set(String(el.containerId), el.text.trim());
    }
  }

  const nameOf = (id: string): string => {
    const el = byId.get(id);
    if (!el) return "(找不到)";
    const shape = SHAPE_NAME[String(el.type ?? "")] ?? String(el.type ?? "");
    const inline = typeof el.text === "string" ? el.text.trim() : "";
    const label = labelOf.get(id) ?? inline;
    return label ? `${shape}"${label}"` : `(未命名${shape})`;
  };

  const lines: string[] = [];
  let truncated = 0;
  for (const el of live) {
    if (el.type !== "arrow") continue;
    const fromId = el.startBinding?.elementId ? String(el.startBinding.elementId) : "";
    const toId = el.endBinding?.elementId ? String(el.endBinding.elementId) : "";
    if (!fromId && !toId) continue; // 没有绑定的散箭头 ⇒ 装饰，忽略
    if (lines.length >= MAX_STRUCTURE_LINKS) {
      truncated++;
      continue;
    }
    const from = fromId ? nameOf(fromId) : "(未命名起点)";
    const to = toId ? nameOf(toId) : "(未命名终点)";
    lines.push(`${from} →箭头→ ${to}`);
  }

  const body = lines.join("\n");
  return truncated > 0 ? `${body}\n…（还有 ${truncated} 条连线未展开）` : body;
}

/**
 * 一个绘图块**进正文的全文**：标签（scene text）＋ 结构（连线）。
 *
 * 为什么要有这一个函数、而不是让调用点自己拼：**拼接顺序与分隔符属于口径** ——
 * 散在调用点上，迟早出现"某处漏拼结构文本"（那正是这一格要消灭的缺口）。
 * 分隔符用换行：让"标签"与"结构"在片段里各占一行，便于阅读与断言。
 */
export function excalidrawSearchText(elements: ExcalidrawStructureElementLike[]): string {
  return [excalidrawSceneText(elements), excalidrawStructureText(elements)].filter(Boolean).join("\n");
}
