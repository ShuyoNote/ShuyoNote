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
 * ⭐ 2026-10-07（owner 两张截图，正式版内联报错逐字）：
 *   `渲染失败：Error: There can be only one root. No parent could be found for ("长文沉淀")`
 *
 *   真因**不是渲染器坏了**：`mindmap` 用**缩进**表示层级 ✓，而这两篇笔记里的 mindmap
 *   **一行缩进都没有** ✗（实测本机空间库：那页 22 个图，`有缩进的行 = 0` ✓，其中 5 个是 mindmap ✓）
 *   ⇒ mermaid 把「root((🏠 数友社区))」底下那十几行全当成**根节点** ✗ ⇒ dagre 报
 *   "There can be only one root" ✓✓ —— 报错原文和成因**字面对得上** ✓。
 *
 *   这个函数做的就是**把作者显然的意图补回来**：`mindmap` 且整体没有缩进时 ✓，
 *   把第一行节点（根 ✓）之后的每一行**缩进两格** ✓ ⇒ 它们成为根的子节点 ✓，图正常渲染 ✓。
 *   ⚠️ 只动**渲染时**的副本 ✓ —— 用户的源文一个字都不改 ✗（要分层请到「代码」页自己加缩进 ✓）。
 *   ⚠️ 只对 `mindmap` 生效 ✓；已经带缩进的一律原样返回 ✓（⛔ 不猜、不重排 ✗）。
 */
export function normalizeMindmapIndent(src: string): { text: string; autoIndented: boolean } {
  const raw = String(src ?? "");
  const lines = raw.split("\n");
  const firstText = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!/^mindmap\b/i.test(firstText)) return { text: raw, autoIndented: false };
  // 已经有缩进 ⇒ 尊重作者的层级，一个字都不动 ✓
  if (lines.some((l) => /^[ \t]+\S/.test(l))) return { text: raw, autoIndented: false };
  let seenDirective = false; // `mindmap` 那一行本身**不是节点** ✓（我第一版把它当成了根 ✗，判据当场拍到）
  let seenRoot = false;
  const out = lines.map((l) => {
    const s = l.trim();
    if (s.length === 0 || s.startsWith("%%")) return l; // 空行与注释原样 ✓
    if (!seenDirective) {
      seenDirective = true;
      return s;
    }
    if (!seenRoot) {
      seenRoot = true;
      return s; // 第一个节点 = 根 ✓ 不缩进
    }
    return `  ${s}`;
  });
  return { text: out.join("\n"), autoIndented: seenRoot };
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

/**
 * ⭐ 2026-10-07（owner 截图：「中心节点文本偏心了」✗）——**先量后改**的真读数
 *（在 dev 实例里真渲染 mindmap、再量 bbox ✓）：
 *
 *   | 配置 | 圈中心x | 根文本中心x | 偏心 |
 *   | `htmlLabels:false`（我们为 PNG 导出刻意关的 ✓）| -9928 | -9898 | **30px** ✗ |
 *   | `htmlLabels:true` | -9888 | -9888 | **0px** ✓ |
 *   | 无 emoji ＋ `false` | -9885 | -9869 | **16px** ✗ |
 *
 * 偏心量 ≈ **文本宽的一半**（59/2 = 29.5 ✓、32/2 = 16 ✓）⇒ 真因**不是 emoji** ✗，
 * 而是 mermaid 的 mindmap 在 `htmlLabels:false` 下给 `<text>` **没写 `text-anchor`**
 *（探针量到该属性为空 ✓）⇒ SVG 默认 `start`（左对齐）⇒ 文字从圆心往右铺 ⇒ 看着偏心 ✓。
 *
 * 修法：**渲染后给 mindmap 的 `<text>` 补 `text-anchor="middle"`** ✓
 *   · 只补**没有该属性**的那些 ✓（已经有的一个字不动 ✓）；
 *   · 只在 mindmap 上用 ✓（flowchart / pie 等不吃这一套 ✗）。
 *   ⛔ 不动 `htmlLabels` —— 那是 2026-10-05 为"下载 PNG"修的 ✗：
 *      `htmlLabels:true` 会产出 `<foreignObject>` ⇒ canvas 变脏 ⇒ PNG 导出抛
 *      `Tainted canvases may not be exported.` ✓（同一条事故，别再往回走 ✓）。
 */
export function centerMindmapLabels(svg: string): string {
  const s = String(svg ?? "");
  if (!s.includes("<text")) return s;
  return s.replace(/<text\b([^>]*)>/g, (whole: string, attrs: string) => {
    if (/\btext-anchor\s*=/.test(attrs)) return whole; // 已指定锚点 ⇒ 一个字不动 ✓
    return `<text${attrs} text-anchor="middle">`;
  });
}