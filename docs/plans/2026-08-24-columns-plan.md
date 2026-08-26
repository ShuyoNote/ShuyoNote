# 「分栏」功能方案（飞书式 Columns Block）

> 目标版本：v1.60.x（提议）。关联：[路线图](../roadmap.md)、[绘图方案](./2026-08-24-drawing-solution-design.md)、[本地优先方案](./2026-08-15-local-first-note-app-plan.md)。
> 状态：**设计 + 轻量版已实现（v1.59.168，未升版本）**。参照飞书文档的「分栏」块：N 列并排、每列一个可独立输入的栏目。本文档记录**方案讨论、两条实现路线取舍、以及当前轻量版已落地的结构与边界**，作为后续是否升级到「完整版（每列子编辑器）」的决策依据。

## 1. 背景与目标

- 现状：ShuyoNote 是**扁平块列表**（`$getRoot().getChildren()` 即顶层块），已有 / 斜杠与「+」插入菜单、块拖拽/多选、顶层块 `blockId` 机制；Callout 已展示「某个顶层 ElementNode 块能包住多个子块」的嵌套能力。
- 目标：新增「分栏」块——**飞书式 N 列并排**，插入时选 2/3/4 栏，选中后各列并排、每列独立输入，用于「左右对照 / 卡片式排版」等场景。
- 非目标（本期）：列内再套整块堆栈（标题/列表/AI 混排）、列宽拖拽、列间复制移动、嵌套分栏。这些归「完整版」路线。

## 2. 目标体验（对照飞书截图）

1. `/分栏` 或「+」插入 → 生成一个**空的分栏块**。
2. 光标进入空分栏块 → 弹出**「选择栏数」面板**（2/3/4 列条形缩略图，当前项高亮）。
3. 点选栏数 → 生成对应数量的**并排列**（每条是独立可编辑框）。
4. 每列可独立输入；整个分栏块作为**单个顶层块**参与拖拽/多选/`blockId`，列间相对位置固定。

## 3. 关键约束（现状限定）

- 顶层是**扁平块列表**：`BlockDragPlugin`（拖拽排序）、`BlockSelectionPlugin`（块多选）、`serializeWithBlockIds`（给顶层块打 `blockId`）都遍历 `$getRoot().getChildren()`。
- 可借鉴的两种节点模板：
  - `CalloutNode extends ElementNode` —— **块容器，能包住多个子块**（最贴近「一列=一个容器」）。
  - `ImageRowNode extends DecoratorNode` —— **一个节点存一组子项数据**（贴近「分栏块存 N 列数据」）。
- Lexical 的 `exportJSON` 对 ElementNode 会**自动序列化子节点**；但每个新节点须注册进 `Editor.tsx` 的 `EDITOR_NODES`，并自动进入 `ALLOWED_NODE_TYPES` 白名单（否则旧文档/导入会将其视为非法类型而丢弃）。

## 4. 两条实现路线（已讨论）

### 路线 A：自定义 ElementNode（单 contenteditable，纯 CSS 分栏）—— *当前采用*

`ColumnsNode extends ElementNode`，`children` 为 N 个 `ColumnNode extends ElementNode`（每列含段落）。

- **优点**：串行化天然支持（`exportJSON` 递归子节点）；列内可放块；改动集中于新增节点 + 一条 flex CSS；不引入嵌套编辑器；不破坏顶层块拖拽/多选/id 机制。
- **缺点**：单个 contenteditable 内并排 N 列，**跨列光标导航**、列内块拖拽/多选、列内 `/` 斜杠、AI 等插件会与顶层逻辑有边界；「列内多块堆栈」需要额外处理。

**轻量版取舍（已做）**：每列当前是**单个段落框**（`ColumnNode` 含一个 `ParagraphNode`），先满足「并排 + 独立输入」。列内暂不支持标题/列表/AI 混排、列宽拖拽。

### 路线 B：DecoratorNode + N 个嵌套 Lexical 编辑器（每列一个独立子编辑器）

`ColumnsNode extends DecoratorNode`，decorate 渲染 flex 行，每列一个独立 Lexical editor（各自 namespace/root），节点内存 N 列各自的 EditorState JSON + 列数/列宽。

- **优点**：每列是真正的块堆栈，列内 `/` 斜杠、列表、图片、AI 全可用；对页面顶层块列表零干扰；最贴近飞书。
- **缺点**：最重——N 个子编辑器、焦点/序列化/列状态/撤销栈/复制移动都要接很多线；工程量大（约 3~4 倍于路线 A）。

### 建议落地顺序

先做**路线 A 轻量版**（已交付）：在不破坏现有块机制前提下，最快交付可用的飞书式分栏。后续若确认需要「列内多块堆栈」，再基于路线 B 升级（每列改为独立子编辑器）。两条路线的 UI 与「选择栏数」面板可共用。

## 5. 已落地实现（轻量版，v1.59.168）

### 5.1 数据结构

- `src/editor/nodes/ColumnsNode.tsx`
  - `ColumnsNode extends ElementNode`，字段 `__count`（0 = 未选栏数）。
  - `createDOM` → `div.editor-columns[data-count]`；`exportJSON` 含 `count`；`importJSON` 还原。
  - `$createColumnsNode(count)`：count=0 时**先种一列占位**（避免空 ElementNode 被 Lexical 丢弃，同时触发「选择栏数」拾取器）。
  - `$setColumnsCount(node, count)`：`clear()` + 追加 N 个 `ColumnNode`（各含一个空段落）。
  - 覆写 `insertNewAfter` / `collapseAtStart` / `canMergeWhenEmpty`。
- `src/editor/nodes/ColumnNode.tsx`
  - `ColumnNode extends ElementNode`，`createDOM` → `div.editor-column`；提供 `$createColumnNode` / `$isColumnNode`。

### 5.2 选择栏数拾取器

- `src/editor/plugins/ColumnsPickerPlugin.tsx`
  - 参照 `TableMenuPlugin` 的「监听编辑器更新 + 锚定块 DOM 渲染 React 覆盖层」。
  - 监听 `registerUpdateListener`：当选中位于 `ColumnsNode` 且其 `getChildren().length <= 1`（仍是占位态）时，按块 `getBoundingClientRect()` 位置弹出「选择栏数」面板。
  - 点 2/3/4 → 走 `$setColumnsCount` 生成列；用 `getChildren().length > 1` 判断已选栏数并**隐藏面板**（不依赖可能未提交的 `__count`）。
  - 聚焦/面板打开时用 `editor.update` 内 `$getSelection` 向上走父链找 `ColumnsNode`。

### 5.3 注册与入口

- `src/editor/Editor.tsx`：`EDITOR_NODES` 加 `ColumnsNode`、`ColumnNode`；`theme` 加 `columns` / `column`；挂载 `<ColumnsPickerPlugin />`。
- `src/editor/plugins/SlashMenuPlugin.tsx`：`makeOptions` 的「嵌入」组新增 `{ key:"columns", title:"分栏", badge:"▥", run: ... $insertBlockNode($createColumnsNode(0)) }`（同时出现在 `/` 与「+」插入菜单，因为「+」复用同一份 `makeOptions`）。

### 5.4 样式（`src/App.css`）

- `.editor-columns`：`display:flex; gap` + 虚线外框 + `[data-count="0"]` 最小高度；`.editor-column`：`flex:1 1 0` + 内边距/描边。
- `.columns-picker` 及其 `.columns-pick` / `.columns-pick-bar`：浮动面板 + 2/3/4 条形缩略图，`var(--accent)` 高亮。

### 5.5 序列化 / 保存

- `ColumnsNode`/`ColumnNode` 均为 ElementNode：`exportJSON` 递归子节点，进入页面 `content_json`。
- `ALLOWED_NODE_TYPES` 由 `EDITOR_NODES.map(getType)` 派生，新节点自动放行。
- 说明：`__count` 在轻量版下**未强保证提交**（选择栏数用 `getChildren().length` 判定）；`exportJSON` 仍带 `count`，但列数主要由子节点列数还原。

## 6. 验收 / 里程碑

**轻量版（M-分栏-轻量，已实现）**

- [x] `/分栏` 与「+」插入「分栏」块。
- [x] 光标进入空分栏块 → 「选择栏数」面板（2/3/4），点选生成对应列数。
- [x] 多列并排（flex）、每列独立输入；分栏块作为单个顶层块参与拖拽/多选。
- [x] `tsc` / `vite build` / `cargo check` 通过；`scripts/smoke-web.mjs` 223 全绿；无头浏览器实测插入→拾取→并排→输入可用、无运行时错误。

**完整版（M-分栏-完整，未做，候选）**

- [ ] 每列改为独立 Lexical 子编辑器：列内可放标题/列表/图片/AI。
- [ ] 列宽拖拽、列增删、列间复制移动、跨列光标导航。
- [ ] Markdown 导出降级为并排文本块；HTML 导出为多列布局。
- [ ] `smoke` 新增列/拾取/串行化断言，且原断言无回归。

## 7. 相关文档

- [本地优先方案](./2026-08-15-local-first-note-app-plan.md)（块模型 / 串行化约束）
- [绘图方案](./2026-08-24-drawing-solution-design.md)（同为「编辑器内嵌复合块」的节点注册与内容寻址示例）
- [路线图](../roadmap.md)
