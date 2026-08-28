# 「Web PDF 渲染引擎：MuPDF.js vs pdf.js」落地文档（M24，方案 / 待拍板）

> 一句话：**保持现状（桌面 native MuPDF 光栅化 + Web pdf.js 语义层）是当前最优；若 Web 端确需提速，只把「纯光栅化」换到 MuPDF.js、文本层/元数据/注释仍用 pdf.js，且必须先确认 AGPL 合规。**
>
> 状态：**方案**（决策结论 + 改动点 + 验收 + 回退 + 迁移步骤），**未实装**。本文档不触发任何代码修改；拍板后再落 `mupdfjsEngine.ts` 与引擎三态选择。
>
> 关联：`docs/plans/2026-08-27-pdf-annotation-plan.md`（M24 母方案）、`src/lib/pdfRender.ts`、`src/lib/pdfEngine/pdfjsEngine.ts`、`src/components/PdfReader.tsx`、`src/components/PdfAnnotationCanvas.tsx`、`src/lib/pdfTextLayer.ts`。

---

## 1. 结论（先给答案）

| 决策点 | 建议 | 理由 |
|--------|------|------|
| **Web 端换 MuPDF.js？** | **默认不换**（保持 pdf.js）；仅当「Web 端超大 PDF 渲染慢」成为真实用户痛点时才考虑 | 现有分层已把性能与可控性平衡得很好 |
| **若换，换到什么程度** | **只换光栅化**（`renderPageToBlob`），页面元数据 + 文本层 + 注释坐标**仍用 pdf.js** | 避开文本层坐标语义重写与 AGPL 覆盖面，风险最低 |
| **前置硬条件** | **先确认 AGPL 授权合规** | AGPL-3.0 传染性强，Web 端分发给用户时直接生效；不确认就做，可能被迫开源整站或付费 |
| **许可证** | pdf.js = Apache-2.0（宽松，闭源可商用）；MuPDF.js（WASM）= AGPL-3.0（传染） | 这是最可能的「一票否决」项，不是技术问题 |

---

## 2. 现状：pdf.js 在你项目里到底承担什么（已核实）

pdf.js 在 ShuyoNote 里**只做 4 件事**，且**全部集中在唯一入口 `src/lib/pdfEngine/pdfjsEngine.ts`**：

| 接口方法 | pdf.js 实现 | 消费方 |
|---|---|---|
| `loadPdf(data)→{pageCount}` | `pdfjs.getDocument({data, cMapUrl, standardFontDataUrl,...})` | `PdfReader.tsx` |
| `getPageMeta(i)→{w,h,hasTextLayer}` | `getTextContent()` 判空决定 `hasTextLayer` | `PdfReader.tsx` |
| `getPageTextItems(i)→[{str,transform,width,height}[]]` | `getTextContent()` + traverse | `PdfReader.tsx` → `PdfAnnotationCanvas` → `pdfTextLayer.snapHighlightToText` |
| `renderPageToBlob(i,scale)→Blob` | `page.render()` → canvas → Blob | `PdfReader.tsx`（经 `renderPagePng`） |

**关键利好**：抽象接口 `PdfRenderEngine`（`src/lib/pdfRender.ts`）把 pdf.js 隔离了。消费方只碰接口，不直接 `import pdfjs`。因此——

> 只要接口签名不变，迁移**只需重写 `pdfjsEngine.ts` 一个文件**；`PdfReader` / `PdfAnnotationCanvas` / `pdfTextLayer` **一行都不用改**（前提：适配层把坐标语义对齐成 pdf.js 的样子）。

这是我给出「可落地」判断的结构性原因。

---

## 3. 接口兼容性逐一核对（迁移可行性）

| 接口 | 能否用 MuPDF.js 等价提供 | 风险 | 备注 |
|------|--------------------------|------|------|
| `loadPdf` | ✅ 可以 | 低 | `mupdf.Document.openDocument` → `pageCount()` |
| `getPageMeta` | ⚠️ 可做，但 `hasTextLayer` 判定语义不同 | **中** | pdf.js 用 `getTextContent()` 判空；MuPDF 判定「可搜索文本页」标准不同。扫描页 vs 隐藏文本页可能误判，**会连带 OCR 降级触发条件** |
| `getPageTextItems` | ⚠️ 可做，但返回结构/坐标系不同 | **高（核心）** | pdf.js 的 `transform` 是 4×4 矩阵 + `fontMatrix` + textLayer CSS 坐标；MuPDF 的 `stext_page` 返回**页内绝对点坐标 + 字号**。**二者换算不同，这是划词/高亮精确性的来源** |
| `renderPageToBlob` | ⚠️ 可做 | 中 | MuPDF WASM 有 `render()` 出 raw / `savePixmapAsPng()`，但输出需转回 pdf.js 同款 Blob 与缩放语义 |

**最大坑：`getPageTextItems` 的 `transform` 与像素坐标系转换。** 必须写「pdf.js transform ↔ MuPDF textItem」单测，用同一份 PDF 对拍，保证 `pdfTextLayer.textItemBox` 结果一致，否则划词必偏。

---

## 4. 坐标归一化是否受影响（白盒级确认）

`src/lib/pdfTextLayer.ts` 的 `textItemBox(item)` 只信任接口返回的 `{transform,width,height}` 字段，把它归一化到页面矩形。它**不关心底层是 pdf.js 还是 MuPDF**。

- ✅ **结论**：只要 MuPDF 适配层把 `transform` 对齐成 pdf.js 语义，`textItemBox`、`snapHighlightToText`（精确划词）、`PdfAnnotationCanvas` 的 SVG overlay **都不用动**。
- ⚠️ **前提**：适配层必须**把 MuPDF 的绝对点坐标转成 pdf.js 的 transform/归一化坐标**。这一步做错，划词、高亮、摘录回链会整体偏移。**这是整个迁移唯一的硬技术点。**

---

## 5. 文本层 / 划词 / OCR 连带影响（高风险区）

| 现有能力 | 依赖 | 改成 MuPDF.js 后 | 风险等级 |
|---|---|---|---|
| 精确划词 `snapHighlightToText` | `textItems[].transform` 语义 = pdf.js | 坐标语义变了 → 必须重对拍 | 高 |
| `hasTextLayer` 降级 | pdf.js 判空 | 判定标准不同 → 可能误判扫描/文本页 | 中 |
| OCR 兜底 `ocr.ts` | 依赖「pdf.js 判定无文本层」触发 | 触发条件可能漂移 | 中 |
| `pdfRef` / 摘录成块回链坐标 | 页面坐标基准 | 基准变了 → 回链跳转位置可能飘 | 中 |
| `PdfAnnotationCanvas` SVG overlay | 归一化坐标 = pdf.js | 坐标对齐即可，无需改 | 低 |
| `pdfTextLayer.textItemBox` | `transform` 字段 | 适配层对齐即可 | 低 |

> 这些**都不需要改现有业务代码**——全都由「适配层坐标对齐」这**一个前提**决定。所以迁移的成败，系于第 4 步「坐标对拍」。

---

## 6. 性能 / 体积（值不值）

| 维度 | pdf.js | MuPDF.js WASM |
|---|---|---|
| 包体积 | 小（~1–2MB，你已拷 cmaps/标准字体/wasm） | **大（8–20MB+）**，首次加载明显变重 |
| 首屏渲染 | 中等 | 快 |
| 大/复杂 PDF | 慢 | 快（MuPDF 强项） |
| 中文/字体 | 已拷 CJK cmaps，好 | MuPDF 回退成熟，需实测 CJK |

**结论**：若 Web 端要提速，MuPDF.js 只值得用在**光栅化**（`renderPageToBlob`），把性能关键路径切过去，同时**保住 pdf.js 的文本层/坐标**——避免重写坐标、也缩小 AGPL 覆盖面。代价是**双引擎并存 + 体积增大**。

---

## 7. 许可证（一票否决项，先拍板）

| 引擎 | 许可证 | 对 ShuyoNote 的含义 |
|------|--------|----------------------|
| pdf.js | **Apache-2.0** | 宽松，闭源/商用无限制 |
| MuPDF.js（WASM） | **AGPL-3.0**（或 Artifex 商业授权） | **传染**：Web 端分发给用户，闭源/商业需整站开源或**付费** |
| 桌面 native（`mupdf-sys`） | 编译自 MuPDF 源码，**同理 AGPL 风险** | 仅本地渲染、不对外分发服务端代码，风险相对低；但分发桌面二进制到用户时也要评估 |

> **`mupdf-sys` 桌面路径与 MuPDF.js 同源，都有 AGPL 约束。** 若你把「闭源商用」作为产品预设，**桌面 native 路径也需要现在就确认授权方案**（或改用 PDFium——它用 BSD 类许可，且你原方案里 PDFium 也是候选项）。

---

## 8. 回退 / 灰度安全网（迁移前必须先有）

`pdfRender.ts` 现有 `PdfRenderEngine = "native" | "pdfjs"` 与 `pickEngine(caps)`。迁移建议扩成三态并加能力探测：

1. `type PdfRenderEngine = "native" | "mupdfjs" | "pdfjs";`
2. 新增 `mupdfjsAvailable()`：WASM 能否初始化 / 引擎能否加载；失败 → 回回退 **pdf.js**。
3. 用功能开关 / 环境变量灰度，先内测文本层与坐标，再全量。
4. 出问题一键回滚：`pickEngine` 返回 `"pdfjs"`，不阻塞发布。
   - `features.ts` / 环境变量加 `PDF_RENDER_ENGINE`（`native|mupdfjs|pdfjs`）+ 默认优先级 `native > pdfjs`（**没有数据支撑前，不把 mupdfjs 设为 Web 默认**）。

---

## 9. 落地步骤（若拍板迁移）

1. **冻结接口**：`PdfRenderEngine` 4 个方法签名不变（若必须变，先列 `PdfReader`/`PdfAnnotationCanvas`/`pdfTextLayer` 三处改动）。
2. **新增适配层 `src/lib/pdfEngine/mupdfjsEngine.ts`**：实现同一接口。
3. **坐标对齐（最高优先）**：写「pdf.js transform ↔ MuPDF textItem」转换单测，同一份 PDF 对拍。
4. **白盒对拍测试**：若干有文本 / 无文本 / 中文 / 扫描 PDF，逐页对比两引擎 `textItems` 输出结构与坐标。
5. **接 `pdfRender.ts` 引擎选择**：`native | mupdfjs | pdfjs` + 能力探测降级。
6. **灰度**：Web 内测 → 验证划词 / 高亮 / 摘录回链 → 全量。
7. **AGPL 合规**：确定授权模式；若不能接受，则只做「光栅化用 MuPDF.js + 文本层用 pdf.js」，或维持现状。

---

## 10. 验收清单（拍板后逐项勾）

- [ ] 接口兼容性核对完成（第 3 节 4 项皆有结论）
- [ ] 坐标对拍报告产出：同一份 PDF，pdf.js 与 MuPDF 的 `textItems` 输出**一致**（容差内）
- [ ] `textItemBox` / `snapHighlightToText` 在有文本层 PDF 上**划词不偏**（白盒目测 + 断言）
- [ ] 中文 / 扫描（无文本层）/ 旋转页 PDF 均验证坐标正确
- [ ] `hasTextLayer` + OCR 降级在扫描件上仍正确触发
- [ ] `pdfRef` / 摘录成块回链点击后**定位到正确页**且坐标不飘
- [ ] `renderPageToBlob` 输出与 pdf.js 同缩放、同尺寸、可被 `renderPagePng` 消费
- [ ] 能力探测：WASM 加载失败 → 自动回 pdf.js（回归，非全坏）
- [ ] 性能对比（可选）：同一批大 PDF，MuPDF.js vs pdf.js 首屏/翻页耗时记录
- [ ] 许可证：确认 AGPL 授权 / 豁免（或改走 PDFium），记录在案

---

## 11. 本期不改动（保持现状的边界）

- **不**重写 `pdfjsEngine.ts`。
- **不**把 MuPDF.js 加入 Web 依赖。
- **不**新增 `mupdfjsEngine.ts` / 三态引擎。
- **不**改动 `pdfRender.ts` / `PdfReader` / `PdfAnnotationCanvas` / `pdfTextLayer`。

> 除非第 1 节结论被推翻（出现「Web 端大 PDF 慢」的真实反馈），否则维持「桌面 native MuPDF + Web pdf.js」。

---

## 12. 开放性决定项（待你拍板）

1. **AGPL 是否可接受？** 若「闭源商用」是产品预设 → **桌面 native 也要重新考虑**（可能改 PDFium）。这是最优先要定的。
2. 若 AGPL 可接受：**Web 端是否确有大 PDF 性能痛点**？有 → 只换光栅化；无 → 维持现状。
3. 是否愿意接受 **8–20MB 包体积增长**（影响首屏加载）。

> 这三个都是**产品/许可决策**，不是技术决策。技术侧已确认「可落地 + 风险可控（前提是坐标对拍）」。**建议先定 1，再回来看 2/3。**
