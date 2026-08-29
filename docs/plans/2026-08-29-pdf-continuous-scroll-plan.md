# 「PDF 连续滚动（虚拟化）」落地文档（方案 B / 已实现，待发布）

> 一句话：**把 PDF 阅读器从"单页翻页"升级为"整篇纵向连续滚动"——一次把整篇文档的页块纵向堆叠，只挂载视口 ± 1 页缓冲的页块（虚拟化），其余页只占位、不渲染，保持整段可滚且不叠盖。批注随页块走：每个可见页块仍是自包含的 `PdfAnnotationCanvas`（工具条/撤销/选中/批注都在块内）。**
>
> 状态：**已实现**（工作区 3 改 + 1 新增 `src/lib/pdfLayout.ts`）。验证：`tsc` / `smoke`（309 = 300 + 9 布局）/ `pnpm build` 全绿。
>
> 关联：`docs/plans/2026-08-27-pdf-annotation-plan.md`（M24 母方案）、`docs/plans/2026-08-28-pdf-render-engine-mupdfjs-vs-pdfjs.md`、`src/components/PdfReader.tsx`、`src/components/PdfAnnotationCanvas.tsx`、`src/lib/pdfLayout.ts`、`src/App.css`。

---

## 1. 背景与目标

此前的 PDF 阅读器（v1.59.180 重构 + v1.59.186 打磨）是**单页驱动**：舞台一次只渲染一页，滚动到顶/底边缘自动切页（350ms 去抖 + 方向锁）。问题：

- **只能逐页看**，没法像浏览器 PDF 阅读器那样自由地纵向连续滚动浏览整篇。
- 自动翻页在快速滚动时触发阈值/方向锁，交互不够"顺滑"。

本次把阅读器改为**连续滚动**（方案 B），核心收益是三块：**连续浏览**、**批注随页块**（每页的标注与它的块绑定，翻到时即见）、**内存可控**（虚拟化，不全量渲染）。

---

## 2. 核心决策：虚拟化连续滚动

### 2.1 页块布局模型
- 连续模式所有页共享一个**内容宽** `contentW`（= 舞台内容区宽度 − 内边距，用 `ResizeObserver` 监听，随最大化/侧栏变化）。
- 每页占位高 `slotH = CHROME(96) + 页面图像高`，图像高按页面宽高比 `(h/w)×contentW`；未加载元数据的页按典型 A4 比例（√2）估算。
- 全部页的 `top`（前缀和）与 `total`（整段高）用 `useMemo` 一次算好，滚动时不再 O(n) 回算。

### 2.2 虚拟化
- 舞台（`.pdf-reader-stage`）`overflow: auto`，内部 `.pdf-continuous` 是 `position: relative` 且 `height = total` 的容器。
- 每页块 `.pdf-continuous-page` **绝对定位**在 `top = tops[i]`，宽 = `contentW`，`minHeight = heights[i]`。
- **只挂载** `[视口页 − buffer, 视口页 + buffer]`（buffer=1）；其余页只占位（不渲染 DOM/图像），保持滚动轴高度正确。
- 页块数据（meta + 图像 + 文本层）按页懒加载：图像走共享 `pageCacheRef`（LRU ≤12，淘汰时跳过仍挂载的页），文本层后台算，meta 首屏一次性预取全部（仅尺寸，秒回）。

### 2.3 保持的能力
- **批注随页块**：每页仍用自包含 `PdfAnnotationCanvas`，其工具条/撤销栈/选中/批注都随块存在；连续模式下的工具条+状态条 `position: static`（不再吸顶——避免多页 sticky 互相叠盖）。
- **侧栏/目录跳页**：`gotoPage` 把该页顶部滚动对齐到舞台顶。
- **键盘导航**：←/→/↑/↓ 跳上一页/下一页（改为滚到上一/下一页，取代原有的"滚动边缘自动翻页"）。
- **适配页宽（F）**：按内容宽设置缩放，让首页图像 1:1 填满内容宽；打开时自动执行一次。
- **AI 帮读 / 对整篇提问（`PdfAskBar`）**：不变，仍按 `getPageText` / `rankRelevantPages` 走。
- **默认最大化**；侧栏/目录可视化。

### 2.4 取舍
- 缩放（+/−）在连续模式下主要影响**栅格分辨率**（`render_page` 的 scale），显示宽度被 `.pdf-annot-img { max-width:100% }` 封顶为内容宽——与旧单页行为一致（旧模型同样是 fit-width 封顶）。
- 布局数学抽成纯函数 `src/lib/pdfLayout.ts`（`buildLayout` / `computeViewport` / `slotHeight`），用 `smoke-web.mjs` 的 9 条断言锁定：占位高按宽高比、未知页用估算、前缀和正确、视口挂载范围正确、底/顶 current 页正确、空文档安全。

---

## 3. 数据流（一次滚动 / 一次跳页）

1. **首屏**：`loadPdf` → 设 `ready`；`ResizeObserver` 报出舞台宽 ⇒ `contentW` 就绪 ⇒ `buildLayout` 算出全页 `tops/total`。
2. **预取 meta**：一次性 `getPageMeta` 全部页（仅尺寸，不光栅化），让布局从第一帧就用真实页高，避免逐页加载时布局跳变。
3. **首次聚焦**：`stageWidth>0 && metas[0] 就绪` 后 `gotoPage(targetPage)` ⇒ 滚动到目标页顶 ⇒ `updateViewport` 算挂载范围（rAF 节流）。
4. **滚动**：`onStageScroll` → `computeViewport(scrollTop, clientHeight, layout)` ⇒ 更新 `viewRange`（挂载范围 + buffer）与 `currentPage`（视口中心页）。
5. **挂载页加载**：`[viewRange]` 变化 ⇒ 对缺失的挂载页发起 meta/图像/文本层加载。
6. **跳页**：`gotoPage`/`onSidebarJump` ⇒ 设 `scrollTop = tops[i]` + `updateViewport`。

---

## 4. 改动清单

| 文件 | 改动 |
|------|------|
| `src/lib/pdfLayout.ts`（新增） | 纯布局数学：`CHROME`/`GAP`、`pageImageHeight`/`slotHeight`、`buildLayout`（前缀和）、`computeViewport`（视口范围 + 当前页）。 |
| `src/components/PdfReader.tsx` | 单页状态（`pageIndex/pageUrl/textItems/meta`）→ 连续滚动状态（`currentPage/viewRange/pageData/stageWidth`）；渲染改为 `.pdf-continuous` 内绝对定位页块；`updateViewport`/`focusPage`/`gotoPage` 改用布局模块；补 meta 预取、自动适配页宽、真实页高就绪后一次性重聚焦。 |
| `src/components/PdfAnnotationCanvas.tsx` | 无逻辑改动（保持自包含）；仅被连续模式复用。 |
| `src/App.css` | `.pdf-reader-stage` 去 flex 居中（改块布局 + 内边距）；新增 `.pdf-continuous`/`.pdf-continuous-page`；连续模式工具栏/状态条 `position: static`；另修复暗色下透明底 PDF 页不可读（给 `.pdf-annot-img`/`.pdf-annot-stage` 加白纸背景）。 |
| `scripts/smoke-web.mjs` | 新增 9 条布局断言（`buildLayout`/`computeViewport`）。 |

---

## 5. 验收要点

- [ ] 打开 PDF：整篇纵向连续滚动，可自由滚过整篇（不漏页、不叠盖）。
- [ ] 只渲染视口 ± 1 页缓冲；快速滚到远处时对应页块能即时出现（缓存命中）。
- [ ] 每页批注随块显示：标注覆盖在正确的页块图像上，坐标对齐。
- [ ] 侧栏/目录跳页滚动到目标页顶；←/→/↑/↓ 逐页滚动；F 适配页宽；Esc 关闭；+/− 缩放。
- [ ] 暗色主题下 PDF 文字/正文在白纸上可读（透明底 RGBA → 白纸背景）。
- [ ] AI 帮读 / 对整篇提问功能不回归。
- [ ] `tsc` / `smoke`（309）/ `pnpm build` 全绿。
