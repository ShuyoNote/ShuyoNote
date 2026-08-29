# 「对整篇 PDF 提问」（M24 阶段 3 延伸）落地文档（方案 / 已实现，待发布）

> 一句话：**在 PDF 阅读器里对整篇文档提问，先用 keyword/char-bigram 相关页检索（方案 B）挑出最相关的页，再喂给 AI 流式回答——省 token、更准，且离线可用（不依赖向量端点）。问答可一键存成带 `pdf://` 回链的笔记块。**
>
> 状态：**已实现**（未提交，工作区 7 文件：6 改 + 1 新增 `src/components/PdfAskBar.tsx`）。验证：`tsc` / `smoke`（300）/ `pnpm build` / `cargo test`（33）全绿。待并入版本发布。
>
> 关联：`docs/plans/2026-08-27-pdf-annotation-plan.md`（M24 母方案 §3 AI 帮读）、`docs/plans/2026-08-28-pdf-render-engine-mupdfjs-vs-pdfjs.md`、`src/lib/searchSemantic.ts`、`src/lib/pdfEngine/pdfjsEngine.ts`、`src/components/PdfAskBar.tsx`、`src/components/PdfReader.tsx`。

---

## 1. 背景与目标

M24 母方案（§3）明确「2026 破局点在 AI 帮读——AI 摘要高亮、生成大纲、**对 PDF 提问**」。此前已落地：
- **阶段 1**（v1.59.178/179）：双引擎渲染 + 批注 + 摘录成块 + 精确划词 + OCR。
- **阶段 3**（v1.59.181）：**AI 帮读**——划选一段 → AI 总结 → 生成 `pdf://` 回链块。

本次是其延伸：**从"单段总结"升级到"对整篇文档问答"**——读完后能直接概括、盘点、追问某个点，才是"读完再答"的完整闭环。

---

## 2. 核心决策：相关页检索（方案 B）

实现**方案 B**：提问时段提取整篇文本，用 **char-bigram Jaccard**（`semanticScore`）把问题与各页比对，只把**最相关的 ≤5 页**喂给模型。

### 为什么选 B 而非全量喂（A）
| 维度 | A：全量/截断喂 | B：相关页检索（本次） |
|------|----------------|----------------------|
| token 用量 | 高（整篇/截断） | **低（只相关页）** |
| 准确性 | 长文档截断易漏关键页 | **相关问题命中正确页** |
| 离线/无向量端点 | ✅ | ✅（char-bigram 天然离线） |
| 复杂度 | 低 | 中（需一屏提取+检索） |
| 长文档成本 | 高 | **低（提问才提取，且只喂相关页）** |

**选 B**：`rankRelevantPages` 是纯函数、可冒烟断言；离线可用无后端依赖；长文档更省、更准。

---

## 3. 数据流（一次提问）

1. **提取整篇文本**：逐页 `eng.getPageText(pageIndex)`（新增：仅返回该页字符串，无坐标/无光栅化，比 `getPageTextItems` 便宜），带页码。
2. **检索相关页**：`rankRelevantPages(question, pages, 5)` → 按 `semanticScore`（char-bigram Jaccard）降序取前 5；无命中则回退前 3 页并提示"未找到明显相关页"。
3. **组装上下文**：只把相关页拼成 `[第 N 页]\n<text>`（每页截 1800 字，总上限 6000 字）。
4. **问答**：`runInlineDraft`（复用 AI 薄 Agent + `useAiStore` Provider 配置），prompt 要求"针对相关页回答，找不到就如实说明"。流式 `onDelta` 展示。
5. **存成块**：一键把 Q&A 存成笔记块（`pageToBlock` 的 `pdf://` 回链语义，可点击回跳）；留空时提示。
6. **展示**：栏内标注「依据 N、M 页」，加载/错误/流式均有状态反馈。

---

## 4. 改动清单

| 文件 | 改动 |
|------|------|
| `src/lib/searchSemantic.ts` | 新增纯函数 **`rankRelevantPages(question, pages: PdfPageText[], topN=5)`** + 接口 `PdfPageText` |
| `src/lib/pdfRender.ts` | `PdfRenderEngineApi` 加**可选** `getPageText(pageIndex): Promise<string>`（引擎可缺省；调用方 `?.` 守卫） |
| `src/lib/pdfEngine/pdfjsEngine.ts` | 实现 `getPageText`：`getTextContent()` 拼接 `str`，`?.` 容错 |
| `src/components/PdfAskBar.tsx` | **新组件**：提问输入 + 提取/检索/问答 + 流式显示 + 存成块 |
| `src/components/PdfReader.tsx` | 顶部加「对这篇 PDF 提问」切换按钮（波形图标）+ 底部渲染 `PdfAskBar`（传 `getEngine`/`attachmentId`/`pageCount`） |
| `src/App.css` | `.pdf-reader-askbar` / `.pdf-askbar-*` 样式 |
| `scripts/smoke-web.mjs` | 新增 2 条 `rankRelevantPages` 断言（smoke 298→**300**） |

---

## 5. 关键实现细节

### 5.1 `rankRelevantPages`
```ts
export function rankRelevantPages(question: string, pages: PdfPageText[], topN = 5): PdfPageText[] {
  const q = String(question ?? "").trim();
  if (!q) return [];
  return pages
    .map((p) => ({ page: p, score: semanticScore(q, p.text) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((r) => r.page);
}
```
复用母方案 M20.2 的 `semanticScore`（char-bigram Jaccard），**离线、无向量端点依赖**，与既有语义检索一处来源。

### 5.2 引擎 `getPageText`
- 只取文本字符串（`getTextContent().items[].str` 拼接、压缩空白），不计算坐标——比 `getPageTextItems` 轻。
- **可选**接口：Web pdf.js 实现；native/其它引擎可不提供（调用方 `eng.getPageText?.()` 守卫 + 空数组回退）。

### 5.3 UX
- **入口**：阅读器顶部工具栏（在「批注侧栏开关」旁）波形图标，`askOpen` 切换底部栏。
- **提问栏**：输入框 + 「提问」按钮；Enter 触达。
- **回答区**：`依据 N、M 页` 来源标注 + 流式文本 + 「存成块」按钮；错误/toast 反馈。

---

## 6. 边界 / 诚实标注

- **提取成本**：提问时段逐页 `getPageText`（仅字符串），长文档（如 100 页）可能有几秒提取延迟；已缓存（`pageTextCache`）供同文档多次提问复用，不重复提取。
- **命中率**：char-bigram Jaccard 是**离线近似**，非真向量语义；对"改写换词"相关性问题可能漏命中（score=0 则回退前 3 页并提示）。后续可叠加向量端点（`semanticEmbed`/`embedText`）作为可选加分，不破坏现状。
- **模型长上下文**：每页截 1800 字、总上限 6000 字，避免超出模型窗口；长文档极端情形可能只见部分相关页。
- **不做**：跨多个 PDF/全局文档问答；把全文灌进向量库做持久 RAG（那是更大工程，本方案用轻量相关页检索替代）。
- **需要 AI 已配置**：问答依赖 `AiSettingsDialog` 里 Provider 可用（未配置/失败走 toast 降级）。

---

## 7. 验收清单（发布前逐项勾）

- [ ] `smoke-web.mjs` **300 项全绿**（含 `rankRelevantPages` 2 条断言）。
- [ ] `tsc` / `vite build` / `cargo check` / `cargo test --lib`（33）通过。
- [ ] 打开 PDF → 点「对这篇 PDF 提问」→ 输入问题 → 显示「依据 N、M 页」+ 流式回答。
- [ ] 问题明显关于某一页时，检索只命中该页（`依据 3 页` 之类），不误喂全篇。
- [ ] 无命中（无关问题）→ 回退前几页并提示"未找到明显相关页"，仍能回答。
- [ ] 「存成块」把 Q&A 存成笔记块，含 `pdf://` 可点击回链；无当前页则新建页。
- [ ] 长文档：回答前提取不卡死（有缓存）；再次提问复用缓存。
- [ ] AI 未配置 → 明确失败提示，不静默。

---

## 8. 是否值得做（回顾）

- **价值**：读论文/合同/报告后"问一句"是高频真实需求；`pdf://` 回链让回答可追溯、可归档为笔记。
- **成本**：复用现有 AI 管线 + `semanticScore`，仅新增一个轻量纯函数 + 一个提问栏组件——**增量小、可测、离线上**。
- **结论**：**值得做**，且已在本次实现。既补齐 M24 阶段 3 的"读完问答"，又没引入重 RAG 工程。
