# PDF 阅读器 + OCR/AI 增强 · 落地文档（叠加于 v1.59.190）

> 阶段：✅ 已落地（未单独升版本；按约定修复/增强轮不 bump，当前仍 v1.59.190）。
> 范围：本会话在 `2026-08-29-pdf-continuous-scroll-plan.md`（v1.59.187 连续滚动）与阅读器系列基础之上，补充的一批 **阅读体验 / 批注打磨 / OCR 离线化 / 视觉大模型识别 / AI 目录 / 护眼 / 系统朗读** 功能。

## 一、目标与一句话

把「扫描版电子书」也纳入完整使用闭环：**能看到（连续滚动+护眼）、能标记（便签/高亮/描边/拖动/双击编辑/控制条）、能转录（离线 OCR + AI 视觉识别）、能构建（AI 一键生成目录）、能听（系统朗读）、能带走（复制/写入便签/导出批注）**。

## 二、新增模块与要点

### 1. 阅读体验
- **光标修正**：`select`（选择）工具用默认箭头而非 `crosshair`；仅绘制类（高亮/画笔/便签）用 `crosshair`；便签拖拽时 imperative 置 `grabbing`，结束恢复到当前工具光标。`PdfAnnotationCanvas`.
- **按工具区分的 SVG 光标** + 便签钉圆角小方块带右上折角（美观）。
- **便签默认显示内容**：便签钉 + 内容气泡（`pointer-events:none`，不拦截拖动/描边；定位与钉一致、拖动跟随）。`.pdf-sticky-bubble`.
- **便签拖动简化**：`select` 下按住便签即直接拖动（同时选中），无需先点选一次。
- **便签双击即编辑**：`onStageDblClick` + 纯函数 `stickyEditRegion`（覆盖钉 + 气泡区域，随舞台尺寸折算，`pdfLayout.ts` 可单测）。
- **便签控制条修复**：注册到 `controllersRef` 的控制器用陈旧闭包（`selected`/`annotations` 停在挂载初值）→ 摘录/删除/AI/复制/编辑/导出点了无效；把 `selected`/`annotations` 加入注册 effect 依赖重新注册新鲜闭包。`PdfAnnotationCanvas`.

### 2. 侧栏 / 定位 / 跳转
- **标注后右栏及时刷新**：`PdfAnnotationCanvas` 在 `persist`/`undo` 后触发 `onChanged` → `PdfReader.refreshAnnRecords` 重拉批注记录。
- **侧栏批注精准定位**：`focusAnnotation` 把标注垂直中心滚到视口中央（非页顶），绝对 Y = `tops[i]` + 归一化 y × `pageImageHeight`（用基准 `refW/refH`）；`annCenterY` 纯函数（`pdfLayout.ts`）。
- **跳转侧闪烁框贴合**：`focusTarget` effect 用 `drawBoxPx` 计算框（便签 26px 方块、高亮/矩形 box、墨迹 points 包围盒），避免便签 box(0.04×0.06) 与 26px 绘制不符导致的错位。W/H 上移到组件顶部供 effect 复用。

### 3. 护眼模式（多档位）
- 阅读器头部「眼睛」下拉：**关闭 / 柔光 / 暖黄 / 夜间 / 淡绿**（`EyeMode`，本地持久化 `shuyonote.pdf.eyecare`，无偏好默认「柔光」）。
- 每档位只定义 CSS 变量（`--eye-bg/-bg-dark/-stage/-fg/-filter`），共享规则应用；对各档 `.pdf-reader.eye-*` 换暖色纸底 + 页图降蓝/柔光滤镜（`sepia`/`hue-rotate`），只作用于页面图像、不影响批注 SVG。

### 4. OCR 彻底离线
- `scripts/copy-tesseract-assets.mjs` 把 `tesseract.js/dist/worker.min.js`、`tesseract.js-core`（wasm 加载器 + .wasm）、`@tesseract.js-data/{chi_sim,eng}` 的**完整 `4.0.0`** 模型（`.traineddata.gz`，中文 ~19MB / 英文 ~10.4MB）拷进 `public/ocr`（已 gitignore）；`dev/dev:web/build` 前运行。新增 devDeps：`tesseract.js-core`、`@tesseract.js-data/chi_sim`、`@tesseract.js-data/eng`。
- 关键修复：**tesseract.js `is-url` 判断 `langPath`**——相对路径 `/ocr/tessdata` 被判非 URL → 浏览器走 `readCache`(IndexedDB) 而非 `fetch` → 模型加载失败、识别空。改为 `workerPath/corePath/langPath` 统一**绝对 URL**（`new URL(path, location.origin)`）。首次构造输出 `[ocr] local assets`。
- 模型切换：`4.0.0_best_int`（整数量化）在 core v7 下 `Failed loading language`；**完整 `4.0.0` 可加载**。
- `ocr.ts` 重构：`createOcrWorker`（复用单 worker，避免每页重载模型）+ `recognize`/`ocrRecognize`，带创建超时、识别超时、结构化 `{text,error}`。

### 5. AI 视觉大模型识别（`src/lib/ai/ocrVision.ts`）
- 「AI 识别」按钮：把页面 **3.5× 高分辨率重渲染 → `data:image`** 直接发给 Ollama / OpenAI 兼容的多模态模型，识别整页文字；`ocrWithVision(config, imageDataUrl, prompt)`。对中文/复杂/低清扫描件通常远优于 tesseract。

### 6. AI 一键生成目录（视觉大模型优先）
- 新增 `generateOutlineFromVision`（`src/lib/aiOutline.ts`）：逐页把页面图发给视觉模型，用 `visionPagePrompt(pageNo)` 让其**直接输出该页章节标题+页码 JSON**，合并 → `toOutlineItems`。逐页进度 / 取消 / 缓存。
- 旧 tesseract 路径 `generateOutlineFromOcr`（OCR 文本 → LLM 提取）保留作回退。

### 7. 系统朗读（`src/lib/speech.ts`）
- 封装 Web Speech API（`speechSynthesis` + `SpeechSynthesisUtterance`，`zh-CN`）：`speak/stopSpeech/isSpeaking/isSpeechSupported`。顶部工具栏「朗读本页」（有文本层拼 `textItems` 全文；扫描版提示先识别），识别结果弹层「朗读/停止」。

### 8. 识别结果弹层
- `createPortal` 到 `document.body` 的**居中弹层**（规避页块 `transform` 对 `position:fixed` 的约束），**可拖动右下角缩放**（`resize:both`，默认 720×72vh），文本区撑满、14px/行高1.75；分类显示识别文字 / empty / timeout / error；操作：**朗读 / 复制全部 / 写入便签**。

### 9. 单页 OCR 精度
- 单页 OCR 用 `renderPage` 回调**3.5× 高分辨率重渲染**（后回调 2.5× 避免超大位图报错）+ 传 `tessedit_pageseg_mode=6`（单栏正文）。

## 三、关键文件

- `src/components/PdfReader.tsx`、`PdfAnnotationCanvas.tsx`、`PdfAnnotTopToolbar.tsx`、`PdfOutline.tsx`、`pdfAnnotController.ts`
- `src/lib/ocr.ts`、`src/lib/pdfLayout.ts`（`annCenterY`/`stickyEditRegion`）、`src/lib/pdfOutlineGen.ts`（纯函数）、`src/lib/aiOutline.ts`、`src/lib/ai/ocrVision.ts`、`src/lib/speech.ts`
- `src/App.css`（护眼 `.eye-*`、`.pdf-ocr-popover`、`.pdf-sticky-bubble`、`.pdf-outline-ai*`、`.pdf-ocr-actions` 等）
- `scripts/copy-tesseract-assets.mjs`

## 四、验收 / 边界

- **自动化**：`tsc` / `pnpm build` / `node scripts/smoke-web.mjs`（338 断言，含 `annCenterY`/`stickyEditRegion`/`buildOutlinePrompt`/`parseOutlineJson`/`toOutlineItems`）；`cargo check`。
- **已知边界**：
  - OCR 精度上限由原扫描清晰度决定；`4.0.0` 为可离线加载的最高可靠模型。
  - AI 视觉识别 / 视觉目录需配置**支持图像的模型**（DeepSeek 纯文本会失败）。
  - Web Speech 音色为系统自带；中文语音包缺失时静默无声（可升级为 AI TTS）。
  - 目录生成逐页视觉调用较慢（约 60 页需 1–2 分钟，可取消）。
