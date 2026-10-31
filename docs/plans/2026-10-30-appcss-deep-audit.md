# 方案：App.css 深度审计与优化（2026-10-30）

状态：S0 视觉基线工具 ✅；S1 纯删除 ✅（App.css 28,695→26,439 行；非空行 27.4k→25.3k；`!important` 正则 36→21、实际声明 31→16）；S2 部分 ✅（去 `!important`／合并重复规则／删死兜底）；**S2 `@layer` 脚手架 ✅（2026-10-31）**：全部既有规则保序包进 `@layer legacy`、utilities 试点 5 条、excalidraw/KaTeX 覆盖 7 条**留在层外**；判据 `src/lib/cssLayers.test.ts`，真浏览器视觉基线最差 **0.018%**（阈值 0.2%）；**S3 字号 token 化 ✅（2026-10-31）**：`tokens.json` → 生成 `tokens.css`/`tokens.d.ts`（21 档整数字号）；`var(--fs-*)` **1,161 处**、px 字号**清零**（整数＋半像素全 token 化，仅注释剩 4 处提及）；间距 `var(--space-*)` **1,401 处**、圆角 `var(--radius-*)` **632 处**；未定义变量 **13**（冻结只减不增），判据 `src/lib/cssTokens.test.ts`，视觉基线最差 **0.011%**；**S4 strangler 未开工**。审计读数见 §2、执行记录见 §11/§12（截至 2026-10-31）

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
- **剩余未定义 9 条**（**没有兜底**，改名/定义会让原本失效的声明开始生效 ⇒ 逐条看视觉后再动）：B 改名 7（`--bg-1/--block/--hover-soft/--primary/--surface-2/--surface-light/--text-2`）、C 定义 2（`--radius/--font-mono`）。
- **判据** `src/lib/cssTokens.test.ts` 五条：① 生成物与 json 逐字节一致；② 全仓 `var(--x)` 有定义或属运行时白名单，未定义集合 ≤ 冻结 13；③ 剥注释后**没有 px 字号**（整数/半像素都走 token）；④ 间距里没有等于 `--space-1..8` 的 px，`var(--space-*)` ≥ 1,399；⑤ `border-radius` 里没有等于 radius token 的 px，`var(--radius-*)` ≥ 632。
- **读数**：`cssTokens` 5/5、`cssLayers` 4/4、`cssHygiene` 4/4；真浏览器视觉基线 5 图最差 **0.011%**（阈值 0.2%）、metrics 差异 0。
- **下一批**：清那 9 个未定义变量（逐个定性见 `_tmp/acceptance/css-undefined-vars-2026-10-31.md`，⚠️ 定义会让原本失效的声明重新生效 ⇒ 逐个看视觉风险）；S4 strangler 的 pilot 见 §13。

