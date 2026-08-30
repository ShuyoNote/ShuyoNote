# 「公式」方案（M26）— 块级 `$$…$$` + 行内 `$…$` 数学公式

> 状态：**已实现（阶段 1 块级 + 阶段 2 行内）**。日期 2026-08-30。
> 关联：块级范式同 [绘图方案](2026-08-24-drawing-solution-design.md) / [Mermaid 块]；行内范式同 [双链 PageLink](2026-08-30-pdf-reader-ai-plan.md)/`PageLinkNode`；首屏懒加载与 [Excalidraw/Mermaid 懒加载] 一致，katex 不进首屏。

## 目标

让 ShuyoNote 正文支持**数学公式**：行内 `$…$` 与块级 `$$…$$`，渲染为 KaTeX 排版。对标 Notion / FlowUs / wolai（原生公式），补齐理工科笔记、论文、教程等常见场景。

## 现状（方案前）

- 项目**无**数学公式渲染；`katex` 仅作为某依赖的传递依赖存在于 pnpm store，**未正式使用**、不在 `package.json`。
- 已有的「公式」= 数据库**公式列**（M13.4，`+ - * / ( )` 受限算术），是表格计算，与数学公式无关。
- 块级装饰节点范式成熟：`MermaidNode`（懒加载渲染器）→ 可直接复用；内联范文本节点范式成熟：`PageLinkNode`（`TextNode` 子类 + `registerNodeTransform`）。

## 设计

### 依赖

- 新增 `katex@0.16.47` 到 `dependencies`（此前是传递依赖，正式声明避免依赖传递漂移）。
- 渲染**懒加载**：`dynamic import("katex")`，Vite 拆成独立 chunk（253KB），**不进首屏主包**（与 mermaid / excalidraw 一致）。

### 阶段 1 · 块级公式块 `$$…$$`

新增 `src/editor/nodes/FormulaNode.tsx`（`DecoratorNode`，对齐 `MermaidNode`）：

- `__latex` 存 LaTeX 源；`getTextContent()` 返回源 → 进 `content_text`，可搜索 / 反链。
- `createDOM` 渲染 `.editor-formula-container`。
- `decorate()` 渲染 `<FormulaView>`（懒加载 katex，`displayMode: true`）；加载失败回退显示源文本。
- 点击进入**就地编辑**（输入框 + 完成/取消），回车提交，Esc 取消；提交经 `editor.update(() => node.setFormula(latex))`。
- `exportDOM` → `<div>$$latex$$</div>`；`exportJSON`/`importJSON` 保留 `latex` 字段。

Markdown：

- `src/editor/markdownTransformers.ts` 新增 `FORMULA` `ElementTransformer`：一行 `$$…$$` → `FormulaNode`（`regExp: /^\$\$([\s\S]+?)\$\$\s?$/`），`export` → `$$….$$`。加入 `SHUYONOTE_TRANSFORMERS`（在 `TABLE` 之后）。

入口：

- `SlashMenuPlugin` 新增 `/公式`（`∑` 图标，组「嵌入」）：`inputDialog` 输入 LaTeX → `$insertBlockNode($createFormulaNode(latex))`。

### 阶段 2 · 行内公式 `$…$`

新增 `src/editor/nodes/InlineFormulaNode.tsx`（`TextNode` 子类，对齐 `PageLinkNode`）：

- 继承 `TextNode`，存 `__latex`；**节点文本保持字面 `$latex$`** → `content_text` 包含源，可搜 / 导出兼容。
- `createDOM` 渲染 `<span class="editor-inline-formula">` 内嵌 KaTeX（`displayMode:false`，懒加载）；`updateDOM` 返回 `false`（自行管理 KaTeX 内容，防 Lexical 覆盖）。
- `exportJSON`/`importJSON` 保留 `latex` 字段。
- 编辑：直接改正文里的 `$…$` 字面文本，`registerNodeTransform` 会随输入重新渲染（不弹额外输入框，简单可靠）。

新增 `src/editor/plugins/InlineFormulaPlugin.tsx`（`registerNodeTransform(TextNode, ...)`，对齐 `PageLinkPlugin`）：

- 正则 `/(^|\s)\$([^$\n]+?)\$(?=\s|$)/g`：匹配单 `$` 包裹、**非 `$$` 块级**（块级已被 `FORMULA` element 路径消费）、同一行、前后是空白/行界。
- **防误判**：内文不以数字/逗号/句点开头（避免 `$5`、`$100` 这类钱/单位被当公式）；空内容跳过。
- 命中 → `splitText` + `$createInlineFormulaNode(text, latex)`。

### 样式（`src/App.css`）

- `.editor-formula-*`：块级容器、占位、编辑输入框（等宽字体）、完成/取消按钮。
- `.editor-inline-formula`：行内块、hover 高亮、`.editor-inline-formula-katex` 内联。

### 节点注册

- `src/editor/config.ts` `EDITOR_NODES` 加入 `FormulaNode`、`InlineFormulaNode`（`ALLOWED_NODE_TYPES` 自动派生，`lexicalValidate` 放行）。

## 边界（诚实标注）

- **行内 `$…$` 的误判控制**：对「以数字开头的 `$…$`」与「无空白包裹」的 `$…$` 不转（降低 `$5`、`$100` 误判）；若仍有零星误判，用户可保留字面文本（渲染层已尽最大努力）。
- **`$$…$$` 与 `$…$` 区分**：块级走 `FORMULA` element（整行），行内走 `registerNodeTransform`（文本流）；块级不会被行内插件重复消费。
- **行内公式编辑体验**：以「改字面 `$…$`」为主（无弹窗），比块级「就地编辑」弱，换取文本流稳定；若之后需要，可叠加点击弹编辑。
- **KaTeX 渲染**：`throwOnError:false`，非法 LaTeX 回退显示源文本，不崩编辑器。

## 验证

- `npx tsc --noEmit` 0 错。
- `node scripts/smoke-web.mjs` 全绿（不应破坏既有 transformer / 导出断言）。
- `pnpm build`：`katex-*.js` 为独立 chunk（253KB），不进首屏 `index-*.js`。
- dev 实测：
  - 块级：`/公式` 或 `$$…$$` → 渲染、点击编辑、提交更新、`content_text` 含源、导出 `$$…$$`。
  - 行内：正文输 `$E=mc^2$` → 渲染内联公式；`$5`/`$100` 保持字面；`content_text` 含 `$…$`。

## 文件清单

- `package.json`：`katex@0.16.47`（dependencies）。
- `src/editor/nodes/FormulaNode.tsx`（新增）。
- `src/editor/nodes/InlineFormulaNode.tsx`（新增）。
- `src/editor/plugins/InlineFormulaPlugin.tsx`（新增）。
- `src/editor/config.ts`（注册两节点）。
- `src/editor/markdownTransformers.ts`（`FORMULA` transformer）。
- `src/editor/plugins/SlashMenuPlugin.tsx`（`/公式`）。
- `src/editor/Editor.tsx`（挂 `InlineFormulaPlugin`）。
- `src/App.css`（公式样式）。
