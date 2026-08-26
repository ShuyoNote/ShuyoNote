# 「分栏」功能方案（飞书式 Columns Block）

> 目标版本：v1.60.x（提议）。关联：[路线图](../roadmap.md)、[绘图方案](./2026-08-24-drawing-solution-design.md)、[本地优先方案](./2026-08-15-local-first-note-app-plan.md)。
> 状态：**设计 + 路线 B 已完整落地（v1.59.170，阶段性收尾）**。参照飞书文档的「分栏」块：N 列并排、每列一个可独立输入的栏目。本文档记录**方案讨论、两条实现路线取舍、路线 B 已实现的完整能力与诚实标注的边界**，作为后续演进（列内块拖拽/跨列复制、旧数据迁移）的决策依据。
>
> **阶段性收尾决定（v1.59.170）**：1) 路线 B（每列独立子编辑器）已达阶段性完整——列内 `/` 插标题/列表/表格/Callout/代码块/分隔线、列增删、列宽拖拽、列内撤销/跨列输入、`content_text` 并入、Markdown 导出保留列文本；2) **旧数据不做自动迁移**——`columns`/`column`(ElementNode) 保留注册可读兼容，自动改写线上内容风险高、收益低，不实施；3) **列内块级拖拽/跨列复制不做**——`BlockDragPlugin` 基于顶层块设计，列内拖块需全新跨编辑器机制，成本高风险大，现有「分栏整体可拖/重排」满足主要诉求。详见第 5 节已落地实现与第 6 节边界。

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

### 路线 B：DecoratorNode + N 个嵌套 Lexical 编辑器（每列一个独立子编辑器）—— *高级版候选*

`ColumnsNode extends DecoratorNode`，decorate 渲染 flex 行，每列一个独立 Lexical editor（各自 namespace/root），节点内存 N 列各自的 EditorState JSON + 列数/列宽。

- **优点**：每列是真正的块堆栈，列内 `/` 斜杠、列表、图片、AI 全可用；对页面顶层块列表零干扰；最贴近飞书。「列内能力零成本复用」——每列就是一个普通编辑器容器，可直接复用现有全部插件（`SlashMenuPlugin`、`InsertBlockPlugin`、AI、列表、表格、绘图等），不需要为分栏单独实现「列内插块」。
- **缺点 / 成本**：最重的一档。每列独立编辑器实例，要处理：N 个编辑器的创建/挂载/卸载（含懒挂载避免一进来就开 N 个编辑器）、主编辑器 ↔ 列编辑器的焦点转移（点列/Tab 切列/失焦不闪）、每列 EditorState 的读/写/聚合（避免每次击键全量重扫）、撤销栈（跨列/整块撤销需额外桥接，大概率先放弃、做列内独立撤销）、输入法与键盘边界（列内回车/删除/方向键、Esc 退出、中文 IME 在编辑器间切焦点）、以及让 `$getRoot`/`$getSelection` 相关插件正确指向「当前列编辑器」。工程量为路线 A 的 **约 3–4 倍**，且风险集中在**焦点/IME/撤销**这些最难的边界。
- **隐藏回归点**：
  1. **文本/搜索/反链/关系图**基于页面 `content_text`（`$getRoot().getTextContent()`）。列内是子编辑器时主编辑器不会自动包含列内文字，**需主动抽取 N 列 EditorState 文本并入**，否则列内字搜不到、反链/关系图看不到（轻量版列即段落，天然生效）。
  2. **Markdown/HTML 导出**：现有 `SHUYONOTE_TRANSFORMERS` 面向顶层块；列内多块堆栈导出需递归降级（如每列转一段或 `|` 分隔）。
  3. **块引用 `((blockId))` / `{{blockId}}` 嵌入**：基于顶层块的机制对列内块不适用，列内块无顶层 `blockId`，引用会失效（要么接受、要么额外打标）。
  4. **旧文档迁移**：已发布的 `ColumnsNode`/`ColumnNode`（ElementNode）需迁移/替换为新的 DecoratorNode + 列 EditorState，否则两种结构并存、维护两份。
  5. **性能**：一页多分栏 × 每分栏 N 编辑器，实例数 = 分栏数 × 列数，需懒挂载 + 仅激活列挂载完整插件，否则长文卡顿。

### 建议落地顺序（含高级版权衡）

先做**路线 A 轻量版**（已交付）：在不破坏现有块机制前提下，最快交付可用的飞书式分栏。两条路线的 UI 与「选择栏数」面板可共用。

**高级版（路线 B）建议分档推进，而非一步到位**：

1. **首选：先做「列内多块」的最小闭环（轻 ElementNode 方案）**——不引入子编辑器，放开 `ColumnNode` 为多块堆栈（复用 Callout 已验证的「ElementNode 包多子块」能力），让列内能放标题/列表/段落。以远小于路线 B 的代价获得大部分收益；若列内交互可用（跨列点击、列内 `/` 触发范围受限可接受）即达标。
2. **仅当确认需要「每列一套完整编辑器体验」**（列内 AI、全插件、跨列复制移动）才值得上路线 B——且须接受上述焦点/IME/撤销/文本抽取/迁移等高风险与成本。
3. **无论哪条，都先补两块地基防返工**：保证分栏文本并入 `content_text`（搜索/反链/关系图不丢）；保证现有旧分栏块可读（不因结构调整而把已发布分栏判为非法节点）。

**结论（2026-08-26 复评）**：高级版唯一实质收益是「体验达标飞书」，而列内能力可完美复用现有插件、长期维护未必更贵；但工程量大（3–4 倍）、焦点/IME/撤销/外包文本抽取等高风险边界多，且需迁移旧分栏、补导出/搜索/反链。是否值得，取决于**对「列内任意块」的看重程度**——若产品对标必需，则值得做，但建议**分步**：「先列内多块（1 档）→ 再按需升级每列子编辑器（路线 B）」。

## 5. 已落地实现（路线 B / 每列独立子编辑器，v1.59.170）

### 5.1 数据结构

- `src/editor/nodes/ColumnsNode.tsx`
  - `ColumnsNode extends ElementNode`，字段 `__count`（0 = 未选栏数）。
  - `createDOM` → `div.editor-columns[data-count]`；`exportJSON` 含 `count`；`importJSON` 还原。
  - `$createColumnsNode(count)`：count=0 时**先种一列占位**（避免空 ElementNode 被 Lexical 丢弃，同时触发「选择栏数」拾取器）。
  - `$setColumnsCount(node, count)`：`clear()` + 追加 N 个 `ColumnNode`（各含一个空段落）。
  - 覆写 `insertNewAfter` / `collapseAtStart` / `canMergeWhenEmpty`。
- `src/editor/nodes/ColumnNode.tsx`
  - `ColumnNode extends ElementNode`，`createDOM` → `div.editor-column`；提供 `$createColumnNode` / `$isColumnNode`。

### 5.2 选择栏数

- 栏数在「+」插入菜单的**分栏行右侧展开的二级子菜单**中选择：**光标移到「分栏」行即自动展开** `.insert-columns-sub`，其中用**飞书式条形范围选择**（`.insert-columns-track`：一横排 4 根竖条，光标移到第 N 根即**高亮前 N 根为蓝色**，点击该根即插入对应栏数）；选中后 `$createColumnsNode(count)` **直接生成对应列数并插入**——不再有插入后的浮层选择器。子菜单以 `position:fixed` 锚定在行右缘，因此不受父面板 `overflow:hidden` 裁剪。**主菜单整体从「+」按钮的左侧展开**（`position:fixed` + JS 钳制左侧不越界），子菜单在对应主菜单行右侧弹出。
- 曾实现并已移除 `ColumnsPickerPlugin`（插入后浮层选择栏数），其职责并入「+」二级子菜单；`/` 斜杠菜单的分栏默认插入 2 栏。

### 5.3 注册与入口

- `src/editor/Editor.tsx`：`EDITOR_NODES` 加 `ColumnsNode`、`ColumnNode`；`theme` 加 `columns` / `column`。
- `src/editor/plugins/SlashMenuPlugin.tsx`：`makeOptions` 的「嵌入」组新增 `{ key:"columns", title:"分栏", badge:"▥", run: ... $insertBlockNode($createColumnsNode(2)) }`（同时出现在 `/` 与「+」插入菜单，因为「+」复用同一份 `makeOptions`）。
- `src/editor/plugins/BlockInsertPlugin.tsx`：「+」菜单对 `key==="columns"` 项特殊渲染——点击展开 `.insert-columns-sub` 子菜单，选中栏数调 `insertColumns(count)`（先在目标空块上 `selectEnd`，再 `topLevel.replace($createColumnsNode(count))`）。

### 5.4 样式（`src/App.css`）

- `.editor-columns`：`display:flex; gap` + 虚线外框 + `[data-count="0"]` 最小高度；`.editor-column`：`flex:1 1 0` + 内边距/描边。
- 「+」菜单分栏二级子菜单：`.insert-columns-sub` / `.insert-columns-label` / `.insert-columns-row` / `.insert-columns-opt` / `.insert-columns-thumb` / `.insert-columns-bar`，2/3/4 条形缩略图，`var(--accent)` 高亮。
- 「+」插入菜单的**基础区**改为飞书式**横向图标网格**（`.insert-basic-grid`，2 列），H1/H2/H3、正文、引用、链接、待办、无序/有序列表、代码块、分隔线以图块平铺；「常用」等其它分组保持竖排行。

### 5.5 序列化 / 保存

- `ColumnsNode`/`ColumnNode` 均为 ElementNode：`exportJSON` 递归子节点，进入页面 `content_json`。
- `ALLOWED_NODE_TYPES` 由 `EDITOR_NODES.map(getType)` 派生，新节点自动放行。
- 说明：`__count` 在轻量版下**未强保证提交**（选择栏数用 `getChildren().length` 判定）；`exportJSON` 仍带 `count`，但列数主要由子节点列数还原。

## 6. 验收 / 里程碑

**轻量版（M-分栏-轻量，已实现）**

- [x] `/分栏` 与「+」插入「分栏」块；「+」分栏行**光标移上右侧自动展开二级子菜单**，用**条形范围高亮**（悬停到第 N 根高亮前 N 根，点击插入对应栏数，无需逐项点击）。
- [x] 多列并排（flex）、每列独立输入；分栏块作为单个顶层块参与拖拽/多选。
- [x] `tsc` / `vite build` / `cargo check` 通过；`scripts/smoke-web.mjs` 223 全绿；无头浏览器实测插入→拾取→并排→输入可用、无运行时错误。

**完整版（M-分栏-完整）—— 路线 B 已实现（v1.59.170），分档推进完成**

**1 档：列内多块（轻 ElementNode 方案）—— 已实现（作为路线 B 的前置）**

- [x] 放开 `ColumnNode` 为多块堆栈（复用 Callout 的「ElementNode 包多子块」能力），列内可放标题/列表/段落。
- [x] **列内 `/` 插入按列作用域（关键修复）**：新增 `blockUtils.$getInsertTargetBlock(anchor)`——沿父链上溯，**遇到 `ColumnNode` 边界或根停止**，返回列内当前块作为替换目标；`SlashMenuPlugin` 的 `$replaceBlock`/`$insertBlockNode` 及 link/code/hr 三处、`InsertShortcutPlugin`（Ctrl+Alt+1/2/3、引用/代码/链接/分隔线）均改用该 helper，避免「列内插入/快捷键误替换整个 ColumnsNode」。顶层 `/` 与快捷键行为不变（回归已验证）。
- [x] `ColumnNode` 覆写 `insertNewAfter`（列尾回车在列内加兄弟块，不逃出分栏）/`collapseAtStart`/`canMergeWhenEmpty`。
- [x] 无子编辑器、不引入焦点/IME/撤销桥接；跨列点击可用；列内 `/` 触发范围受限（列内多块）可接受。
- [x] 无头浏览器实测：列内打字 + Enter → 同列分出第二个段落（`["左列A","左列B"]`、分栏保留）；列内 `/` → 标题插入列内（`col0ChildTags:["h1"]`、`columnsStillPresent:true`）；顶层 `/` 插入不受影响；无运行时错误；`smoke-web.mjs` 224 全绿。
- [x] **列内文本并入 `content_text`**：`ColumnsNode`/`ColumnNode` 为 ElementNode，`$getRoot().getTextContent()` 递归包含列内文字（实测 `hasColumnText:true`），搜索/反链/关系图不丢。
- [x] **旧分栏块可读**：`columns`/`column` 已注册进 `EDITOR_NODES`（自动进 `ALLOWED_NODE_TYPES`），`lexicalStateValid` 递归处理嵌套 `children`；smoke 新增「嵌套 columns 块」往返断言（224 通过）。

**2 档：每列独立子编辑器（路线 B，已实现主体）**

- [x] 每列 `createEditor`/独立 EditorState；懒挂载视图（`ColumnsBlockNode` 用 `lazy()` 动态导入 `ColumnsBlockView`，打破与 `config.ts` 的循环依赖），列编辑器复用 `config.ts` 的 `EDITOR_NODES`/`editorTheme`。
- [x] 序列化聚合：`ColumnsBlockNode.__cols: string[]`（每列 EditorState JSON），`decorate` 聚合写回 → `content_json`；`importJSON` 支持 `cols[]`。
- [x] 文本抽取：`src/lib/columnsText.ts` `collectColumnsText()` 合并各列文本进 `content_text`（搜索/反链/关系图），smoke 断言通过。
- [x] 列内块插入（`/` 与快捷键）：列内 `/` 插标题/正文/引用/**Callout**/列表/**代码块**/**分隔线**/**表格**（`$replaceBlock`/`$insertBlockNode`/`INSERT_*_COMMAND` 作用到列编辑器）；列内 `Ctrl+Alt+*` 快捷键（`InsertShortcutPlugin`）。关键修复：`EMPTY_COLUMN_JSON` 补 `indent:0`/`direction`/`format`（否则 `ListItemNode.setIndent` 收到非数字 → Lexical #117）；`ColumnEditor` 挂 `TablePlugin` 让 `/表格` 可用。
- [x] 列增删：`ColumnsBlockView` 本地 state + ＋/− 按钮（1–4 列），变更经 `onChange` 持久化。
- [x] 列宽拖拽：列间分隔手柄，拖动调 `flex-grow` 权重（`flex: <weight> 1 0`），`onWidthsChange` 持久化。
- [x] 焦点/IME/撤销：每列独立 `LexicalComposer`，插件经编辑器作用域注册 → 跨列打字、列内 Ctrl+Z（列内独立撤销）实测可用，跨列不串扰。
- [x] Markdown 导出：`exportMarkdown.ts` 注册 `ColumnsBlockNode` + 展开各列文本为段落，列内容不丢（否则含分栏页面导出会因 `type columnsBlock not found` 被跳过）。
- [x] 布局修复：`ColumnEditor` 根类改 `.editor-column-body`（避免 `.editor-column` 自嵌套）；`createDOM` 返回 `.editor-columns-host`（避免 `.editor-columns` 自嵌套）；列用 `flex-grow`（避免百分比+gap 溢出）。无头实测 2/3 列均分占满、不越界。

**路线 B 已知边界 / 后续（诚实标注）**

- [ ] 列内**块级拖拽/跨列复制移动**：未做。`BlockDragPlugin` 只作用于顶层块（`getTopLevelElement()`），列内方为安全边界——分栏整体可拖/重排，列内子块不单独拖（避免跨编辑器拖拽复杂度）。若需列内拖块，需在列编辑器挂 `BlockDragPlugin` 并做跨编辑器协调（高成本/风险，未做）。
- [ ] 旧轻量版分栏（ElementNode）**自动迁移**到 `columnsBlock`：未做。`columns`/`column` 保留注册，旧文档仍可读（兼容）；自动迁移会改写线上内容，风险高，推迟。新插入均走 Route-B。
- [ ] 列内 AI 草稿插入、`{{blockId}}` 块引用对列内块不适用（诚实标注）；`smoke` 暂无多分栏性能（懒加载）断言。

> 副标题「权衡结论」见第 4 节「建议落地顺序」。**是否上路线 B 取决于对「列内任意块」的看重程度**——产品对标必需则值得，但应「先 1 档列内多块 → 再按需 2 档子编辑器」，而非一步到位。

## 6.5 演示/验证截图（Web 版实测，media/columns-demo）

以下为在网页演示版（`pnpm preview`，`dist`）上用无头浏览器实测分栏路线 B 的截图（存 `docs/media/columns-demo/`）。全程无运行时错误；列宽实测 `[201,201,201] → [256,173,173]`（第 1 列拖宽）。

| 图 | 说明 |
|---|---|
| `01-insert-menu.png` | 空块左侧「+」→ 插入菜单（AI 帮我写 + 基础/常用块） |
| `02-column-count-picker.png` | 「分栏」行右侧二级子菜单「选择栏数」，蓝条高亮前 N 根 |
| `03-inserted-3-columns.png` | 插入 3 列：均分占满宽度，每列独立编辑框 + 占位符 |
| `04-column-0-text.png` | 列 0 输入「左侧专栏内容」 |
| `05-column-1-list.png` | 列 1 `/` → 无序列表 |
| `06-column-2-table.png` | 列 2 `/` → **3×3 表格**（`TablePlugin` 生效） |
| `07-4th-column-added.png` | 末列 `＋` → 新增第 4 列，原 3 列内容保留 |
| `08-widths-before-drag.png` | 拖拽前：3 列等宽 [201,201,201] |
| `09-widths-after-drag.png` | 拖宽第 1 列后：[256,173,173]，不越界 |

> 路径：`docs/media/columns-demo/*.png`（从 `demo-shots/` 归档）。

## 7. 相关文档

- [本地优先方案](./2026-08-15-local-first-note-app-plan.md)（块模型 / 串行化约束）
- [绘图方案](./2026-08-24-drawing-solution-design.md)（同为「编辑器内嵌复合块」的节点注册与内容寻址示例）
- [路线图](../roadmap.md)
