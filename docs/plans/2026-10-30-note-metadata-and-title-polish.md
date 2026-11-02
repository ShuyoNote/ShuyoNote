# 方案：笔记元数据区与长标题的落地方案（2026-10-30）

状态：方案（待 owner 拍 5 个默认项；批次 B1–B5 可直接开工，B6 需企业版确认）

关联：`2026-10-30-package-format-final.md`（包格式 v1.1/M2）· `2026-10-29-shuyodoc-m1.md`（包 M1）· 效果图（临时，30 天）：`_tmp/acceptance/props-panel-mockup.png`、`props-context-mockup.png`、`long-title-mockup.png`

> 这份方案把最近几轮讨论（属性区、长标题、元数据进包）合成**一条可执行的批次序列**：
> 每批都有**改动文件、判据命令、合并纪律**；不写"以后优化"这种没有判据的条目。

## 0. 目标与非目标

**目标**：让"元数据（标签/来源/作者/时间/自定义属性）"和"标题"这两类信息**在编辑、列表、导出、互通**四个面上表现一致。

**非目标（本轮不做）**：

- 不做属性模板市场/多空间共享属性定义；
- 不做标题富文本（标题保持纯文本）；
- 不改社区发布的历史 URL（只对新帖按新规则，见 B5 与待拍板 Q3）。

## 1. 信息架构决定

| 决定 | 内容 | 理由 |
|---|---|---|
| A1 | **属性/标签的增删入口只留在属性区**（header `＋ 添加属性`、标签行 `＋`）；顶部操作行只保留页面级动作（图标/题图/分享） | 同一件事两个入口是当前最大困惑（截图顶部有「添加属性/添加标签」，属性区里却没有 `＋`） |
| A2 | 属性区宽度**收到正文栏**（`--doc-width`，约 ≤900px）；去掉整块浅灰底，改细分隔线 | 元数据视觉重量不该压过正文 |
| A3 | **系统字段**（存于/创建/更新时间等派生值）进「系统信息」折叠区，**只读、无删除/排序** | 误删会丢元数据；排序只对用户属性有意义 |
| A4 | 底部「来源」重复块 **合并为一条只读「出处」引文**（从属性区派生，可一键复制） | 现在属性区可编辑 `来源`、底部又生成一段只读 `来源：…`，用户会以为能改两遍 |
| A5 | 属性区**默认展开**（≤4 项时）；>4 项或含系统字段时折叠为一行摘要 | 长文档里属性区不该把正文推下去；但默认不改变现有行为 |

## 2. 属性区实现

### B1（P0，纯 UI，低风险）

**改动文件**

- `src/components/PropertiesPanel.tsx`
- `src/App.css`（`.properties` / `.metadata-card` 相关）
- `src/components/PropertiesPanel.test.tsx`

**内容**

1. 计数语义：`属性 (4)` → **`4 项属性 · 3 个标签`**（数字由 `nonTagProps.length` / `pageTags.length` 现算，⛔ 不硬编码）；
2. 系统字段只读：`attr_type` 之外用显式白名单标记系统字段（建议 `SYSTEM_ATTR_IDS` 常量，先含"存于/创建/更新"三个内置项），渲染进「系统信息」折叠区，**不渲染 ✕/↑↓**；
3. 空值占位：`未设置（点击填写）`，不是空输入框；
4. 入口：header 右侧 `＋ 添加属性`（调现有 `addProp` 流程）；标签行末尾 `＋`（调 `requestAddTag`）；
5. 操作按钮（✎/✕）默认隐藏，行 hover / 聚焦才出现。

**判据（`PropertiesPanel.test.tsx` 扩展）**

```powershell
npx vitest run src/components/PropertiesPanel.test.tsx
```

- 计数文案含"项属性"与"个标签"，且与数据一致（不写字面数字）；
- 系统字段行**没有删除/上移/下移按钮**（按 role/aria 查）；
- 空值行渲染"未设置"占位；
- 两个 `＋` 入口存在且分别调用 `addProp` / `requestAddTag`；
- 既有 13 条判据不回归。

### B2（P1，类型化展示）

**内容**：`来源` 若值是 URL ⇒ 渲染为可点链接（省略中段 + 打开 + 复制），**只在编辑态出输入框**；`date/datetime` ⇒ 到分钟 + 相对时间 + 时区（`+08:00`）；`作者` 若属性名匹配内置作者项 ⇒ person chip。

**改动文件**：`PropertiesPanel.tsx`、新增 `src/lib/propFormat.ts`（`formatUrl` / `formatDateTime` / `formatPerson` 纯函数，便于单测）、`App.css`。

**判据**：`propFormat.test.ts`（URL 省略/无协议补全、日期与时区、相对时间注入时钟）＋ `PropertiesPanel.test.tsx` 两条渲染断言；**不得**在展示态渲染 `<input>`（`queryByRole("textbox")` 为空）。

### B3（P0，入口与底部块合并）

**内容**：顶部操作行移除「添加属性/添加标签」；底部引用块改成只读「出处」一行（`来源标题 · 链接 — 作者 · 时间`），点击复制。

**改动文件**：`src/App.tsx`（`page-actions` 区）、`src/components/PropertiesPanel.tsx`（承接入口）、`App.css`、相关测试。

**判据**：顶部不再有"添加属性/添加标签"按钮；底部不再出现两个"来源："；复制按钮写入剪贴板（mock）内容含标题+URL+作者+时间。

## 3. 长标题实现

### 阈值（全局唯一出处，集中在 `src/lib/titleLimits.ts`）

```text
编辑态字号：len ≤ 40 → 34px；41–80 → 28px；>80 → 24px
编辑态最大高度：3 行（内部滚动，不截断输入）
失焦展示：clamp 3 行 + 「展开全文」
软提示：>120 字显示字数（灰），>300 字提示"过长会影响列表与文件名"（仍可保存）
硬上限：1000 字（保存时提示，不回滚已输入内容）
侧边栏：单行 ellipsis + title tooltip
标签页：中间省略（首 10 + … + 尾 8）
卡片/看板：2 行 clamp，卡片固定高
搜索结果：2 行 clamp + 命中高亮（P2）
窗口标题：≤60 字
导出文件名：UTF-8 ≤180 字节，非法字符替换，结尾 `-<id 前 8 位>`
社区 URL slug：ASCII 段 + 短 hash（仅新帖）
```

### B4（P0，编辑器与列表）

**改动文件**：`src/App.tsx`（`.title-input` 的 textarea）、`src/App.css`（`.title-input`、新增 `.title-clamped`）、侧边栏组件（页面树）、标签页组件、看板卡片组件、`src/lib/titleLimits.ts`、`titleLimits.test.ts`。

**判据**

- `titleLimits.test.ts`：三档字号阈值、clamp 行数、软/硬上限（纯函数）；
- 组件级：长标题下标题区域高度 ≤3 行（用 `scrollHeight`/样式断言）；侧边栏单行省略；卡片等高；
- 短标题（≤40 字）行为不变（字号 34px、无「展开全文」）。

### B5（P1，出口）

**内容**：导出文件名 sanitize（`\ / : * ? " < > |`、尾点/空格、Windows 保留名）、字节限长、id 后缀；社区发布 URL slug 规则（仅新帖；旧 URL 不动）。

**改动文件**：导出命名所在模块（`docPackageTransfer.ts` / 空间包 transfer）＋ `src/lib/safeFilename.ts`；社区发布组件（slug 生成）；对应测试。

**判据**：`safeFilename.test.ts`（非法字符/超长/重名/保留名/UTF-8 字节）；slug 单测（中文→ASCII、hash、确定性）。

## 4. 元数据进包（B6，需企业版确认）

**问题**：`.shuyodoc` / `.shuyospace` 目前只带 Lexical 正文，**属性（来源/作者/标签/自定义）在 DB 表里，跨产品导入必丢**。

**提案（v1.1 增量，不改 v1 读侧行为）**

```text
document.shuyodoc
  manifest.json / content.json / assets/** / checksums.json
  props.json          # 新增可选：{ format:"shuyonote.props", version:1, items:[{key,name,type,value}] }
```

- 只有**存在属性时**才写 `props.json`；`checksums.json` 覆盖它（与 manifest 同规则）；
- 未知 `type` ⇒ 导入按 `text` 兜底 + warning（⛔ 不丢值）；
- 空间包同理放在顶层 `props.json`（节点级属性若将来需要，再议 `documents/<id>/props.json`）；
- **读侧容忍**：没有 `props.json` 的旧包照旧可读（v1 行为不变）。

**需企业版确认**（他们已明确"未登记条目读端拒" ⇒ 列进 checksums 的额外条目应可通过，但必须确认）：

1. 额外 `props.json`（已登记 checksums）是否被接受；
2. `props.items[].type` 允许集合（建议 `text/number/date/datetime/checkbox/select/multi`，与个人版属性类型一致）；
3. 未知 type 的兜底策略（我们主张 text + warning）。

**判据**：往返（导出→导入→再导出，props 语义等价）；缺 props.json 旧包可读；坏 props.json 拒收并点名；fixtures 增加 `personal-with-props.shuyodoc` 并更新字节稳定清单（B6 完成时）。

## 5. 批次与顺序（依赖 + 合并纪律）

| 批次 | 内容 | 依赖 | 合并前必跑 |
|---|---|---|---|
| **M2e-1**（在跑） | `docSpacePackTransfer.ts`（导出聚合）、两个 UI 入口、6 条挂载判据 | — | `npx vitest run src/components/docPackage* src/lib/doc*`、`tsc`、`check-overlay-registry`、`check-web-commands`、`check-evidence-in-same-round` |
| **B1** | 属性区 P0（计数/系统字段/空值/入口/hover） | — | `PropertiesPanel.test.tsx`、`tsc` |
| **B2** | 属性区类型化（URL/日期/作者） | B1 | `propFormat.test.ts`、`PropertiesPanel.test.tsx` |
| **B3** | 入口收敛 + 底部出处合并 | B1（建议 B2 后） | 组件测试、`check-overlay-registry`（若加确认框） |
| **B4** | 长标题编辑器/列表 | — | `titleLimits.test.ts` + 相关组件测试 |
| **B5** | 文件名 sanitize + URL slug | — | `safeFilename.test.ts`、发布组件测试 |
| **B6** | `props.json` 进包 | 企业版三条确认 | 包判据 72+、fixtures 字节稳定性、`check-doc-links`、`check-doc-facts` |

**统一纪律**：每批独立分支 → `--no-ff` 合 dev → push；`apiVersion` 只在能力面变化时升（本方案**不涉及能力面**，预计保持 1.27.0）；⛔ 不 `--force`/不 `--no-verify`/不 `git add -A`；预算不够按 WIP 提在分支上。

## 6. 判据命令汇总（可直接贴进 PR）

```powershell
# 属性区
npx vitest run src/components/PropertiesPanel.test.tsx src/lib/propFormat.test.ts
# 长标题
npx vitest run src/lib/titleLimits.test.ts
# 出口
npx vitest run src/lib/safeFilename.test.ts
# 包（B6 时）
npx vitest run src/lib/doc* src/lib/packageFixtures.test.ts
npx tsc --noEmit
node scripts/check-capabilities.mjs; node scripts/check-doc-facts.mjs; node scripts/check-generated-artifacts.mjs
```

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 顶部入口移除破坏既有测试/用户习惯 | 先 B1 保留顶部入口，B3 才收敛；B3 单独提交，便于 revert |
| 底部"出处"块其实是社区发布模板自动生成的只读块 | B3 前先确认来源（代码搜索 + 发布流程）；若只读且不可控，则**只去掉属性区重复的"来源"行**，反向合并 |
| 长标题 clamp 影响编辑（用户看不到正在打的字） | 编辑态不 clamp，只 max-height 滚动；clamp 只用于失焦展示态 |
| 导出文件名改规则导致已导出文件对不上 | 只影响**新导出**，不迁移旧文件；判据里固定旧文件名规则不回归 |
| URL slug 改动破坏历史链接 | 仅新帖使用新 slug；旧帖 URL 不动（Q3 默认） |
| `props.json` 被企业版拒收 | B6 先发信确认三条；未确认前**不写**（读侧容忍可先做） |

## 8. owner 已拍板（2026-10-30，全选 A）

Q1 = **A**：底部「出处」块合并为**只读引文**（从属性派生、可复制）；属性区保留唯一可编辑「来源」。
Q2 = **A**：属性区 **≤6 项展开、>6 项折叠（阈值可配）**（记住手动偏好）。
Q3 = **A**：社区 URL slug **仅新帖** ASCII 化（英文数字+短 hash）；**老帖 URL 一律不动**。
Q4 = **A**：导出文件名**加短 id 后缀**（`<标题>-<id 前 8 位>.<ext>`）。
Q5 = **A**：props 进包用**可选 `props.json`**（checksums 覆盖；无属性不写；未知 type 按 text 兜底）；⚠️ **落地前须企业版确认**（已发信问 C1/C2/C3），确认前只做**读侧容忍**。
