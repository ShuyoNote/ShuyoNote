// M-B — pure helpers for the mermaid diagram block. Kept free of platform/api
// imports so the smoke harness can bundle them. mermaid itself is loaded lazily
// by the renderer (not here).

const SYNONYMS: Record<string, string> = {
  graph: "flowchart",
  flowchart: "flowchart",
  sequencediagram: "sequence",
  classdiagram: "class",
  statediagram: "state",
  erdiagram: "er",
  gantt: "gantt",
  pie: "pie",
  journey: "journey",
  mindmap: "mindmap",
  timeline: "timeline",
  quadrantchart: "quadrant",
  requirementdiagram: "requirement",
  sankey: "sankey",
  gitgraph: "gitgraph",
  xychart: "xychart",
  block: "block",
  packet: "packet",
  kanban: "kanban",
};

/** Detect the mermaid diagram type from the first meaningful source keyword. */
export function detectMermaidSyntax(src: string): string {
  const first = String(src ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("%%")) ?? "";
  const word = first.split(/[\s({]+/)[0] ?? "";
  const key = word.replace(/[-_]/g, "").toLowerCase();
  return SYNONYMS[key] ?? (key || "flowchart");
}

/** True when the source looks renderable (has a body after the directive). */
export function mermaidRenderable(src: string): boolean {
  const body = String(src ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  return body.length >= 2;
}

/** Suggested syntax options for the mermaid block's selector. */
export function mermaidSyntaxOptions(): string[] {
  return ["flowchart", "sequence", "class", "state", "er", "mindmap", "timeline", "kanban", "gantt", "pie"];
}

/**
 * mermaid 的**初始化配置** —— 唯一出处。三处渲染器都用它：
 * 编辑器图块（`editor/nodes/MermaidNode.tsx`）、md 预览（`lib/mdMermaid.ts`）、绘图弹窗
 * （`components/DrawingEditorModal.tsx`）。抄三份必漂 —— 这里就是漂出来的那次。
 *
 * ⭐ 2026-10-05 实测（owner 报"下载失败"：`Tainted canvases may not be exported.`）：
 *   `htmlLabels` **必须写在顶层**。写进 `flowchart: {}` 里 **mermaid 11 不认** ⇒ 仍然产出
 *   `<foreignObject>` 的 **HTML 标签**，两个后果：
 *     ① **canvas 变脏**、`toBlob` 直接抛错 ⇒ PNG 导不出去（Chromium 对含 `foreignObject`
 *        的 SVG 图片一律标记为 tainted，这是它的安全策略，不是我们的 bug）；
 *     ② 布局依赖**宿主 CSS/字体** —— 而 `mdMermaid.ts` 的注释本来写着"要 SVG text label
 *        （发布版/开发版一致）"：**注释说一套、配置做另一套**，这条注释从来没成立过 ✗。
 *   读数（同一段 flowchart、每种配置在**全新模块实例**里各跑一次）：
 *     `flowchart: { htmlLabels: false }`（原状）⇒ `foreignObject=6`、`<text>=5` ✗
 *     **顶层 `htmlLabels: false`** ⇒ `foreignObject=0`、`<text>=11` ✓
 *   顺带核过 `<br/>` 不退化（同一段带 `<br/>` 的标签）：
 *     原状 ⇒ `foreignObject=2`、`<tspan>=1`；顶层 ⇒ `foreignObject=0`、**`<tspan>=5`** ✓
 *     （`<br/>` 照样换成多行 —— 这正是 `mdMermaid.ts` 当初要它的理由 ✓）
 */
export function mermaidInitOptions(theme: "dark" | "default"): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme,
    // `loose`：标签里允许 `%%{init}%%` 与链接等既有写法（不动它，避免"顺手改渲染"）。
    securityLevel: "loose",
    // ⚠️ **顶层**（见上面那段读数）—— 挪进 `flowchart` 就等于没写。
    htmlLabels: false,
    flowchart: { curve: "basis" },
  };
}
