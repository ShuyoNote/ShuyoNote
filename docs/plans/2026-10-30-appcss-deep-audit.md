# 方案：App.css 深度审计与优化（2026-10-30）

状态：S0 视觉基线工具 ✅；S1 纯删除 ✅（App.css 28,695→26,439 行；非空行 27.4k→25.3k；`!important` 正则 36→21、实际声明 31→16）；S2 部分 ✅（去 `!important`／合并重复规则／删死兜底）；**S2 `@layer` 脚手架 ✅（2026-10-31）**：全部既有规则保序包进 `@layer legacy`、utilities 试点 5 条、excalidraw/KaTeX 覆盖 7 条**留在层外**；判据 `src/lib/cssLayers.test.ts`，真浏览器视觉基线最差 **0.018%**（阈值 0.2%）；**S3 字号 token 化 ✅（2026-10-31）**：`tokens.json` → 生成 `tokens.css`/`tokens.d.ts`（21 档整数字号）；`var(--fs-*)` **1,161 处**、px 字号**清零**（整数＋半像素全 token 化，仅注释剩 4 处提及）；间距 `var(--space-*)` **1,401 处**、圆角 `var(--radius-*)` **632 处**；未定义变量 **0**（批 7 清零，判据钉住），判据 `src/lib/cssTokens.test.ts`；批 7 的视觉变化已由 owner 批（截图 `_tmp/acceptance/css-undef-*.png`，基线待重录）；**S4 strangler pilot ✅（2026-10-31）**：三条 CSS 判据已 glob 化到 `src/styles/**/*.css`，`.selection-toolbar` 域整段搬进 `src/styles/selection-toolbar.css`（computed 快照前后 0 差异、基线 0.026%）；**S4-2 ✅**：`check-panel-layout` 夹具改成按 import 顺序内联全部 CSS，mermaid 域（三处切片）搬进 `src/styles/mermaid.css`（夹具 61/61 前后一致、基线 0.007%）；**S4-3 ✅**：`.table-menu` 域搬进 `src/styles/table-menu.css`（computed 0 差异、基线 0.054%）；**S4-4 ✅**：media 提取器就绪，插件管理器域（236 核心＋2 组响应式）搬进 `src/styles/plugin-manager.css`（两个视口 computed 0 差异、基线 0.020%）；**S4-5 ✅**：文件管理器域（200 核心＋5 组响应式）搬进 `src/styles/file-manager.css`（0 差异、基线 0.021%）；**S4-6 ✅**：同步域（325 核心＋4 组响应式）搬进 `src/styles/sync.css`（两视口 0 差异、基线 0.020%）；**S4-7 ✅**：AI 域（208 核心＋2 组响应式）搬进 `src/styles/ai.css`（0 差异、基线 0.025%）；**S4-8 ✅**：知识地图＋顶部工具两个小域搬进独立 `.css`（0 差异、基线 0.021%）；**S4-9 ✅**：PDF 域（216 核心＋2 组响应式）搬进 `src/styles/pdf.css`（0 差异、mobile-overlays 756/756）；**S4-10 ✅**：活动栏＋附件面板两个小域搬进独立 `.css`（0 差异、基线 0.032%）；**S4-11 ✅**：邮箱域（252 条）搬进 `src/styles/email.css`（0 差异、基线 0.036%）；**S4-12 ✅**：设置域（302 核心＋2 组响应式）搬进 `src/styles/settings.css`（0 差异、基线 0.027%；`.set-space-crypto` 与侧栏共享规则例外保留）；**S4-13 ✅**：属性面板域（119 核心＋2 组响应式）搬进 `src/styles/properties.css`（v6 顺序保持提取器修 53 处层叠差异后 0 差异、基线 0.016%）；**S4-14 ✅**：目录树域（58 条）搬进 `src/styles/tree.css`（三视口 0 差异、基线 0.020%）；**S4-15 ✅**：社区发布域（60 条＋1 组响应式）搬进 `src/styles/community.css`（三视口 0 差异、基线 0.025%）；**S4-16 ✅**：移动阅读/首页域（85 条＋3 组响应式）搬进 `src/styles/mobile-read.css`（四视口 0 差异、mobile-views 249/249＋overlays 756/756、基线 0.033%）；**S4-17 ✅**：编辑器域（147 条＋2 组响应式）搬进 `src/styles/editor.css`（三视口 0 差异、基线 0.013%）；**S4-18 ✅**：侧栏与空间切换域（87 条＋4 组响应式）搬进 `src/styles/sidebar-space.css`（三视口 0 差异、移动双门禁 249/249·756/756、基线 0.028%；`.space-item-crypto` 共享规则例外保留）；**S4-19 ✅**：数据库表格域（179 条＋1 组响应式）搬进 `src/styles/database.css`（三视口 0 差异、移动双门禁、基线 0.020%）；**S4-20 ✅**：外壳域（30 条＋3 组响应式）搬进 `src/styles/shell.css`（三视口 0 差异、移动双门禁、基线 0.030%）；**S4-21 ✅**：标签/表情选择器搬进 `tag-picker.css` / `emoji-picker.css`（三视口 0 差异、移动双门禁、基线 0.016%）；**S4-22 ✅**：搜索浮层域（47 条＋1 组响应式）搬进 `src/styles/search.css`（三视口 0 差异、移动双门禁、基线 0.011%）；**S4-23 ✅**：存储面板域（45 条＋1 组响应式）搬进 `src/styles/storage-panel.css`（三视口 0 差异、移动双门禁、基线 0.027%）；**S4-24/25 ✅**：移动配对（84 条）＋移动外壳/快速记录（35 条）搬进 `mobile-pair.css` / `mobile-capture.css`（三视口 0 差异、移动双门禁、基线 0.019%）；**S4-26 ✅**：关于对话框域（85 条＋1 组响应式）搬进 `src/styles/about.css`（三视口 0 差异、移动双门禁、基线 0.021%）；**S4-27 ✅**：快捷键/Markdown 导入/封面选择器（16＋11＋14 条，各 1 组响应式）搬进 `shortcuts.css` / `markdown-import.css` / `cover-picker.css`（三视口 0 差异、移动双门禁、基线 0.036%）；**S4-28 ✅**：插件面板/视图域（35 条＋3 组响应式）搬进 `src/styles/plugin-panel.css`（三视口 0 差异、移动双门禁、基线 0.017%）；**S4-29 ✅**：网页书签/账户设备/移动设置（14＋9＋7 条，0 媒体）搬进 `webbookmark-card.css` / `account.css` / `mset.css`（三视口 0 差异、移动双门禁、基线 0.034%）；**S4-30 ✅**：MCP 接入状态域（13 条，含 1 条单行规则手工搬）搬进 `src/styles/mcp-access.css`（三视口 0 差异、移动双门禁、基线 0.028%）；**S4-31 ✅**：内联绘图（16 条，第三方覆盖 5 条留层外）＋血统冲突横幅（11 条＋1 组响应式）搬进 `inline-drawing.css` / `conflict-lineage.css`（三视口 0 差异、移动双门禁、基线 0.017%）；**S4-32 ✅**：命令面板域（28 条＋1 组响应式）搬进 `src/styles/palette.css`（三视口 0 差异、移动双门禁、基线 0.018%）；**S4-33 ✅**：模板中心（39 条＋2 组响应式）＋关系图控件（7 条＋1 组响应式）搬进 `template-center.css` / `graph-controls.css`（三视口 0 差异、移动双门禁、基线 0.021%）；**S4-34 ✅**：块操作域（57 条）搬进 `src/styles/block.css`（三视口 0 差异、移动双门禁、基线 0.020%）；**S4-35 ✅**：看板视图域（31 条＋1 组响应式）搬进 `src/styles/board.css`（三视口 0 差异、移动双门禁、基线 0.020%）；**S4-36 ✅**：标题栏（13 条）＋按钮基元（21 条）＋公式编辑器（4 条，各 1 组响应式）搬进 `titlebar.css` / `buttons.css` / `formula-editor.css`（三视口 0 差异、移动双门禁、基线 0.018%）；**S4-37 ✅**：页面壳（16 条）＋数据库页（17 条，各 1 组响应式）搬进 `page.css` / `database-page.css`（三视口 0 差异、移动双门禁、基线 0.045%）；**S4-38 ✅**：确认框（16 条）＋开关（5 条）＋公式工具栏（26 条，各 1 组响应式）搬进 `confirm.css` / `ui-toggle.css` / `formula.css`（三视口 0 差异、移动双门禁、基线 0.021%）；**S4-39 ✅**：移动首页/搜索/外壳（43 条）搬进 `src/styles/mobile-home.css`（三视口 0 差异、移动双门禁、基线 0.022%）；**S4-40 ✅**：移动端缺失同步（25 条）＋词典（13 条）＋底部弹层（17 条）搬进 `missing-sync.css` / `mobile-dict.css` / `mobile-sheet.css`（三视口 0 差异、移动双门禁、基线 0.018%）；**S4-41 ✅**：关系图视图域（30 条＋1 组响应式）搬进 `src/styles/graph.css`（三视口 0 差异、移动双门禁、基线 0.031%）；**S4-42 ✅**：反链面板（11 条＋1 组响应式）＋面包屑（5 条＋1 组响应式）搬进 `backlinks.css` / `breadcrumbs.css`（三视口 0 差异、移动双门禁、基线 0.019%）；**S4-43 ✅**：编辑器零散小簇（27 条＋2 组响应式）搬进 `src/styles/editor-misc.css`（三视口 0 差异、移动双门禁、基线 0.018%）；**S4-44 ✅**：锁屏/解锁域（28 条）搬进 `src/styles/lock.css`（三视口 0 差异、移动双门禁、基线 0.030%）；**S4-45 ✅**：mac 窗口控件域（13 条，平台专属 0 media）搬进 `src/styles/mac-window.css`（三视口 0 差异、基线 0.023%）；**S4-46 ✅**：表情选择器内层域（21 条）搬进 `src/styles/emoji-picker-inner.css`（含 390px 媒体对照 0 差异、移动双门禁、基线 0.016%）；**S4-47 ✅**：目录侧栏域（14 条＋1 组响应式）搬进 `src/styles/toc.css`（三视口 0 差异、移动双门禁、基线 0.019%，App.css 7,434 行）；后续批次见 §13。审计读数见 §2、执行记录见 §11/§12（截至 2026-10-31）

关联：`src/lib/cssHygiene.test.ts`（既有「只减不增」判据）· `docs/TESTING.md`（门禁总表）· 测量脚本（临时）：`_tmp/scratch/analyze-app-css.mjs`、`analyze-app-css2.mjs`

## 1. 口径

- 用 **postcss 8.5.26 解析**（不是正则），统计规则/选择器/声明/at-rule；
- 类名使用情况：扫 `src/**/*.{ts,tsx,js,jsx,html}` 里是否出现该 class（⚠️ 动态拼接的类名可能被误判为"未使用"，见 §3.4 的复核办法）；
- 测量时间点：`dev @ f21f4fbb`（2026-10-30）。

## 2. 现状读数（实测）

| 指标 | 读数 |
|---|---|
| 文件 | **`src/App.css` 一个文件**：27.4k 行 / 814 KB / **gzip 207 KB** |
| 规则 / 选择器 / 声明 | **4,536 / 4,949 / 18,722** |
| at-rule | 46（其中 `@media` **25**、`@keyframes` 21） |
| 注释 | 1,101 条（写得不少，这是优点） |
| `!important` | **31**（既有基线 36，已降） |
| ID 选择器 | 1（`#root`，合理） |
| 深选择器（后代层数 ≥4） | **91** |
| 选择器列表 >5 项 | 18 |
| 重复选择器出现 | **472 次**（含 `to/from/0%/100%` 等 keyframe 步骤；真实重复如 `.sync-popover`×5、`.set-dialog`×5、`.activity-bar`×4） |
| 完全相同的规则体 | 19 |
| CSS 里定义过的 class | **2,730** |
| **从未在源码出现的 class** | **344**（Top：`acct-device-edit` 11 / `space-privacy-more` 7 / `sync-nearby` 6 / `block-menu` 5 / `block-context-menu` 5） |
| 颜色字面量 | hex **391** / rgb(a) **188**；同期 `var(--…)` 引用 **4,584** |
| 硬编码 `font-size` | **1,305 处**，但只有 15 种值（12px 396 / 13px 252 / 11px 202 / 14px 97 …） |
| `z-index` 字面量 | 60×11、40×9、30×8、**1500×8、1200×8**、200×5、45×4…（另一部分是 token，但只有 5 处用 `var(--z-popover)`） |
| CSS 变量 | 定义 84 个、使用 100 个；**用了但从没定义 31 个**（`--primary`、`--text-muted`、`--bg-1`、`--radius`、`--font-mono`、`--cat-*-soft`…）；**定义了没人用 15 个**（`--z-modal/--z-palette/--z-toast/--space-1..8/--transition-slow`） |
| 媒体查询断点 | **13 种不同条件**：768(8)、900(3)、720(3)、600、601、520、480、520(height)、以及 `hover`/`prefers-reduced-motion` 组合 |
| 组件内联样式 | **160 处 `style={{}}`**（DatabaseView 11 / PdfAnnotationCanvas 11 / EmailPanel 10 / PageTree 9 …） |
| 分层 | 无 `@layer`；无 `@supports`；无 CSS Modules |

## 3. 六类问题（按严重度）

### 3.1 🔴 单文件 814 KB：改动半径 = 全站风险

一个 `App.css` 承载全部样式（编辑器、侧栏、设置、同步、MCP、PDF、看板…），任何一处改动都在同一张层叠表里竞争，冲突只能靠"再加一条更具体的选择器"解决 ⇒ 这正是 §3.2/§3.3 的温床。
**证据**：`:root` 单条规则 **2,152 个字符**；重复选择器 472 次；同名 class 在文件里出现 5 次的就有多个。

### 3.2 🔴 Token 体系是"半迁移"状态（最隐蔽的坑）

- 4,584 处用 `var()`（好消息）；
- 但仍有 **391 + 188** 处颜色字面量，Top 是 `#fff`(54)、`#4f7cff`(44)、`#e5484d`(22) —— 这三个应当就是品牌色/危险色，却以字面量散落；
- **31 个 `--x` 被使用却从未定义**（`--primary`、`--text-muted`、`--bg-1`、`--radius`、`--font-mono`、`--cat-*-soft` …）。它们靠 `var(--x, 兜底值)` 活着 ⇒ **换主题/换皮时不会报错，只会静默用兜底值**；
- **15 个定义了却没人用**（`--z-modal/--z-palette/--z-toast/--space-1..8`）⇒ 曾计划过 z 轴与间距刻度，但没落地。

**后果**：主题一致性靠运气；"为什么这个按钮在暗色下不对"要 grep 三遍。

### 3.3 🟠 类型/层级/断点三套刻度都没统一

- 字号：1,305 处硬编码，15 种值（含 11.5px / 12.5px / 10.5px 这类半像素值）⇒ 没有 type scale，排版靠手感；
- `z-index`：字面量 60/40/30/**1500/1200**/200/45/20 混用，同时又有未使用的 `--z-*` token ⇒ 弹层顺序是"数出来的"不是"定义的"；
- 断点：13 种条件（768/900/720/600/601/520/480 + 高度/hover/动效偏好），601 与 600 并存 ⇒ 移动端适配碎片化（这也是 mobile 组反复红的土壤）。

### 3.4 🟠 死样式 344 个 class（需二次复核再删）

CSS 定义了 2,730 个 class，**344 个从未出现在源码里**（Top 见 §2 表）。
⚠️ 复核办法（避免误删）：对每个候选 class，再搜 `className={\``、`'`+class+`'` 的模板拼接、以及 `.ts` 里的字符串常量；只有"三种搜法都没有"才判定为死样式。**一次最多删 50 个**，每批跑一次 mobile/页面快照。

### 3.5 🟡 31 处 `!important` 中有"特异性打架"信号

合法用法：`prefers-reduced-motion` 的全局 `*{animation:none!important}`、`display:none` 覆盖第三方控件。
**可疑**：`.tree-row-selected`、`.board-card-dragging`、`.block-select-mode-btn`、`.prop-tag-value` 的 important —— 通常是"被更具体的选择器压住了，直接上 !important"的结果，应回溯到源头（降低对方特异性）而不是继续加。

### 3.6 🟡 160 处内联样式 = 静态样式漏进了 TSX

内联样式只该留给**运行时算出来的值**（拖拽坐标、图表尺寸）。但实测里有很多静态的（如 `style={{minHeight:44}}`、`display:flex`）⇒ 主题/窄屏规则管不到它们，也是 mobile 预算反复失守的原因之一。

## 4. 优化方案（四阶段，每阶段可独立合入）

### P0：把审计变成机器判据（1–2 天，零视觉风险）

1. 新增 `scripts/check-css-audit.mjs`（用 postcss 解析，**只读、输出 JSON**），检查：
   - `!important` ≤ 基线（沿用 `cssHygiene` 的 31）；
   - 重复选择器组数 ≤ 基线（记录当前值，只减不增）；
   - 完全相同的规则体 = 0（新增）；
   - **用了但没定义的 CSS 变量 = 0**（新增，最值钱）；
   - 新 `font-size` 字面量 / 新 `z-index` 字面量 / 新颜色字面量：**不得增加**（按基线）；
   - 断点白名单：`480 / 600 / 768 / 900 / 1200` ＋ 已登记的 4 种功能型条件（hover / prefers-* / 高度）；
   - 单文件行数上限（先 28,000，随拆分下调）。
2. **修 31 个未定义变量**：统一映射到已有 token（或补别名），`var(--x, 兜底)` 里的兜底值保留一层但必须指向真实 token；
3. 删 **19 个完全重复的规则体**、合并重复选择器组；
4. 删死样式 **第一批 50 个**（按 §3.4 三种搜法复核后）。

判据：`node scripts/check-css-audit.mjs` exit 0；`cssHygiene.test.ts` 不回归；mobile 组与页面快照不变。

### P1：三套刻度 token 化（3–5 天，需视觉抽检）

1. **字号刻度**：定义 `--fs-10 / --fs-11 / --fs-12 / --fs-13 / --fs-14 / --fs-16 / --fs-18 / --fs-22 / --fs-24`，用 codemod 把 1,305 处 `font-size:<n>px` 映射过去（半像素值归一：11.5→12、12.5→13、10.5→11，逐屏对比）；
2. **z 轴刻度**：定义 `--z-content:10 / --z-sticky:20 / --z-dropdown:30 / --z-popover:40 / --z-overlay:50 / --z-modal:1000 / --z-toast:1100 / --z-palette:1200`，把 1500/1200/200/60… 归位；删掉未使用的 `--z-*`（或给它们真实用途）；
3. **断点刻度**：统一 `480 / 600 / 768 / 900`，把 601→600、520→480/600、720→768；
4. **颜色 token**：把 `#fff`→`var(--surface)`、`#4f7cff`→`var(--brand)`、`#e5484d`→`var(--danger)`，其余字面量按用途归类（文字/边框/背景/状态）。

判据：`check-css-audit` 里"字面量新增 = 0"；三套 scale 的数量分别为 15→9、8+→8、13→5；夜/日两主题截图对比。

### P2：文件拆分 ＋ 级联层（1–2 周，需 owner 拍一次）

1. 拆成 `src/styles/{tokens,base,layout}.css` ＋ `src/styles/components/{editor,tree,settings,sync,mcp,pdf,board,props,...}.css`，由 `src/index.css` 顺序 `@import`（Vite 打包后仍是单文件，无运行时成本）；
2. 加 `@layer tokens, base, layout, components, utilities`，把 31 处 `!important` 逐步降为 0（`prefers-reduced-motion` 的全局例外保留并在文件里注明）；
3. 每个样式文件 ≤ 2,000 行（门禁），命名前缀按组件域（`fm-`/`prop-`/`mcp-`…），新增 class 必须落进已有前缀（审计脚本检查"孤儿前缀"）。

判据：文件数 > 1；门禁 `no-file>2000-lines`；`!important` 从 31 降到 ≤ 10；移动端/桌面截图矩阵一致。

### P3：内联样式收口 ＋ 防回归（持续）

1. 160 处内联样式里，**静态值**迁到 class（先做 Top 5 文件：DatabaseView 11、PdfAnnotationCanvas 11、EmailPanel 10、PageTree 9、SyncPanel 8）；动态值（坐标/宽度）保留；
2. 审计脚本加一条：`style={{` 总数只减不增；
3. 新增 **视觉回归快照**（桌面 1280 / 移动 320 与 375 / 暗色主题 4 张，关键页面 8 个），迁移前后各跑一次。

## 5. 目标指标（3 个月）

| 指标 | 现在 | 目标 |
|---|---|---|
| App.css 行数 / 文件数 | 27.4k / 1 | ≤ 8k / ≥ 8（拆分后单文件 ≤2k） |
| 未定义 CSS 变量 | 31 | **0** |
| 颜色字面量 | 579 | ≤ 100（且全部在 tokens.css） |
| `font-size` 字面量 | 1,305 | ≤ 50（其余走 `--fs-*`） |
| `z-index` 字面量 | ~60 | ≤ 10（其余走 `--z-*`） |
| 断点种数 | 13 | 5（480/600/768/900 + 功能型） |
| 死 class | 344 | ≤ 100 |
| `!important` | 31 | ≤ 10 |
| 内联样式 | 160 | ≤ 60（只留动态值） |

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| codemod 改 1,305 处字号导致细微视觉变化 | 分批（每批 ≤200 处）＋每批截图对比；字号只做"归一"不做"重新设计" |
| 拆文件改变层叠顺序 → 全局样式回退 | 拆分时**保持原顺序**切块，先只搬不并；`@layer` 单独一步、可一键 revert |
| 删死样式误删动态类 | 三种搜法复核 ＋ 一次 ≤50 个 ＋ 每次删后跑 mobile/页面快照 |
| `!important` 降级引发局部失效 | 一次只降 3 处，逐屏核对；保留 `prefers-reduced-motion` 例外 |
| 大文件改动与其它分支冲突 | 拆分/格式化类改动单独分支、单独一天做，避免与功能分支并行 |

## 7. 与现有门禁的关系

- `src/lib/cssHygiene.test.ts`：已有「`!important` 与重复选择器只减不增」；本方案 **不替换它**，P0 的审计脚本是它的严格超集（新增变量/字面量/断点/文件行数四类）；
- `scripts/check-panel-layout.mjs`、`verify-mobile-views.mjs`：移动端预算（44/60/150）会继续抓 P1/P2 的回归；
- 新门禁要按仓规矩注册进 `scripts/lib/gates.mjs` 并留"看过它红"的变异证据。

## 8. 待 owner 拍板

```text
Q1 P2 的文件拆分（单文件 → ≥8 个，仍由 index.css 汇总）是否现在做？沉默 ⇒ 只做 P0/P1（低风险）。
Q2 P1 的字号 codemod 会把 11.5px/12.5px/10.5px 归一成 12/13/11 —— 允许这种"轻微视觉变化"吗？沉默 ⇒ 允许。
Q3 死样式第一批删 50 个（Top 名字在 §2）—— 允许吗？沉默 ⇒ 允许先删 20 个。
```

## 9. 方案 v2（推荐，取代 §4 的优先级）

> 触发：owner 问「还有更好的方案吗」。重看数据后，**§4 的排序是错的**（安全网放最后、把"整理"当目标）。
> v2 的目标改成**减少冲突面积**，而不是"把代码整理好看"。

### 9.1 四处分歧（v1 → v2）

| 项 | v1（§4） | v2（推荐） | 理由 |
|---|---|---|---|
| 安全网 | 放 P3（最后） | **放第 0 步** | 没有视觉回归就不该做任何批量 codemod；这是 v1 最大的排序错误 |
| 首要动作 | 先建审计门禁/修变量 | **先删除**（343 死 class ＋ 19 重复规则体 ＋ 15 未用 token ＋ 重复选择器组） | 删除是**零视觉变化**的收益（预计减 4–8% 行数），且直接缩小后续所有改动的冲突面 |
| 大文件 | P2 才拆 | **不拆文件，先加 `@layer`**：整份现有内容包进 `@layer legacy`，新代码写进 `tokens/base/layout/components/utilities` 层 | 新代码**天然赢过旧代码**，不需要再加更具体选择器或 `!important` —— 一天、一行可回滚，立即止住特异性军备竞赛 |
| 拆分方式 | 一次性拆 8 个文件 | **strangler**：只在"真要改那个组件"时把它的 CSS 抽成 `*.module.css`，并从 legacy 删掉对应规则 | 避免全站视觉风险；按 prefix 域自然分（sync 605 / set 420 / pdf 320 / email 306 / ai 273 / editor 271 / fm 271 …） |

### 9.2 数据补充（v1 漏掉的）

```text
间距字面量：2,985 处 px（8px 568 / 6px 378 / 10px 371 / 12px 343 / 4px 296 / 2px 203 …），
            而 var() 只有 82 处 —— **比字号(1,305)更大的一坨**，v1 完全没算它。
死 class 的 prefix 分布：sync 37 / set 24 / draw 21 / fm 19 / space 16 / ai 14 / comments 13 …
            ⇒ 死代码集中在"已下线或改版过"的功能域，删除收益集中。
class prefix 体量：sync 605 / set 420 / is-(状态) 367 / pdf 320 / email 306 / ai 273 / editor 271 / fm 271 …
            ⇒ 天然拆分边界存在；`is-` 是跨域状态类，应归 utilities 层。
```

### 9.3 v2 执行顺序（两周）

| 步 | 内容 | 判据 | 风险 |
|---|---|---|---|
| **S0（半天）** | 视觉回归基线：桌面 1280 / 移动 320·375 / 暗色，8 个关键页，截图存基线 | 基线图可重跑、差异为 0 | 无 |
| **S1（1–2 天）** | **纯删除**：343 死 class（三种搜法复核，每批 ≤50）、19 重复规则体、15 未用 token、重复选择器组合并；**不新增任何规则** | 截图 0 差异；行数下降；`cssHygiene` 不回归 | 低（可 revert 单批） |
| **S2（1 天）** | **`@layer` 脚手架**：文件顶部声明层序，现有全部内容包进 `@layer legacy`；`is-` 类迁 `utilities` 层试点 | 新规则不加 `!important` 即可覆盖旧规则（写一条验证用例）；`!important` 不增 | 低（一行可回滚；Chromium 99+/WebView2 均支持） |
| **S3（2–3 天）** | **tokens 单一真相源**：`styles/tokens.json` → 生成 `tokens.css` + `tokens.d.ts`；先补 `--space-1..8`（2/4/6/8/10/12/16/24）与 `--fs-*`；stylelint 规则：禁 `var(--未定义)`、禁新增字面量 | 未定义变量 **31→0**；字面量新增 0（基线冻结） | 中（生成物改动，逐批） |
| **S4（1 周，边做边迁）** | strangler：从"当前正在改的组件"开始（属性面板 prop 115、MCP/mpair 102、文件区 fm 271、同步 sync 605），抽 `*.module.css` + 容器查询；抽完从 legacy 删旧规则 | 每个模块：截图 0 差异、无新增 `!important`、该域 CSS 行数下降 | 中（按域隔离，可逐个回滚） |
| **S5（持续）** | 内联样式静态值迁 class（Top5：DatabaseView 11 / PdfAnnotationCanvas 11 / EmailPanel 10 / PageTree 9 / SyncPanel 8）；控件尺寸 token 化（`--control-min:44px`、`--toolbar-h:60`）让 mobile 预算"按构造满足" | 内联只减不增；mobile 组不再因散装 CSS 超预算 | 低 |

### 9.4 v2 明确**不做**的（省 60% 风险）

- ⛔ 不做"一次性把 27k 行拆成 8 个文件"：收益（可读性）小于风险（层叠顺序变化可能是全站级）。
- ⛔ 不做"全仓 CSS Modules 化"：只迁正在改的组件，未动的不碰。
- ⛔ 不追 gzip 体积（桌面应用，207KB 不是瓶颈）；追**冲突面积**（重复/死代码/特异性）。
- ⛔ 不在 S0 之前做任何字号/间距批量 codemod。

### 9.5 预期（两周后）

```text
行数 27.4k → ~25.5k（纯删除）→ 不再增长（@layer + stylelint 冻结字面量）
未定义变量 31 → 0（tokens 生成 + lint）
死 class 343 → ≤150
!important 31 → ≤25（新代码不再需要）
移动端"散装 CSS 超预算"类失败 → 显著减少（控件尺寸 token 化）
```

## 10. owner 拍板（2026-10-31）

```text
1 = A1：CI 的 rust-cache 钉版本（Swatinem/rust-cache@v2.7.8），不动其它 workflow 结构；
2 = B1：视觉基线先用本机 CDP 工具（已实跑：5 图、0.000%~0.012% 稳定；真变异 2.395% 能抓到），暂不进 CI；
3 = C2：死样式按"安全删"档每批 50 个推进，每批跑全量＋基线；
4 = 只做完全等值替换：字号/间距只替换成**数值完全相同**的 token（11px→--fs-11、8px→--space-2），半像素值（11.5/12.5/10.5）留到有稳定基线后再议。
```

执行顺序（据 §9 v2）：S0 基线工具入库 → S1 纯删除（C→A→D，每批 50）→ S2 `@layer` 脚手架 → S3 tokens 生成 → S4 strangler。

## 11. 执行记录（截至 2026-10-31）

| 批 | 内容 | 读数 |
|---|---|---|
| S1-C | 删 5 个零引用变量（`--z-*` 后来发现需要、已恢复） | — |
| S1-A | 11 组完全重复规则（同选择器＋同 body＋同 at-rule） | -45 行，基线 0.012% |
| S2-a | 100 处「token 已定义」的死兜底 `var(--x, fallback)`→`var(--x)` | 视觉 0.004% |
| S2-b | `.sync-popover.is-inline` 两条主体合并 | -6 行，视觉 0.012% |
| S2-c | 四组 `!important` 改提特异性（db 表格 / fm-empty / 块选择 / 属性标签值） | `!important` 36→26 |
| S2-c' | 再 5 条 `!important`（board/tree-row/block-selected/tag-color/db-item） | `!important` **21→16**，视觉 0.009% |
| S1-D | **274 个 A 档死 class → 344 条规则 / 12 个选择器项** | App.css **28695→26439 行**（-2256） |
| S2-d | **`@layer` 脚手架**：顶部 `@layer legacy, utilities;`；全部既有规则保序包进 `@layer legacy`（`:root` 变量照常生效）；utilities 试点 5 条（`.is-dragging-block` / `.is-sidebar-resizing` / `.is-ai-resizing` 三族）；excalidraw＋KaTeX 覆盖 **7 条搬到层外**（它们的 CSS 懒加载注入、未分层 ⇒ 进层会被压掉）；`mcp-panel.css` 同入 legacy 层 | 结构判据 `src/lib/cssLayers.test.ts`（4 条）＋ `cssHygiene` 8/8；真浏览器基线 **5 图最差 0.018%**（阈值 0.2%）、metrics 差异 0；`!important` 不增；happy-dom 不支持 `@layer` ⇒ 两条注入式测试改用 `src/lib/unlayerForHappyDom.ts` 扁平化后判同一批规则 |

### ⚠️ 这一段最贵的教训：**按行号区间删 CSS 会把两条规则拼在一起**

第一次批 D（`ca8a219e..0b444432`）是**按行号区间**删的：D-2 那批把

```css
.btn-trash, .btn-backup, .btn-import, .btn-theme, .btn-sidebar-toggle, .btn-search { … }
```

的规则体删掉时，连带把**下一条** `.trash-popover { … }` 的**选择器**接了上来 ⇒ 最终变成

```css
.btn-trash, .btn-backup, .btn-trash:hover, .btn-backup:hover, .trash-popover {
  position: fixed; width: 300px; box-shadow: var(--shadow-md); z-index: …;
}
```

⇒ 活的 `.btn-trash` 吃到了「固定定位 + 300px 宽 + 阴影 + z-index」。

**抓住它的不是单元测试**（全量 3800 passed 全绿），而是两条验收：

1. **端点视觉基线**：`96971f6c → 0b444432` 三视口 0.22~0.30%（超 0.2% 阈值），`git bisect` 到 D-2；
2. **逐元素 computed 样式对比**（`_tmp/scratch/compare-styles.mjs`：两套构建各开一次浏览器，对每个 DOM 列 21 个计算属性）⇒ 精确报出 `[btn-trash] box-shadow: none → 0 4px 16px; padding: 0 → 4px 10px; z-index: auto → 700`。

**重做规则（已写进脚本 `_tmp/scratch/apply-dead-all.mjs`）**：
- 必须**用 postcss AST**：整条规则 `rule.remove()` / 混合选择器只 `rule.selectors = keep`；⛔ 绝不按行号区间删；
- 删前把类名在 `scripts/` `capabilities/` `tools/` 里再 grep 一遍（验收脚本会把 class 当选择器）；
- 删后两道验收：**逐元素 computed 差异必须为 0**，再跑端点像素基线（三视口 0.000%）；
- 备份：重做前打 tag `css-d-redo-backup`（指向被回滚的那版），回滚成本 = 一次 `git reset`。

AST 重做后的读数：规则 4535→4191、行数 28695→26439、**逐元素 computed 差异 0 处**、三视口像素 **0.000%**、全量 vitest **3800 passed**。

## 12. S3：tokens 单源 ＋ 字号 token 化（2026-10-31）

- **生成器**：`scripts/gen-css-tokens.mjs` —— 源 `src/styles/tokens.json` → 生成 `src/styles/tokens.css` ＋ `tokens.d.ts`；`src/App.tsx` 在 `App.css` 之后 import（层序已由 App.css 的 `@layer legacy, utilities;` 声明，tokens 自己也落 `@layer legacy`）。⛔ 改刻度只改 json + 跑生成器。
- **刻度**：只收**数值已存在**的整数字号（9–52 共 21 档）；半像素（11.5/12.5/10.5…）按 owner 2026-10-31 拍板**暂不纳入**。
- ⚠️ **`--space-1..8` 已存在，但不是**本方案 §9.3 草稿里的 `2/4/6/8/10/12/16/24`，而是 **`4/8/12/16/24/32/40/64`** ⇒ 本轮**不重定义**（重定义会改所有用点）；间距 token 化另立一批并先量用点。
- **批次 1**：`font-size: 12px / 13px` → `var(--fs-12/13)`，共 **585 处**（12px 353 ／ 13px 232；注释里提到的 2 处未动）；剩余 `font-size` 字面量 **577**（冻结，只减不增）。
- **批 0（零视觉，2026-10-31）**：修 `cssTokens` 扫描器假阳性 —— 定义正则原带 `^` 行首锚 ⇒「一行两个定义」只认第一个、「作用域内定义」看不见；使用扫描没剥注释 ⇒ 注释里的 `var(--brand)` 被当成使用。修后 + 补 `--fill` 运行时白名单：**26 → 真 14**。
- **批 1（零视觉）**：`--plugin-panel-w`（2 处，本来就带 420px 兜底）→ 落成 `420px`。
- **批 2（零视觉）**：`--bg-2`（1）／`--border-faint`（3 种兜底）／`--fill-soft`（2）／`--text-muted`（6 种兜底）的 `var(--x, 兜底)` 换成**兜底字面量**，共 12 处 —— 变量未定义时浏览器本来就用兜底值，去掉 var 计算值不变。
- **批 3（零视觉，2026-10-31）**：其余**整数** `font-size: Npx` → `var(--fs-N)`，共 **445 处**（注释里的 4 处提及不动；半像素 128 处按 owner 拍板暂不纳入）。至此 `App.css` 里 `var(--fs-*)` 用量 **1,033** 处，整数 px 字号**清零**（判据剥注释后断言）。
- **批 4（零视觉，2026-10-31）**：间距 token 化 —— `padding`/`margin`/`gap` 系列里值**恰好等于** `--space-1..8`（4/8/12/16/24/32/40/64）的 px → `var(--space-N)`，共 **1,401 处**（1,257 条声明；负值与小数不换：`-var(...)` 不是合法 CSS）。⚠️ 批 4 第一版用「声明前必须是 `;`/`{`」找声明，漏了**前面隔着注释**的 12 条；第二版又把注释里的 `padding-top:10vh` 字样当声明起点、值吞到后面真声明 ⇒ 真声明被误判跳过。最终版：**等长掩码**（注释区换空格）找声明 ＋ 只替换原文里不在注释区的 token。判据 ④ 剥注释后断言「间距值里不许再有等于 token 的 px」。
- **批 5（零视觉，2026-10-31）**：圆角 token 化 —— `border-radius` 里等于 `--radius-xs/sm/md/lg/full`（4/6/8/12/999）的 px → `var(--radius-*)`，共 **237 处**（`var(--radius-*)` 用量 632）；判据 ⑤。
- **批 6（零视觉，2026-10-31）**：半像素字号纳入 token —— `tokens.json` 加 9.5/10.5/11.5/12.5/13.5/14.5/15.5（owner 拍板「2」）；生成器把 `.` 换成 `-` 命名（`--fs-11-5`，CSS 变量名不能带 `.`）；App.css 换 **128 处**。判据 ③ 收紧为「剥注释后**一个 px 字号都不许有**」（只剩注释里 4 处提及）。
- **批 7（有视觉，owner 2026-10-31 拍板「3」）**：清掉最后 9 个未定义变量。改名 7：`--primary`→`--accent`(3)、`--hover-soft`→`--hover`(2)、`--block`→`--codeblock-bg`(4＋`CodeBlockToolbar.tsx` 内联 2)、`--text-2`→`--text-dim`(18)、`--surface-2`→`--card-bg`(10)、`--surface-light`→`--card-bg`(4，ghost hover 一处改 `--hover`)、`--bg-1`→`--surface`(2；`sync-badge` 文字一处改 `--on-accent`）；定义 2：`:root` 加 `--radius: var(--radius-md)`、`--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。**未定义变量 9 → 0**（判据 ② 的冻结清单清空，新增一个就红）。
- **批 7 的预期视觉变化**（owner 已批，真机截图在 `_tmp/acceptance/css-undef-*.png`）：文件管理器开关底 `transparent → #f8f9fa`、设置/加密区次要文字 `#1f2329 → #646a73`、mermaid/画板按钮由透明→浅底、插件视图/社区保存块直角→8px 圆角、单处许可证输入框字体变等宽。⚠️ 因此 **5 图视觉基线不再 0**（375/320 移动首页 9.8%/1.4%，1280 files 0.12%），这是**有意的**；等 owner 看过截图再重录基线。
- **判据** `src/lib/cssTokens.test.ts` 五条：① 生成物与 json 逐字节一致；② 全仓 `var(--x)` 有定义或属运行时白名单，**未定义集合 = 0**；③ 剥注释后**没有 px 字号**（整数/半像素都走 token）；④ 间距里没有等于 `--space-1..8` 的 px，`var(--space-*)` ≥ 1,434（S4 glob 化后含 `src/styles/**/*.css`）；⑤ `border-radius` 里没有等于 radius token 的 px，`var(--radius-*)` ≥ 647。
- **读数**：`cssTokens` 5/5、`cssLayers` 5/5、`cssHygiene` 4/4；`tsc` 0、`pnpm verify` 66/66。
- **下一批**：S4 strangler —— 见 §13 的 pilot 方案（先 glob 化三条 CSS 判据，再搬 `.selection-toolbar`）。

## 13. S4 strangler pilot（2026-10-31）

### 形态订正
方案 §9.3 原文写「抽 `*.module.css`」，**实测订正为纯 `.css` 分文件**：
- 全仓 `*.module.css` = 0 先例；已有先例是 `src/styles/mcp-panel.css` / `tokens.css` 各自包 `@layer legacy`；
- **类名是运行时契约**：`blockGestures.ts` 把 `.selection-toolbar` 放进手势排除清单、`SelectionToolbarPlugin.tsx` 用 `querySelector(".selection-toolbar")` ⇒ CSS Modules 的哈希类名＝静默行为回归。

### 第 0 步：判据 glob 化（先于任何搬家）
- 新增 `src/lib/cssSources.ts`：唯一清单 `src/App.css` ＋ `src/styles/**/*.css`；`cssTokens` / `cssLayers` / `cssHygiene` 三条判据都改成看这份清单（不再只读 App.css）。
  - `cssLayers` 新增⑤：分文件顶层只许 `@layer legacy` / `@layer utilities` 块，不许层外规则、不许再写层序声明（层序单点仍在 App.css 顶部）。
  - `cssHygiene` 的 `!important` / 重复组改成**逐文件求和**（跨文件同选择器是允许的级联，不算"同上下文重复"）。
- 顺手把 `src/styles/mcp-panel.css` 里没 token 化的部分清掉（零视觉）：字号 **38**、间距 **35**、圆角 **14** 处 → token；冻结值随之上调（`--space-*` 1,434、`--radius-*` 647，剥注释口径）。

### Pilot：`.selection-toolbar`（App.css → `src/styles/selection-toolbar.css`）
- 为什么是它（全仓唯一"零 fence"域）：无 `@media` / 无 `!important` / 无 keyframes；引用者只有 `SelectionToolbarPlugin.tsx`、`blockGestures.ts`、`blockGestures.test.ts`（后两者读 .ts 不读 CSS），不在 `check-panel-layout` 夹具里。
- 搬运方式：**整段纯搬运**（选择器/声明/顺序一字不改），新文件自包 `@layer legacy`，`App.tsx` 在 `tokens.css` 之后 import。
- 证据：
  - 真浏览器 computed 快照（工具条 ＋ 第一个按钮 ＋ 块类型按钮 ＋ 分隔条，17 个属性）：**前后 0 差异**（`_tmp/acceptance/selection-toolbar-computed-{before,after}.json`）；
  - 真浏览器视觉基线 5 图：最差 **0.026%**（阈值 0.2%）、metrics 0；
  - CSS 判据 14/14（`cssTokens` 5 ＋ `cssLayers` 5 ＋ `cssHygiene` 4）；`tsc` 0。

### S4-2：mermaid 域（App.css → `src/styles/mermaid.css`，2026-10-31）
- **前置先改夹具**：`scripts/check-panel-layout.mjs` 以前只内联 `src/App.css`；现在按 `App.tsx` 的 import 顺序内联 `src/App.css` ＋ `src/styles/*.css`（否则搬走的域在夹具里丢样式 ⇒ 61 条几何断言假红/假绿）。
- mermaid 在 App.css 里**本来就不连续**（三处），整段搬到 `src/styles/mermaid.css`：编辑器 `.editor-mermaid-*`（含 `@media (hover:hover)` 那条"悬停才显示顶栏"）、文件管理器 md 预览 `.fm-md-mermaid*`、`.editor-mermaid-note`。纯搬运、自包 `@layer legacy`。
- 证据：`check-panel-layout` **搬前 61/61、搬后 61/61**；CSS 判据 14/14；真浏览器 5 图基线最差 **0.007%**（1280 编辑页 0.000%）、metrics 0；`tsc` 0、`pnpm verify` 66/66。

### S4-3：`.table-menu` 域（App.css → `src/styles/table-menu.css`，2026-11-01）
- 选它而不是原计划的 pm：pm 域有 **18 条响应式覆盖散落在 `@media (max-width:720px)` 等混合块里**；核心规则一搬，它们会排到搬走的核心规则**前面**（同特异性时被压掉）⇒ 响应式覆盖静默失效。要动 pm 得先有"把 media 里的域规则连同条件一起抽走"的工具（第一版试做已回滚，别在没工具时硬搬）。
- `.table-menu` 域：8 条规则、**整块连续、块内无 `@media`**；连同 `/* Table toolbar (Wolai-style) */` 注释搬到 `src/styles/table-menu.css`，纯搬运、自包 `@layer legacy`。
- 证据：computed 快照（`.table-menu`/button/active/danger/sep/swatch × 16 属性＋几何）**前后 0 差异**（`_tmp/acceptance/table-menu-computed-after.json`）；`check-panel-layout` 61/61；CSS 判据 14/14；5 图基线最差 **0.054%**；`tsc` 0。

### S4-4：插件管理器域（App.css → `src/styles/plugin-manager.css`，2026-11-01）
- **先补 media 提取器**（S4-3 留下的前置）：`_tmp/scratch/s4-4-domain-extract-v4.cjs` 的做法——
  在 `@layer legacy` 正文里按域正则抽规则；**混排选择器**（`.pm-x, .other`）拆成两条（域部分搬走、其余留原位）；
  **混合 @media/@supports** 只抽命中域的规则、重建同条件块（其余规则留原位）；核心规则在前、响应式抽取块在后。
  ⚠️ 踩过两个坑：① 扫描器把"前导注释"算进 header（选择器解析在注释上失败）；② 注释里出现 `{` 时
  `indexOf("{")` 指进注释 ⇒ 必须记录每个节点的真实 `{` 位置（`node.open`）。
- 搬运结果：核心 **236 条** ＋ **2 个混合 @media** 的响应式覆盖（720px / 768px＋520px），共 1,663 行；
  App.css 里只剩 1 处**注释**提到 `.plugin-manager-overlay`（不是规则）。
- 证据：computed 等价（9 个 pm 元素 × 20 属性＋几何 × 两个视口 **1280 / 600**）**前后 0 差异**
  （`_tmp/acceptance/plugin-manager-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14；
  5 图基线最差 **0.020%**；`tsc` 0、`pnpm verify` 66/66。

### S4-5：文件管理器域（App.css → `src/styles/file-manager.css`，2026-11-01）
- 复用 S4-4 的提取器：核心 **200 条** ＋ **5 组混合 @media** 的响应式覆盖 → 1,905 行；App.css 里 **0 条** fm 选择器残留。
- 证据：computed 等价（13 个 fm 元素 × 20 属性＋几何 × 两个视口 **1280 / 600**）**前后 0 差异**
  （`_tmp/acceptance/file-manager-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14；
  5 图基线最差 **0.021%**；`tsc` 0。
- App.css：25,010 → **23,508 行**。
- 顺带把两条"读 `src/App.css` 做 CSS 形状断言"的接线测试改成读**全仓 CSS**（`filePreviewImageBar.wiring.test.ts`、
  `fileManagerView.test.ts`）—— 否则域一搬，它们就假红（`fm-img-bar` / `.file-manager-table` 找不到）。
  ⚠️ 同理，S4-6 动 sync 之前要先改 `syncConflictSplit/syncControls/syncPanelMesh` 三条接线测试的读法。

### S4-6：同步域（App.css → `src/styles/sync.css`，2026-11-01）
- 核心 **325 条** ＋ **4 组混合 @media** 的响应式覆盖 → 2,239 行；App.css 里 **0 条** `.sync-*` 残留。
- 先补的提取器修复：选择器列表里**夹着注释**（`.a, .b, /* 说明 */ .c {}`）时，原「最后一个 `*/` 之后」的解析会丢掉前面的选择器
  ⇒ 改成 `clean(header)`（去掉所有注释）后按逗号拆；这是 sync 第一轮漏掉 `.sync-popover` 的真因。
- 三条接线测试先改读全仓 CSS：`syncConflictSplit.wiring.test.ts` / `syncControls.wiring.test.ts` / `syncPanelMesh.wiring.test.ts`（共 20 条 syncPanelMesh 用例）。
- 证据：computed 等价（22 个 sync 元素 × 22 属性＋几何 × 视口 **1280 / 600**）**前后 0 差异**
  （`_tmp/acceptance/sync-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14 + sync 接线 48/48；
  5 图基线最差 **0.020%**；`tsc` 0。
- App.css：23,508 → **21,953 行**。

### S4-7：AI 域（App.css → `src/styles/ai.css`，2026-11-01）
- 核心 **208 条** ＋ **2 组混合 @media** 的响应式覆盖 → 1,596 行；`.ai-*` 在 App.css **0 残留**。
- 证据：computed 等价（19 个 ai 元素 × 21 属性＋几何 × 视口 **1280 / 600**）**前后 0 差异**
  （`_tmp/acceptance/ai-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14；
  5 图基线最差 **0.025%**；`tsc` 0。
- App.css：21,953 → **20,811 行**。

### S4-8：知识地图 ＋ 顶部工具（两个小域，2026-11-01）
- `.kb-map*`（12 条，40 行）→ `src/styles/kb-map.css`；`.top-tools` / `.top-tool`（6 条，60 行）→ `src/styles/top-tools.css`；两个域都**无 @media 混装**，纯搬运。
- 证据：computed 等价（11 个元素 × 19 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/kb-map-top-tools-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14；5 图基线最差 **0.021%**；`tsc` 0。
- App.css：20,811 → **20,761 行**。

### S4-9：PDF 域（App.css → `src/styles/pdf.css`，2026-11-01）
- 核心 **216 条** ＋ **2 组混合 @media** 的响应式覆盖 → 1,910 行；`.pdf-*` 在 App.css **0 残留**。
- 证据：computed 等价（16 个 pdf 元素 × 21 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/pdf-computed-diff.json`）；
  `check-panel-layout` **61/61**；**`verify-mobile-overlays` 756/756**（PDF 抽屉/头部 `data-collapse` 那组静态判据搬完仍全绿）；
  CSS 判据 14/14；5 图基线最差 **0.020%**；`tsc` 0。
- App.css：20,761 → **19,293 行**。

### S4-10：活动栏 ＋ 附件面板（两个小域，2026-11-01）
- `.activity-*`（20 条核心＋**3 组混合 @media**）→ `src/styles/activity-bar.css`（218 行）；`.attachment*`（25 条，无 media）→ `src/styles/attachments.css`（181 行）；两域在 App.css **0 残留**。
- 先改 `sidebarVisibility.test.ts` 的读法（读全仓 CSS）；它第 ④ 条"把 `.sidebar-toggle-btn` 改回 none"的变异也改成**把改坏版追加到末尾** —— 因为 S4 起 `.activity-btn { display:grid }` 在 activity-bar.css 里排在 App.css 之后，原地替换会被同特异性后写赢（这是拆文件后**测试写法**要跟着变的真例子）。
- 证据：computed 等价（20 个元素 × 19 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/activity-attachments-computed-diff.json`）；`check-panel-layout` **61/61**；CSS 判据 14/14 + sidebar 4/4；5 图基线最差 **0.032%**；`tsc` 0。
- App.css：19,293 → **19,007 行**。

### S4-11：邮箱域（App.css → `src/styles/email.css`，2026-11-01）
- 核心 **252 条**（**无 @media 混装**）→ 1,404 行；`.email-*` 在 App.css **0 残留**。
- 先改 `emailListHeadWrap.test.ts` 读全仓 CSS（它按 happy-dom 计算样式钉 `.email-list-head` 的三条换行契约）。
- 证据：computed 等价（40 个 email 元素 × 20 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/email-computed-diff.json`）；
  `check-panel-layout` **61/61**；email 接线＋CSS 判据 34/34；5 图基线最差 **0.036%**；`tsc` 0。
- App.css：19,007 → **18,114 行**。

### S4-12：设置域（App.css → `src/styles/settings.css`，2026-11-01）
- 核心 **302 条** ＋ **2 组混合 @media** → 1,686 行；`.set-*` / `.mset-*` 在 App.css **只剩 1 个例外**（见下）。
- ⚠️ **例外：`.set-space-crypto` 的基础样式留在 App.css**，必须和 `.space-item-crypto` 写在**同一条规则**里 ——
  `spaceSecurity.test.ts` 的判据是"两个落点共享同一条规则，拆开就会各自漂"；提取器把混合选择器拆成两份时这条会变红，
  所以手工还原成 `.space-item-crypto, .set-space-crypto { … }` 并删掉 settings.css 里的那份副本。
- 先改三条读 App.css 的测试 ⇒ 读全仓 CSS：`SettingsDialog.test.tsx` / `AbilitiesPane.test.tsx` / `spaceSecurity.test.ts`。
- 证据：computed 等价（32 个设置元素 × 20 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/settings-computed-diff.json`）；
  `check-panel-layout` **61/61**；设置相关＋CSS 判据 **57/57**；5 图基线最差 **0.027%**；`tsc` 0。
- App.css：18,114 → **17,073 行**。
- ⚠️ **CI mobile 抓到的真回归（2026-11-01，已修）**：上面这版用的是 v4 提取器（核心全在前、media 全在后）。
  它把 `.set-dialog button { min-height:44px }` 挪到 settings.css 后，原本靠"在它之后"才压得住的
  `button.set-swatch { height:30px; min-height:30px }` 仍留在 App.css ⇒ **文件边界让 44px 后写赢**，
  移动端色板从 30×30 变成 **30×44 的椭圆**（CI job「移动端布局+浮层验收」逐字报的）。
- **修法**：① 设置域改用 **v6 顺序保持提取器**；② 把 `button.set-swatch` / `button.set-swatch::after`
  两条**随域一起搬**（选择器不以 `.set-` 开头，用额外模式 `^button\.set-swatch` 带过来）⇒ 它们仍在
  `.set-dialog button` 之后。复验：computed **1280/600/390 三视口 0 差异**；本机
  `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；桌面基线 0.017%。
  ⇒ 教训：**v4 的"核心前、media 后"只在原文件没有"media 之后还有核心规则"时才等价**；以后一律 v6。

### S4-13：属性面板域（App.css → `src/styles/properties.css`，2026-11-01）
- 核心 **119 条** ＋ **2 组混合 @media** → 641 行；`.properties-*` / `.prop-*` 在 App.css **0 残留**。
- ⚠️ **这轮又抓到提取器一个真问题（v4 → v6）**：v4 把「核心全放前面、media 全放后面」，一旦原文件里
  **media 之后还有核心规则**，搬家后层叠就变（实测 `.properties-body` 在 600px 的 padding 从 `4px 16px`
  变成 `6px 12px`，computed **53 处差异**）。v6 改成**按原文件顺序**输出（核心与 media 交错不重排）⇒
  computed 回到 **0 差异**。以后每批都用 v6（`_tmp/scratch/s4-domain-extract-v6.cjs`）。
- 先改两条测试读全仓 CSS：`PropertiesPanel.test.tsx`、`DatetimeValueEditor.test.tsx`（后者从"App.css 里不许有
  `.prop-datetime*` 死规则"扩成"全仓 CSS 里不许有"）。
- 证据：computed 等价（30 个属性元素 × 20 属性＋几何 × 视口 1280 / 600）**前后 0 差异**（`_tmp/acceptance/properties-computed-diff.json`）；
  `check-panel-layout` **61/61**；属性相关＋CSS 判据 **41/41**；5 图基线最差 **0.016%**；`tsc` 0。
- App.css：17,073 → **16,676 行**。

### S4-14：目录树域（App.css → `src/styles/tree.css`，2026-11-01）
- 核心 **58 条**（**无 @media 混装**）→ 497 行；`.tree-*` 在 App.css **0 残留**。
- 先改 `cssHygiene.test.ts` 的 S2-c 静态级联判据读全仓 CSS（它原来只读 App.css，域一搬就假红 `找不到 .tree-row`）。
- 证据：computed 等价（28 个 tree 元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/tree-computed-diff.json`）；
  `check-panel-layout` **61/61**；CSS 判据 14/14；5 图基线最差 **0.020%**；`tsc` 0。
- App.css：16,676 → **16,301 行**（含上一轮 settings v6 回填；见 S4-12 的 CI 回归说明）。

### S4-15：社区发布/保存域（App.css → `src/styles/community.css`，2026-11-01）
- 核心 **60 条** ＋ **1 组混合 @media** → 433 行；`.community-*` 在 App.css **0 残留**。
- 证据：computed 等价（30 个社区元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/community-computed-diff.json`）；
  `check-panel-layout` **61/61**；社区＋CSS 判据 **72/72**；5 图基线最差 **0.025%**；`tsc` 0。
- App.css：16,301 → **16,027 行**。

### S4-16：移动阅读/首页域（App.css → `src/styles/mobile-read.css`，2026-11-01）
- 核心 **85 条** ＋ **3 组混合 @media** → 619 行；`.mread-*` / `.mhome-*` / `.mobile-*` 在 App.css **0 残留**。
- ⚠️ 这一批**必须跑移动端真浏览器门禁**（不是只看 computed）：本机
  `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**（44px 命中区/浮层在 320/390/792 档全过）。
- 证据：computed 等价（50 个元素 × 21 属性＋几何 × 视口 1280 / 600 / **390** / **792**）**前后 0 差异**（`_tmp/acceptance/mobile-read-computed-diff.json`）；
  `check-panel-layout` **61/61**；移动相关＋CSS 判据 **22/22**；5 图基线最差 **0.033%**；`tsc` 0。
- App.css：16,027 → **15,587 行**。

### S4-17：编辑器域（App.css → `src/styles/editor.css`，2026-11-01）
- 核心 **147 条** ＋ **2 组混合 @media** → 1,226 行；`.editor-*` / `.block-selection*` 在 App.css 只剩 **4 条 KaTeX 覆盖**（见下，故意留）。
- ⚠️ **例外说明**：`.editor-formula-katex .katex-*` 那 4 条在 **`@layer legacy` 之外**（KaTeX 是懒加载第三方样式，
  进层就会失效 —— 与 excalidraw 同一条纪律）⇒ 它们**不属于编辑器域**，留在 App.css 末尾层外是对的。
- 证据：computed 等价（55 个编辑器元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/editor-computed-diff.json`）；
  `check-panel-layout` **61/61**；编辑器＋CSS 判据 **25/25**；本机 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.013%**；`tsc` 0。
- App.css：15,587 → **14,663 行**。

### S4-18：侧栏与空间切换域（App.css → `src/styles/sidebar-space.css`，2026-11-01）
- 核心 **87 条** ＋ **4 组混合 @media** → 735 行；`.sidebar*` / `.space-*` 在 App.css 只剩 **`.space-item-crypto`（共享规则）**。
- ⚠️ **例外**：`.space-item-crypto` 必须和 `.set-space-crypto` 共享同一条规则（`spaceSecurity.test.ts` 钉的）⇒
  提取器用负向前瞻 `space(?!-item-crypto\b)` **故意不抽它**；那条规则原地留在 App.css（两条选择器一起）。
- 证据：computed 等价（38 个元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/sidebar-space-computed-diff.json`）；
  `check-panel-layout` **61/61**；sidebar/space＋CSS 判据 **50/50**；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.028%**；`tsc` 0。
- App.css：14,663 → **14,139 行**。

### S4-19：数据库表格域（App.css → `src/styles/database.css`，2026-11-01）
- 核心 **179 条** ＋ **1 组混合 @media** → 1,391 行；`.db-*` 在 App.css **0 残留**。
- 证据：computed 等价（60 个 db 元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/database-computed-diff.json`）；
  `check-panel-layout` **61/61**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.020%**；`tsc` 0。
- App.css：14,139 → **13,102 行**。

### S4-20：外壳域（App.css → `src/styles/shell.css`，2026-11-01）
- 核心 **30 条** ＋ **3 组混合 @media** → 253 行；`.main*` / `.toolbar*` 在 App.css **0 残留**（只剩 1 条注释里的 `.main` 字样）。
- 证据：computed 等价（4 个元素 × 21 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/shell-computed-diff.json`）；
  `check-panel-layout` **61/61**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.030%**；`tsc` 0。
- App.css：13,102 → **12,919 行**。

### S4-21：标签/表情选择器（App.css → `tag-picker.css` / `emoji-picker.css`，2026-11-01）
- `.tag-picker*`：**24 条**＋1 组 @media → 246 行；`.emoji-picker*`：**3 条**＋1 组 @media（含 `.ep-*` 的 44px 覆盖）→ 88 行；两域在 App.css **0 残留**。
- 证据：computed 等价（23 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/tag-emoji-computed-diff.json`）；
  `check-panel-layout` **61/61**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.016%**；`tsc` 0。
- App.css：12,919 → **12,723 行**。

### S4-22：搜索浮层域（App.css → `src/styles/search.css`，2026-11-01）
- 核心 **47 条** ＋ **1 组混合 @media** → 410 行；`.search-*` 在 App.css **0 残留**。
- 证据：computed 等价（28 个 search 元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/search-computed-diff.json`）；
  `check-panel-layout` **61/61**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.011%**；`tsc` 0。
- App.css：12,723 → **12,445 行**。

### S4-23：存储面板域（App.css → `src/styles/storage-panel.css`，2026-11-01）
- 核心 **45 条** ＋ **1 组混合 @media**（3 条 `.stg-*` 落在巨型短视口块里）→ 325 行；`.stg-*` 在 App.css **0 残留**。
- 证据：computed 等价（三视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/storage-panel-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.027%**；`tsc` 0。
- App.css：12,445 → **12,224 行**。

### S4-24：移动配对域（App.css → `src/styles/mobile-pair.css`，2026-11-01）
- **84 条**（**0 组 @media**，2 个混合逗号组）→ 550 行；`.mpair-*` 在 App.css **0 残留**。
- 证据：computed 等价（三视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/mobile-pair-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端双门禁 **249/249**、**756/756**；5 图基线最差 **0.019%**；`tsc` 0。
- App.css：12,224 → **11,840 行**。

### S4-25：移动外壳/快速记录域（App.css → `src/styles/mobile-capture.css`，2026-11-01）
- **35 条**（`0 组 @media`，0 混合组）→ 338 行；`.mcap-*` / `.m-tabshell*` / `.mtab-*` 在 App.css **0 残留**。
- 先改 `mobileCaptureTabs.wiring.test.ts` 读全仓 CSS（它原来直接读 `src/App.css` 字面量）。
- 证据：computed 等价（三视口）**0 差异**（`_tmp/acceptance/mobile-capture-computed-diff.json`）；夹具 **66/66**；移动端双门禁 **249/249**、**756/756**。
- App.css：11,840 → **11,580 行**。

### S4-26：关于对话框域（App.css → `src/styles/about.css`，2026-11-01）
- **85 条** ＋ **1 组混合 @media** → 646 行；`.about-*` / `.mabout-*` 在 App.css **0 残留**。
- 证据：computed 等价（45 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/about-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.021%**；`tsc` 0。
- App.css：11,580 → **11,134 行**。

### S4-27：小浮层三域（App.css → `shortcuts.css` / `markdown-import.css` / `cover-picker.css`，2026-11-01）
- `.shortcuts*` **16 条**＋1 组 @media → 155 行；`.markdown-import*` **11 条**＋1 组 @media → 128 行；`.cover-picker*` **14 条**＋1 组 @media → 120 行；三域在 App.css **0 残留**。
- 证据：computed 等价（34 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/small-overlays-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.036%**；`tsc` 0。
- App.css：11,134 → **10,914 行**。

### S4-28：插件面板/视图域（App.css → `src/styles/plugin-panel.css`，2026-11-01）
- **35 条** ＋ **3 组混合 @media** → 282 行；`.plugin-*` 在 App.css **0 残留**（只剩 1 条注释字样）。`.plugin-manager-*` 仍留在既有 `plugin-manager.css`，未动。
- 证据：computed 等价（三视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/plugin-panel-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.017%**；`tsc` 0。
- App.css：10,914 → **10,745 行**。

### S4-29：网页书签/账户设备/移动设置（App.css → `webbookmark-card.css` / `account.css` / `mset.css`，2026-11-01）
- `.webbookmark-*` **14 条** → 117 行；`.acct-*` **9 条** → 29 行；`.mset*` **7 条** → 74 行；三域均 **0 组 @media**、在 App.css **0 残留**。
- 证据：computed 等价（14 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/misc-small-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.034%**；`tsc` 0。
- App.css：10,745 → **10,610 行**。

### S4-30：MCP 接入状态域（App.css → `src/styles/mcp-access.css`，2026-11-01）
- **13 条**（含末尾那条单行 `.mcp-access-dot.is-live`，v6 不处理单行体 ⇒ 手工搬运并保留原注释）＋ **0 组 @media** → 106 行；`.mcp-*` 在 App.css **0 残留**。
- 证据：computed 等价（8 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/mcp-access-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.028%**；`tsc` 0。
- App.css：10,610 → **10,542 行**。

### S4-31：内联绘图/血统冲突横幅（App.css → `inline-drawing.css` / `conflict-lineage.css`，2026-11-01）
- `.inline-drawing*` **16 条**（0 @media）→ 141 行；`.conflict-banner-lineage*` **11 条**＋1 组 @media → 63 行。
- ⚠️ `.inline-drawing` 有 **5 条第三方覆盖**（`.inline-drawing .excalidraw ...`）**刻意留在 App.css 末尾层外**（懒加载未分层，进层即失效）——与 KaTeX 同一条例外。
- 证据：computed 等价（19 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/drawing-lineage-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.017%**；`tsc` 0。
- App.css：10,542 → **10,407 行**。

### S4-32：命令面板域（App.css → `src/styles/palette.css`，2026-11-01）
- **28 条** ＋ **1 组混合 @media** → 284 行；`.palette*` 在 App.css **0 残留**。
- 证据：computed 等价（22 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/palette-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.018%**；`tsc` 0。
- App.css：10,407 → **10,196 行**。

### S4-33：模板中心/关系图控件（App.css → `template-center.css` / `graph-controls.css`，2026-11-01）
- `.tc-*` **39 条** ＋ **2 组混合 @media** → 230 行；`.graph-controls*` **7 条**＋1 组 @media → 71 行；两域在 App.css **0 残留**。
- 证据：computed 等价（23 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/template-graph-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.021%**；`tsc` 0。
- App.css：10,196 → **9,946 行**。

### S4-34：块操作域（App.css → `src/styles/block.css`，2026-11-01）
- **57 条**（0 组 @media）→ 457 行；`.block-*` 在 App.css **0 残留**。
- 证据：computed 等价（38 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/block-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.020%**；`tsc` 0。
- App.css：9,946 → **9,611 行**。

### S4-35：看板视图域（App.css → `src/styles/board.css`，2026-11-01）
- **31 条** ＋ **1 组混合 @media** → 262 行；`.board-*` 在 App.css **0 残留**。
- 证据：computed 等价（22 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/board-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.020%**；`tsc` 0。
- App.css：9,611 → **9,420 行**。

### S4-36：标题栏/按钮基元/公式编辑器（App.css → `titlebar.css` / `buttons.css` / `formula-editor.css`，2026-11-01）
- `.titlebar*` **13 条**＋1 组 @media → 118 行；`.btn-*` / `.link-btn*` **21 条**＋1 组 @media → 180 行；`.formula-editor*` **4 条**＋1 组 @media → 72 行；三域在 App.css **0 残留**。
- 证据：computed 等价（18 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/titlebar-buttons-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.018%**；`tsc` 0。
- App.css：9,420 → **9,161 行**。

### S4-37：页面壳/数据库页（App.css → `page.css` / `database-page.css`，2026-11-01）
- `.page-*` **16 条**＋1 组 @media → 161 行；`.database-*` **17 条**＋1 组 @media → 147 行；两域在 App.css **0 残留**。
- 证据：computed 等价（19 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/page-database-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.045%**；`tsc` 0。
- App.css：9,161 → **8,936 行**。

### S4-38：确认框/开关/公式工具栏（App.css → `confirm.css` / `ui-toggle.css` / `formula.css`，2026-11-01）
- `.confirm-*` **16 条**＋1 组 @media → 169 行；`.ui-toggle*` **5 条** → 48 行；`.formula-*` **26 条** → 159 行；三域在 App.css **0 残留**（`.formula-preview-katex .katex-display` 单行 KaTeX 覆盖**刻意留在层外**，与 `.editor-formula-katex` 同一条例外）。
- 证据：computed 等价（31 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/confirm-formula-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.021%**；`tsc` 0。
- App.css：8,936 → **8,697 行**。

### S4-39：移动首页/搜索/外壳（App.css → `src/styles/mobile-home.css`，2026-11-01）
- `.mhome*` / `.msearch*` / `.mshell*` **43 条**（0 组 @media）→ 351 行；三前缀在 App.css **0 残留**。
- 证据：computed 等价（24 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/mobile-home-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.022%**；`tsc` 0。
- App.css：8,697 → **8,441 行**。

### S4-40：移动端缺失同步/词典/底部弹层（App.css → `missing-sync.css` / `mobile-dict.css` / `mobile-sheet.css`，2026-11-01）
- `.mesh-missing-*` **25 条** → 60 行；`.mdict*` **13 条** → 125 行；`.msheet-*` **17 条** → 82 行；三域均 **0 组 @media**、在 App.css **0 残留**。
- 证据：computed 等价（42 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/mobile-sheets-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.018%**；`tsc` 0。
- App.css：8,441 → **8,308 行**。

### S4-41：关系图视图域（App.css → `src/styles/graph.css`，2026-11-01）
- **30 条** ＋ **1 组混合 @media** → 223 行；`.graph-*` 在 App.css **0 残留**。
- 证据：computed 等价（23 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/graph-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.031%**；`tsc` 0。
- App.css：8,308 → **8,153 行**。

### S4-42：反链面板/面包屑（App.css → `backlinks.css` / `breadcrumbs.css`，2026-11-01）
- `.backlinks-*` **11 条**＋1 组 @media → 82 行；`.breadcrumbs*` / `.crumb*` **5 条**＋1 组 @media → 55 行；两域在 App.css **0 残留**。
- 证据：computed 等价（13 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/backlinks-breadcrumbs-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.019%**；`tsc` 0。
- App.css：8,153 → **8,066 行**。

### S4-43：编辑器零散小簇（App.css → `src/styles/editor-misc.css`，2026-11-01）
- `.find-btn` / `.insert-item` / `.unlinked-mention-link` / `.empty-cta` / `.title-area` / `.note-scroll` / `.npg-*` 共 **27 条** ＋ **2 组混合 @media** → 212 行；这些前缀在 App.css **0 残留**。
- 证据：computed 等价（13 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/editor-misc-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.018%**；`tsc` 0。
- App.css：8,066 → **7,918 行**。

### S4-44：锁屏/解锁域（App.css → `src/styles/lock.css`，2026-11-01）
- **28 条**（0 组 @media）→ 242 行；`.lock-*` 在 App.css **0 残留**。
- 证据：computed 等价（23 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/lock-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.030%**；`tsc` 0。
- App.css：7,918 → **7,740 行**。

### S4-45：mac 窗口控件域（App.css → `src/styles/mac-window.css`，2026-11-01）
- **13 条**（0 组 @media）→ 99 行；`.is-macos*` / `.mac-*` 在 App.css **0 残留**。
- 证据：computed 等价（7 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**）**前后 0 差异**（`_tmp/acceptance/mac-window-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；平台专属（mac）且 0 media ⇒ 本批不跑移动双门禁（与桌面窗口控件无关）；
  5 图基线最差 **0.023%**；`tsc` 0。
- App.css：7,740 → **7,675 行**。

### S4-46：表情选择器内层域（App.css → `src/styles/emoji-picker-inner.css`，2026-11-01）
- **21 条**（0 组 @media；它的 390px 覆盖仍在既有 `emoji-picker.css` 里）→ 162 行；`.ep-*` 在 App.css **0 残留**。
- 证据：computed 等价（16 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**，含媒体覆盖对照）**前后 0 差异**（`_tmp/acceptance/emoji-picker-inner-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.016%**；`tsc` 0。
- App.css：7,675 → **7,563 行**。

### S4-47：目录侧栏域（App.css → `src/styles/toc.css`，2026-11-01）
- **14 条** ＋ **1 组混合 @media** → 166 行；`.toc-*` 在 App.css **0 残留**。
- 证据：computed 等价（9 个元素 × 22 属性＋几何 × 视口 1280 / 600 / **390**，带 `--toc-w:300px` + `is-toc-open`）**前后 0 差异**（`_tmp/acceptance/toc-computed-diff.json`）；
  `check-panel-layout` **66/66**；CSS 判据 14/14；本机移动端 `verify-mobile-views` **249/249**、`verify-mobile-overlays` **756/756**；
  5 图基线最差 **0.019%**；`tsc` 0。
- App.css：7,563 → **7,434 行**。

### 后续批次（按风险从低到高）
1. App.css 剩的都是零散小域（`.history-*`/`.toc-*` 暂缓等）＋跨域基元＋第三方覆盖；继续按同一条证据链逐域收。
2. 第三方覆盖（excalidraw / KaTeX）**永远留在 App.css 末尾层外**（懒加载未分层，进层即失效）。


