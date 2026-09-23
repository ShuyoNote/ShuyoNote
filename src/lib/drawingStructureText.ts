// 绘图块的**节点 / 连线结构** → 纯文本（「全库 AI 覆盖」方案 P3-① 缺的那一半）。
//
// ## 与 `drawingText.ts` 的关系（别读成两套口径）
//
// `drawingText.ts`（cnzen）的 `excalidrawSceneText` 已经把**图上文字标签**送进 `content_text` 了 ——
// 那一半**已完成**。P3 原文要的还有"**节点-连线结构**序列化"（`loc` ＝ 块 id）：一张
// 「审批 → 发布 → 归档」的流程图，光有标签文字搜得到词，但**关系**（谁指向谁）看不见。
// ⇒ 本文件是**补充**，不是替代：接线时应当 `sceneText ＋ structureText` 并列输出。
//
// ⚠️ **接线不在本文件**：`DrawingNode.getTextContent` 是 editor 侧的文件（归属见方案 P3 工作单）。
// 这里只出纯函数 ＋ 判据。
//
// ## 三条刻意写下来的决定
//
//  1. **纯装饰元素不许写成噪声**：无文字、又没有任何连线绑定的自由画笔 / 背景矩形**不进正文**
//     —— 否则每一张随手涂鸦都会往索引里灌一堆"（矩形）（矩形）"。
//  2. **确定性与输入顺序无关**：输出按「先 y、后 x、再 id」定序（坐标取整到 1 位小数，避免浮点尾差
//     把同一次布局排出两种文本）。⇒ 打乱输入元素顺序**结果逐字相同**（有判据钉住）。
//  3. **容器的文字标签不重复计**：Excalidraw 里形状的文字是**独立 text 元素**（`containerId` 指回形状）
//     ⇒ 那份文字算在**形状**头上，不再单独成行（否则同一句话会出现两次）。
//
// 纯文本、无 markdown 标记（与页面正文的既有口径一致）。

/** Excalidraw 元素的最小形状（只取我们要用的字段；**不引 excalidraw 依赖**，与 `drawingText.ts` 同做法）。 */
export interface ExcalidrawElementLike {
  id?: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
  x?: number;
  y?: number;
  containerId?: string | null;
  startBinding?: { elementId?: string | null } | null;
  endBinding?: { elementId?: string | null } | null;
  [k: string]: unknown;
}

export interface DrawingStructureResult {
  /** 结构文本；**没有结构（空场景 / 全装饰）⇒ 空串**（接线侧据此不加这一段）。 */
  text: string;
  /** 参与表达的节点数 / 连线数（给人看，也便于判据）。 */
  nodeCount: number;
  edgeCount: number;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const SHAPE_NAMES: Record<string, string> = { rectangle: "矩形", ellipse: "椭圆", diamond: "菱形" };
const EDGE_TYPES = new Set(["arrow", "line"]);

const label = (el: ExcalidrawElementLike): string => (typeof el.text === "string" ? el.text.trim() : "");
const shapeName = (el: ExcalidrawElementLike): string => SHAPE_NAMES[String(el.type)] ?? "图形";

/** 稳定定序：先 y、后 x、再 id。坐标取整到 0.1 —— 浮点尾差不该改变正文。 */
function orderKey(el: ExcalidrawElementLike): [number, number, string] {
  const q = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);
  return [q(el.y), q(el.x), String(el.id ?? "")];
}
function byOrder(a: ExcalidrawElementLike, b: ExcalidrawElementLike): number {
  const [ay, ax, ai] = orderKey(a);
  const [by, bx, bi] = orderKey(b);
  return ay - by || ax - bx || (ai < bi ? -1 : ai > bi ? 1 : 0);
}

/**
 * 把 Excalidraw 场景渲染成"节点 / 连线"结构文本。
 *
 * 形态（人读、可检索）：
 * ```
 * 审批 → 发布
 * 发布 → 归档
 * 独立说明          ← 有文字但没有任何连线的节点
 * ```
 */
export function excalidrawStructureText(elements: readonly ExcalidrawElementLike[] | undefined): DrawingStructureResult {
  const live = (elements ?? []).filter((e) => e && e.isDeleted !== true);

  // 形状的文字：形状自己带 text（少见），或指向它的 text 元素（Excalidraw 的常态）。
  const textByContainer = new Map<string, string>();
  for (const el of live) {
    const cid = typeof el.containerId === "string" ? el.containerId : "";
    const t = label(el);
    if (el.type === "text" && cid && t && !textByContainer.has(cid)) textByContainer.set(cid, t);
  }
  const textOf = (el: ExcalidrawElementLike): string => label(el) || textByContainer.get(String(el.id ?? "")) || "";

  const shapes = live.filter((e) => SHAPE_TYPES.has(String(e.type))).sort(byOrder);

  // 连线：两端都绑到了实体（形状或别的元素）才算"结构"；端点文本优先，缺则用类型名。
  const edges: { from: string; to: string }[] = [];
  for (const el of live.filter((e) => EDGE_TYPES.has(String(e.type))).sort(byOrder)) {
    const fromId = typeof el.startBinding?.elementId === "string" ? el.startBinding.elementId : "";
    const toId = typeof el.endBinding?.elementId === "string" ? el.endBinding.elementId : "";
    if (!fromId || !toId) continue; // 没绑定的箭头 = 装饰，不进正文
    const nameOf = (id: string): string => {
      const target = live.find((e) => String(e.id ?? "") === id);
      if (!target) return "";
      return textOf(target) || (SHAPE_TYPES.has(String(target.type)) ? shapeName(target) : "");
    };
    const from = nameOf(fromId);
    const to = nameOf(toId);
    if (!from || !to) continue;
    edges.push({ from, to });
  }

  // 节点行：有文字、且**没有被任何连线提到**的形状单独成行（提到了就已在 A → B 里）
  const mentioned = new Set<string>();
  for (const e of edges) {
    mentioned.add(e.from);
    mentioned.add(e.to);
  }
  const lonely = shapes
    .map((s) => textOf(s))
    .filter((t) => t && !mentioned.has(t));

  const lines = [...edges.map((e) => `${e.from} → ${e.to}`), ...lonely];
  return {
    text: lines.join("\n"),
    nodeCount: new Set([...edges.flatMap((e) => [e.from, e.to]), ...lonely]).size,
    edgeCount: edges.length,
  };
}
