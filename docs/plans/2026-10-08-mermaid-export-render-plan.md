# mermaid 导出渲染施工单（R123 —— 导出 PDF / HTML 时图形没渲染出来）

状态：已落地（2026-10-08，windows 侧）
证据：判据 `../../src/editor/nodes/exportDom.test.ts`（mermaid 那 4 条 ✓）｜实现 `../../src/lib/exportMermaid.ts`｜线索 `../../src/editor/nodes/MermaidNode.tsx`｜接线 `../../src/components/EditorToolbar.tsx`

> **owner 的原话**：「导出 pdf 时，图形没有渲染出来」（附截图：打印预览里 mermaid 流程图**原样印成了代码**）。
> **真因**（已钉到行 ✓）：导出走 `src/components/EditorToolbar.tsx` 的 `exportPdf` ⇒ `$generateHtmlFromNodes(editor)` ⇒
> `src/lib/print.ts` 的 `printHTML`；而 Lexical 的导出**只走节点自己的 `exportDOM`** ——
> `MermaidNode.exportDOM` 写的是 `el.textContent = this.__src` ⇒ 图块到导出件里**必然**是一段源码 ✓（与截图完全对上）。

## 1. 修法形状（照本仓已有的先例，不发明第三条路）

`src/lib/exportInline.ts` 头 18 行就是为「图片导出后全空」立的规矩：
**`exportDOM` 是同步的 ⇒ 正确做法是「生成 HTML 之后再异步后处理」**（把字节/渲染结果替换进去）。

⇒ mermaid 同理：

1. `exportDOM` 只**留线索**（`data-export-mermaid`，见 `src/lib/exportMermaid.ts` 的 `EXPORT_MERMAID_ATTR`）；
2. `$generateHtmlFromNodes` 之后，`renderExportMermaid()` 找出带线索的 `<pre>` ⇒ 过 `src/lib/mermaidGate.ts`
   （全应用唯一那道串行闸门）渲染 ⇒ 替换成 `<svg>`；
3. `exportHtml` 与 `exportPdf` 两条路**共用**这一步（各写一遍 = 第二份真相源 ✗）。

⛔ **不在 `exportDOM` 里直接渲染** —— 它同步，而 mermaid 的 `render()` 是异步的。

## 2. 判据（先写、先看它红）

`src/editor/nodes/exportDom.test.ts` 的 mermaid 一组 4 条。**改之前逐字红读数**（2026-10-08，windows 侧，vitest 4.1.11）：

```text
AssertionError: expected '<p><pre>flowchart LR\n  A[开始] --&gt; …' to contain 'data-export-mermaid'
AssertionError: expected +0 to be 2 // Object.is equality      ← report.rendered
AssertionError: expected +0 to be 2 // Object.is equality      ← report.failed
 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```

改完同一命令：`Tests 8 passed (8)` ✓（`npx tsc --noEmit` ⇒ 0 ✓）。

覆盖（⛔ **不许只对 mindmap 成立** —— 这正是 owner 点名翻过车的形状）：

- **flowchart** 与**时序图（sequenceDiagram）各一条**真渲染 ⇒ 产出里 **2 个 `<svg>`**，`<pre>` 与那段源码都**不再出现** ✓；
- **渲染失败 ⇒ 退回源码**（`report.failed` 计数 ＋ `<pre>` 原样留着）—— ⛔ **不许导出空白**，那比现状更坏 ✓；
- **只认带线索的那一个 `<pre>`** ⇒ 普通代码块一个字节都不动 ✓（喂假渲染器，断言它**没被调用**）。

⚠️ **本机环境的一处代价（如实记）**：happy-dom **没有 SVG 布局** ⇒ `getBBox()` 恒 0×0 ⇒ mermaid 的**时序图**渲染器会抛
`svg element not in render tree`（实测：flowchart 不需要真测量、时序图需要）。判据里给 `SVGTextElement.prototype.getBBox`
打了一个**按字符数的合成测量**补丁，只为让「时序图也真渲染一遍」在本机跑得起来；
它**不**影响「有没有 `<svg>`」这条断言，**也**不许被当成「量过宽度」的读数 ✓。

## 3. 顺带核过、**没有**改的

| 位置 | 读数 | 结论 |
| --- | --- | --- |
| `src/components/DatabaseView.tsx` 的 `exportPdf` | 它**不走 Lexical**：导出的是一个由行值拼出来的 `<table>`，没有 `$generateHtmlFromNodes`，也就没有 mermaid 块 | **不同病** ✓，不需要同一道后处理（本次该文件一行未改） |
| mindmap 根标签居中（`src/lib/mindmapLabel.ts` 的 `fixMindmapRootAnchors`） | 它要**真布局**（`getBoundingClientRect`）才量得出来，而导出路径上**没有量过**这个读数 | 按「不许凭看起来该坏就改」⇒ **不在本次变更里** ✓（已记在 `src/lib/exportMermaid.ts` 头部） |

## 4. 未覆盖（如实列）

- **真窗口（真 WebView2）里导出一份带图的 PDF、肉眼确认图在里面**：本机没有走这一步（没有可自动化驱动的真窗口读数）
  ⇒ 判据覆盖的是「导出 HTML 里已经是 `<svg>`、不再是源码」这一层；**打印对话框那一步仍待人确认** ✓。
- **mindmap 的真渲染**：cytoscape 要 canvas 2d，happy-dom 里拿不到 ⇒ 这条**本机量不了**（flowchart / 时序图量到了 ✓）。
