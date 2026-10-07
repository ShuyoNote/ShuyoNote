// 导出（HTML / PDF）时把 mermaid 的**源码块**渲染成内联 SVG。
//
// ## 为什么要这一层（2026-10-08，台账 R123：owner「导出 pdf 时，图形没有渲染出来」）
//
// Lexical 的 `$generateHtmlFromNodes` **只走节点自己的 `exportDOM`**，而 `exportDOM` 是**同步**的
// （接口约束）⇒ `MermaidNode.exportDOM` 只能留下 `<pre>源码</pre>` ⇒ 图块到导出件里必然变成一段代码
// （owner 的截图里流程图就是原样印成代码的）。
//
// 同一个病本仓**已经解决过一次** ✓：`lib/exportInline.ts`（图片导出后全空）—— 它立下的形状正是
// 「**生成 HTML 之后再异步后处理**」✓ ⇒ 这里照抄：`exportDOM` 只负责**留下线索**（`data-export-mermaid`），
// 渲染与替换在生成 HTML 之后统一做 ✓。
//
// ⛔ **不要在 `exportDOM` 里直接渲染** —— 它是同步接口，而 mermaid 的 `render()` 是异步的 ✓。
//
// ## 三条口径
//
// ① **只认带线索的那一个 `<pre>`** ✓ —— 普通代码块（`<pre><code>`）一个字节都不动 ✓；
// ② **渲染失败 ⇒ 退回源码** ✓（`<pre>` 原样留着）—— ⛔ 绝不许导出空白，那比现状**更坏** ✓；
// ③ 渲染**必须过 `lib/mermaidGate.ts` 那道全应用唯一的闸门** ✓ —— 导出与编辑器里的图块共用同一条
//    队列；各建各的闸门等于没建（mermaid 的 `initialize` / `render` 动的是模块级全局状态，
//    见 `mermaidGate.ts` 头部那段"开发版没有错误、正式版有"的实测）✓。
//
// ⚠️ **本层刻意不做**的一件事：mindmap 根标签的居中修正（编辑器里那条 `fixMindmapRootAnchors`）。
//    它要**真布局**才量得出来（`getBoundingClientRect`），而导出路径上没有量过这个读数 ⇒
//    按「不许凭看起来该坏就改」的口径，它不在这一次变更里 ✓。
import { mermaidInitOptions, normalizeMindmapIndent } from "./mermaid";
import { mermaidGate } from "./mermaidGate";

/** 节点在 `exportDOM` 里留下的线索：这个 `<pre>` 是 mermaid 源码，导出后要换成 `<svg>`。 */
export const EXPORT_MERMAID_ATTR = "data-export-mermaid";

/** 一次替换的结果，给调用方如实回报（不静默吞掉失败）。 */
export interface MermaidExportReport {
  /** 成功渲染并替换成 `<svg>` 的个数。 */
  rendered: number;
  /** 渲染失败、退回源码的个数（调用方应当如实告诉用户）。 */
  failed: number;
}

/** 渲染器（可注入：判据里喂假件，真跑时用默认那个）。 */
export type MermaidRenderer = (src: string) => Promise<string>;

/**
 * 默认渲染器：动态 import mermaid ＋ 过闸门。
 *
 * **主题取 `default`（浅色）**：导出件自带的那套 CSS 是浅底（`lib/print.ts` 的 `BASE_CSS`），
 * 深色主题的图印在浅底文章里既不一致也看不清。⚠️ 这与编辑器里的图块**共用同一个闸门**，
 * 所以主题不同时闸门会按主题重新 `initialize` 一次 —— 那正是闸门本来就支持的语义
 * （`readyTheme` 变了才重来，见 `mermaidGate.ts`），不是绕过它 ✓。
 */
const defaultRenderer: MermaidRenderer = async (src) => {
  const mermaid = (await import("mermaid")).default;
  // mindmap：源文没有缩进时 mermaid 会把根底下的每一行都当成根 ⇒ 抛
  // `There can be only one root`（**只给渲染副本补缩进，用户源文一个字不动** ——
  // 与编辑器里 `MermaidNode` 走的是同一条规则）。
  const renderSrc = /^\s*mindmap\b/i.test(src) ? normalizeMindmapIndent(src).text : src;
  const { svg } = await mermaidGate.run(
    "default",
    (t) => mermaid.initialize(mermaidInitOptions(t as "default") as never),
    () => mermaid.render(`sn-export-${Math.random().toString(36).slice(2, 10)}`, renderSrc),
  );
  return svg;
};

/**
 * 把 HTML 里所有带 `data-export-mermaid` 的 `<pre>` 换成渲染出来的 `<svg>`。
 *
 * 返回**新的 HTML 片段**（不碰 `<head>`：调用方先做这一步、再交给 `docHtml` 包成完整文档）。
 */
export async function renderExportMermaid(
  html: string,
  opts: { render?: MermaidRenderer } = {},
): Promise<{ html: string; report: MermaidExportReport }> {
  const render = opts.render ?? defaultRenderer;
  const report: MermaidExportReport = { rendered: 0, failed: 0 };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = [...doc.querySelectorAll(`pre[${EXPORT_MERMAID_ATTR}]`)];

  for (const el of blocks) {
    const src = el.textContent ?? "";
    // 线索先清掉：不论成败都不该留着它（失败时留着 = 下次又试一遍，而它刚刚才失败过）。
    el.removeAttribute(EXPORT_MERMAID_ATTR);
    if (!src.trim()) continue;
    try {
      const svg = await render(src);
      const holder = doc.createElement("div");
      holder.innerHTML = svg;
      const svgEl = holder.querySelector("svg");
      if (!svgEl) throw new Error("渲染器没有产出 <svg>");
      // 独立导出件里没有宿主文档的命名空间声明 ⇒ 带上它，另存/打印才不会解析成未知标签。
      svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      el.replaceWith(svgEl);
      report.rendered += 1;
    } catch {
      // ⛔ 不许删、也不许留空 —— 退回源码（＝现状）也比"印出来一片白"好 ✓（判据里钉了这条）。
      report.failed += 1;
    }
  }

  return { html: doc.body.innerHTML, report };
}
