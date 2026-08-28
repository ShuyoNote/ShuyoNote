# 「PDF 批注」方案（M24，规划 / 建议，未实装）

> 一句话：**值得做，但别排在最前。** 竞品批注的天花板在「标注即思考」的红利层（MarginNote/LiquidText），而块笔记品类的现实顶格是思源；2026 真正的破局点是「**AI 帮你读**」——这恰好可以并进 ShuyoNote 已有的薄 Agent 路线。
> 状态：**规划**（设计稿 + 对标 + MVP 切割），**未实装**。落地日期建议排在 M20/M23 之后。

---

## 1. 背景与判断

ShuyoNote 的目标用户是知识工作者 / 研究者，**PDF 挑注（读论文、合同、报告）是高频硬需求**。当前项目只有 **PDF 导出**（M5），没有 PDF 阅读 / 批注。

三个关键判断：

1. **批注本体已同质化**：各家都用 pdf.js / PDFium 渲染，高亮 / 下划线 / 画笔画出来都差不多。**差异不在"怎么划线"，而在"挑注之后能干什么"。**
2. **最有类比价值的是思源**：它把批注做成了「块笔记内置」的顶格——划词 / 高亮 / 页面评论 + **「摘录到文档」成块引用** + **关联块** + 目录大纲 + OCR + 记忆卡片 / Anki。这是 ShuyoNote 该对标的**现实截止线**。
3. **不是最优先的下一步**：M19 织网 / M20 语义检索 / M18 内联起草都属于「打磨核心价值 + 跨内容复利」，ROI 更高、更便宜，且能放大批注真正想要的"链接 / 检索"链路。

**结论：进路线图，但不是现在；按 MVP 切，别掉进"完整 PDF 批注"的无底洞。**

---

## 2. 竞品天花板对标

| 档位 | 代表 | 天花板 | 对 ShuyoNote 的含义 |
|------|------|--------|---------------------|
| **第一档·批注即思维工作台** | [MarginNote 3](https://apps.apple.com/cn/app/marginnote-3/id1423522373?l=en-GB&mt=12)、[LiquidText](https://apps.apple.com/mo/app/liquidtext/id922765270) | 高亮 / 批注直接**进脑图**、**自动生成卡片 + 导出 Anki**、学习模式、OCR、目录大纲；或把选中段落**摘到工作区**连起来、按相关性折叠。读→想→记闭环 | **不追。** 脑图 + 卡片 + Anki 是整套"阅读学习"体系，成本极高且超出 ShuyoNote 主轴 |
| **第二档·块笔记内置顶格** | [思源笔记](https://adg.csdn.net/69709019437a6b40336ab94e.html) | 划词 / 荧光笔 / 下划线 / 页面评论 + **摘录到文档（块引用）** + **关联块** + 目录大纲 + OCR + 标签 + **记忆卡片 / 导出 Anki** | **现实截止线，本方案的 MVP 目标** |
| **第三档·没有 / 依赖插件** | Notion（[几乎无原生批注](https://pdfannotations.com/es/guides/notion-pdf-reading-database/)）、Obsidian（[原生无，靠插件](https://github.com/gris/study-pdf)，[ZotLit](https://github.com/aidenlx/zotlit) 拼出 Zotero→Obsidian→Anki 管线） | 低 / 碎片化 | Notion 不是门槛；Obsidian 靠插件，源码与体验分散 |

> **2026 前沿**：[Best PDF Annotation Tools (2026)](https://tesify.app/best-pdf-annotation-tools-researchers-compared-2026/) 与 [best-pdf-annotator 对比](https://fabric.so/comparison/best-pdf-annotator) 显示，最新差异化已从"标注多细"转移到"**AI 帮你读**"：AI 自动摘要高亮、一键生成大纲 / 学习笔记、**对 PDF 提问**、实体 / 引用发现、OCR 让扫描件也能划词。

---

## 3. 定位与差异化（为什么 ShuyoNote 能做、且值得做）

- **批注即块**：批注（尤其"摘录"）作为**块级实体**进入 ShuyoNote 的现有体系——进 `content_text`（可搜 / 反链 / 关系图）、可被 `((id))` 块引用、可打标签、可关联数据库视图。这是它区别于"只是个看图工具"的**核心价值**。
- **本地优先**：渲染与批注全部本地，无云依赖，契合产品灵魂。
- **AI 差异化切入**：不必做完整 ink / OCR，而是"**划选 → AI 总结你选中的这段 → 生成笔记块 / 卡片**"，复用 `src/lib/ai/`（薄 Agent）与 M18 内联起草交互，把"批注"升级为"读得快、记得住"。这是 2026 真实拉开的差距。

---

## 4. 范围与 MVP 切割

### 阶段 1（MVP，本方案落地范围）
1. **渲染**：附件 PDF → **桌面用 Rust 原生（`pdfium-render`/`mupdf-rs`）、Web 用 pdf.js（Worker）** 分页渲染成图像，进入阅读器（翻页 / 缩放 / 页码导航）；`pdfRender` 暴露双引擎一致接口。
2. **批注**：每页在页面图像上叠加**高亮（半透明）/ 荧光笔 / 画笔 / 便签**，坐标归一化存储，不写回源 PDF；按 `hasTextLayer` 决定**划词高亮**还是**矩形框选 + 画笔**。
3. **存储**：批注按「附件 id + 页码」内容寻址持久化（沿用附件 / 版本链路）；渲染页字节走内容寻址附件。
4. **链接**：把某条批注/摘录"转正"成一个块（带 `pdf://attachment#page` 回链），进 `content_text`、模糊反链、FTS、关系图。
5. **基础增强（可选一并做）**：目录大纲解析（outline）、整页摘录、OCR 兜底钩子（无文本层时可启用）。

### 阶段 2（有真实用户需求再上）
- **写回原 PDF**（标准注释 / ink annotation / FDF 导出）——Tauri 专属，很贵，长尾。
- **文本层精确划词**（text layer 命中）+ **OCR**（扫描件即可划词）。
- 批注**版本历史**编排、空间内全局批注检索。

### 阶段 3（差异化）
- **AI 帮读**：划选 → AI 总结 / 生成要点块 / 生成卡片；「对这篇 PDF 提问」。复用薄 Agent。

> **明确不做的（诚实标注）**：多人实时协同批注（需 WebSocket 后端）；全文改写 / 编辑 PDF；手写识别。

---

## 5. 技术方案

### 5.1 渲染引擎选型（双引擎：桌面原生 + Web pdf.js 回退）
| 平台 | 引擎 | 理由 | 代价 |
|------|------|------|------|
| **桌面（Tauri）** | **Rust 原生渲染**（`pdfium-render` 或 `mupdf-rs`） | 大型/复杂 PDF 性能**最强**；把 PDF 解释/渲染挪到桌面后端，前端只收页位图 | 需一条 Rust 渲染命令；每页位图走内容寻址附件 |
| **浏览器（Web）** | **pdf.js** | 纯前端、跨平台、WASM/WebView都能跑，保住"双平台一套前端" | 大/复杂 PDF 偏慢，靠 Worker + 虚拟化 + 按视口渲染扛 |
| 可选加速 | **pdf.js WASM**（或 MuPDF-WASM） | 仅加速 JPEG2000/JBIG2/CCITT 等**特殊解码器**，非整体管线重写 | WASM 资产需正确托管（Vite `?url`/workerSrc/wasmUrl）；**别指望它救大型 PDF** |

**选型原则**：不把宝全押在 pdf.js。`pdfRender.ts` 只暴露 `loadPdf` / `renderPageToBlob` / `getOutline` / `hasTextLayer` 这一层接口，下面**双引擎可换**：桌面走 Rust 原生（`platform` driver 层提供该能力，Web **优雅降级**到 pdf.js）——这正契合 M16 的"能力存在但可降级"。**大文件体验最好的是桌面原生**，这是 ShuyoNote 带 Rust 后端 + driver 抽象的优势；此前方案里"尽量零新增 Rust 命令"一句**过于保守，予以修正**：桌面可加原生渲染命令，不破坏平台承诺。

pdf.js 性能真相（2026）：
- 慢的不是 `<canvas>` 光栅化（浏览器 GPU 加速），而是 **PDF 解释**（内容流解析、构建显示列表、字体/着色、图像解码）在 JS 里跑。
- **WASM 版本**只加速**特定重型解码器**（JPEG2000/JBIG2/CCITT），核心解释器仍是 JS，**不是整体重写**；PDFium/MuPDF-WASM 才是"单进程快"的替代。
- 真正杠杆（比 WASM 重要）：**Web Worker + `OffscreenCanvas`** 离屏渲染 + **虚拟化懒加载 / LRU** + **按视口比例渲染** + **流式 / Range 请求**。参考 [pdf.js advanced loading / worker 实践](https://www.nutrient.io/blog/pdfjs-advanced-loading-streaming-workers/)。

### 5.2 文本层选择与 OCR 兜底
- pdf.js 文本层对常规 PDF 够用；但对**扫描件 / 复杂 / 多栏 / 异常编码 / 连字**文档，文本层坐标会退化，划词/高亮会不准。
- **兜底策略**（阶段 1 即考虑，不是阶段 2）：
  - `hasTextLayer(page)` 判定：**有文本层** → 允许文本级划词/高亮；**无/不齐** → 仅允许**矩形框选 + 画笔 + 便签**（矩形不依赖文本层，最稳）。
  - **OCR 兜底（Tesseract WASM）** 预留钩子：仅当"无文本层但确有划词需求"时启用，不拖累正常文档；Web 与桌面均可跑 WASM。

### 5.3 批注画布
- **推荐**：轻量**专用 overlay 画布** + 页面图像作背景（`<canvas>` 坐标 = 像素页面坐标，缩放只改变 viewport 变换，批注坐标始终锚定到页面像素）。高亮 / 便签语义最自然、锚定最稳。
- **备选（降成本）**：复用 [Excalidraw 高级方案](../plans/2026-08-24-excalidraw-advanced-plan.md) 的 InlineDrawing（Excalidraw）把页面图像作为画布内元素 + 在其上批注。省一套交互，但 Excalidraw 是无限画布、坐标非"页面锚定"，便签 / 高亮语义要绕，且整页做成一整个 Excalidraw 文档、元素查找开销大。
- **建议**：阶段 1 用**专用 overlay 画布**（锚定正确、语义干净）；若想极省，可以用 Excalidraw 重绘 `computeFitView`/保存/适配那套（[InlineDrawing](../plans/2026-08-24-drawing-solution-design.md)）当画布宿主。

### 5.4 复用与新增
**复用**：
- 内容寻址附件（桌 [attachments.rs](../architecture.md) / Web [cross-platform 方案](../plans/2026-08-24-cross-platform-plan.md) 的 `blobStore`）：渲染页字节、批注自身字节都走 hash 去重。
- 文件引用卡片 / 附件打开（M12.3a）：PDF 附件已可用「系统打开」，批注作为此之上的阅读器入口。
- 平台 driver 抽象（M16）：driver 层暴露 `renderPdfPage` 能力——**桌面走 Rust 原生**（`pdfium-render`/`mupdf-rs` 渲染页位图）、**Web 优雅降级到 pdf.js**；两个引擎对前端暴露**同一接口**，前端不感知引擎差异。
- AI（M17/M18 `src/lib/ai/`）：阶段 3 直接接。

**新增（文件级，见 §6）**：`PdfReader`（阅读器壳）+ 批注 overlay + `pdfRender`/`pdfAnnotation` 纯函数 + `PdfNode`（块节点）+ 少量持久化命令。

### 5.5 数据模型（参考，落地时并入 `db.rs` 迁移）
- `pdf_annotations`（`id`, `attachment_id`, `page_index`, `payload_json`（批注列表：`{type: highlight|ink|sticky|rect, coords, text, color}`）, `created_at`, `updated_at`）
- 渲染页复用 `attachments` 全局内容寻址（hash = 页图像，去重）。
- "摘录转正"的批注 → 作为普通块写回页面，块体内嵌 `pdf://attachment#page` 回链；`content_text` 收录。

### 5.6 入口与 UX
- 点开 PDF 附件卡片 → 「阅读并批注」进入 `PdfReader`（而非仅系统打开）。
- 阅读器：左侧缩略 / 连续滚动；页面上划选 → 浮动工具条（高亮 / 下划线 / 画笔 / 便签 / 摘录成块）。
- 「摘录成块」弹出可插入到当前页或新页，插入后带 `pdf:` 回链。

---

## 6. 文件级改造清单（落地参考）

| 文件 | 改动 |
|------|------|
| `src/lib/pdfRender.ts`（新） | **双引擎接口**：`loadPdf` / `renderPageToBlob` / `getOutline` / `hasTextLayer`；内部按 driver 选 `native`（Rust）或 `pdfjs`（Worker）引擎 |
| `src/lib/pdfEngine/pdfjsEngine.ts`（新） | pdf.js 封装：Worker + `OffscreenCanvas`、流式 / Range、虚拟化 / LRU、按视口比例渲染 |
| `src-tauri/src/pdf_render.rs`（新）+ 命令 | 桌面原生渲染：`render_pdf_page(attachment, page, scale) -> blob`（`pdfium-render` / `mupdf-rs`）；页位图走内容寻址 |
| `src/lib/pdfAnnotation.ts`（新） | 纯函数：坐标归一化 `normCoords`、批注 CRUD、schema 校验、`pageToBlock` 摘录转块、`hasTextLayer` 降级策略 |
| `src/components/PdfReader.tsx`（新） | 阅读器壳：渲染分页、翻页 / 缩放、页码导航、指向 `pdf-annotation-canvas` |
| `src/components/PdfAnnotationCanvas.tsx`（新） | overlay 画布：高亮 / 荧光笔 / 画笔 / 便签；页面图像背景；按 `hasTextLayer` 切换划词 or 矩形框选 |
| `src/editor/nodes/PdfNode.tsx`（新） | PDF 块节点（引用附件 + 页码），含"摘录成块"落点 |
| `src/components/InlinePdf.tsx`（新） | 正文内嵌 PDF 引用卡片 + 进入阅读器 |
| `src/lib/platform/web.ts` / `tauri.ts` | driver 层暴露 `renderPdfPage` 能力（桌面原生 / Web pdf.js 优雅降级）；web 页位图存 `blobStore`（内容寻址） |
| `src-tauri/src/attachments.rs` / `commands.rs` | `save/list/get_pdf_annotation` + `render_pdf_page`；`pdf_annotations` 表迁移 |
| `src-tauri/src/db.rs` | `pdf_annotations` 表迁移 + OCR/文本层状态字段 |
| `src/App.css` / 设计 token | 阅读器 + 批注画布样式、高亮半透明色、深浅主题 |
| `scripts/smoke-web.mjs` | 增加 `normCoords` / 批注 schema 校验 / 摘录转块 / `hasTextLayer` 降级纯函数断言 |

---

## 7. 验收标准（阶段 1）

- 打开 PDF 附件 → `PdfReader` 分页渲染正确（图片 / 超大文件流式不卡，流程与 M12 文件处理一致）；**桌面走 Rust 原生渲染、Web 走 pdf.js Worker 降级，两者页面呈现一致**。
- 每页可高亮 / 下划线 / 画笔 / 便签；缩放后批注仍精确锚定原页面像素。
- **有文本层 → 允许划词/文本高亮；无/不齐 → 自动降级仅矩形框选 + 画笔 + 便签（OCR 兜底钩子就绪）**。
- 批注保存后重开仍在（内容寻址持久化，跨空间去重）。
- 「摘录成块」插入到页面后：进 `content_text`、可被 FTS 检索、可被 `((id))` 块引用、反链可指向该 PDF 附件。
- `npx tsc --noEmit` / `node scripts/smoke-web.mjs`（在该纯函数断言基础上"只增不减"全绿）/ `pnpm build` / `cargo check`。
- 无头 Edge CDP 实测：渲染、批注、摘录成块、反链，全程无运行时错误；深浅主题正常。

---

## 8. 边界与诚实标注

- **写回源 PDF / 文本层精确划词（依赖 PDF 解析语义的精细划词）**→ 阶段 2，很贵且偏 Tauri，**明确不做**（除非出现真实用户需求）；**OCR / 文本层判定降级是阶段 1 的兜底**，不是这里讲的"文本层精确划词"。
- **多人实时协同批注**→ 需 WebSocket 后端，超本环境范围，**不做**。
- **Web 平台**：pdf.js 可跑，但**超大 PDF 内存**（多页缓存）需按需渲染 + 虚拟化 + LRU，Web 用 `blobStore` 逐页；桌面用 Rust 原生渲染同样按需、避免一次性全载。
- **桌面/Web 双引擎**：桌面原生（`pdfium-render`/`mupdf-rs`）+ Web pdf.js，接口一致、呈现一致性需在验收中覆盖；Web 是降级不崩（`platform` driver"能力存在但可降级"红线）。
- **阶段 1 是"阅读 + 批注 + 链接"，不做"学习引擎"**（脑图 / 卡片 / Anki），那属于阶段 3 的"AI 帮读"之外、更远的差异化。

---

## 9. 下一步（若立项）

1. 立项（排到 M20 之后），按阶段 1 MVP 切。
2. 先写 `pdfRender` + `pdfAnnotation` 纯函数 + smoke 断言（不碰 UI 即可验证核心逻辑）。
3. 再做 `PdfReader` + 批注 overlay。
4. 摘录成块 → 反链 / 搜索闭环。
5. 复测对齐思源级别的"摘录 / 关联块 / 目录大纲"。

> 关联：[绘图方案](2026-08-24-drawing-solution-design.md)（画布复用）、[Excalidraw 高级](2026-08-24-excalidraw-advanced-plan.md)、[跨平台](2026-08-24-cross-platform-plan.md)（平台 driver）、[薄 Agent](2026-08-24-thin-agent-interface-plan.md)（AI 帮读）。
