# 「公式图片 / 手写识别」方案（M26 扩展）— 图片 → LaTeX、手写 → LaTeX

> 状态：**方案**（日期 2026-08-30）。关联：[公式方案](2026-08-30-formula-plan.md)（块级/行内公式渲染 + Notion 风格公式编辑器…）、[PDF 阅读器 AI 增强](2026-08-30-pdf-reader-ai-plan.md)、[公式编辑器弹窗（Notion 风格）](2026-08-30-formula-plan.md#公式编辑器弹窗notion-风格)。
> 目标：给公式编辑器弹窗补两个入口——**「图片识别」**（上传一张含公式的图片 → 自动转 LaTeX）与**「手写识别」**（手写板上写公式 → 自动转 LaTeX）。对标 Notion / FlowUs / wolai。

## 现状（方案前）

- 公式编辑器弹窗（`FormulaEditorDialog`）已有：希腊字母面板 + 符号工具栏 + LaTeX textarea + 实时 KaTeX 预览 + Ctrl+Enter 提交。**没有**图片/手写入口。
- **视觉识别能力已存在**：`src/lib/ai/ocrVision.ts` 的 `ocrWithVision(config, imageDataUrl, prompt)`——
  - 支持 Ollama（`/api/chat` + `images:[b64]`）与 OpenAI 兼容（`/v1/chat/completions` + `image_url`）。
  - `ProviderConfig { provider, baseUrl, model, apiKey }` 可来自 `useAiStore.getState().config`（AI 配置中心，已存 user 配置）。
  - `blobToDataUrl(blob)` 已提供 Blob → data URL。
- **canvas 2D 绘制**先例：`CoverCrop`（crop 用 canvas `getContext("2d")` + `canvas.toDataURL`）——手写板可直接复用该模式。
- **图片选择**：Tauri `platform.dialog.open`（桌面）/ `input[type=file]`（Web）；已有 `CoverPicker` 选图先例。

## 设计

### 依赖
- **复用现有 `ocrWithVision`，不新增后端命令**。识别只是视觉模型的一个「换 prompt」的调用（同 `ocrVision.ts` 已是独立视觉通道），不引入 Mathpix/MyScript 等外部付费 SDK。
- 需要**视觉模型已配置**（AI 设置里配了如 gpt-4o / qwen2.5-vl / llava）；未配置或非视觉模型时优雅降级：提示「请到 AI 设置配置支持图像的模型」。

### 1 · 图片识别（`FormulaEditorDialog` 加 🖼 按钮）

点击 🖼 → 选图 → `blobToDataUrl` → `ocrWithVision(config, dataUrl, FORMULA_PROMPT)` → 把返回的 LaTeX **追加/替换**到 textarea 并实时预览。

- **FORMULA_PROMPT**（关键）：
  ```
  识别图片中的数学公式，输出等价的 LaTeX 代码。只输出 LaTeX，用 \[ ... \] 包裹，不要任何解释、代码块标记或多余文字。若是行内公式用 \( ... \)。
  例：图片是 E=mc² → \[ E = mc^2 \]
  ```
- 结果清洗：`ocrWithVision` 已 trim；可再剥掉意外的 ```` ```latex ```` 围栏。
- **拖入/粘贴图片**（Notion 支持「拖入公式图片」）：监听 textarea 的 drop/paste，取 image → 走同一识别。
- 空闲/错误态：识别中显示 loading；失败显示可读错误（`VisionOcrResult.error`）。
- 限流：**不做云端每分钟限流**（那是 wolai 的免费额度策略）；但识别是用户主动点击、串行，不额外限。

### 2 · 手写识别（`FormulaEditorDialog` 加 ✎ 按钮）

点击 ✎ → 打开一个**手写板弹层**（canvas 2D + pointer events）：
- 白色画布，占位 E=mc²；笔尖拖拽书写；橡皮清除；右下「取消 / 提交识别」。
- 提交：`canvas.toDataURL("image/png")`（或裁剪到内容包围盒）→ `ocrWithVision(config, dataUrl, FORMULA_PROMPT)` → 回填 textarea。
- 复用 `CoverCrop` 的 canvas 指针事件写法（`onPointerDown/Move/Up` + `lineTo`/`stroke`）。
- 手写板组件：`src/components/FormulaHandwritePad.tsx`（纯前端，无新依赖）。

### 交互入口（对齐 Notion 截图）
公式编辑器弹窗**左下角**放两个图标按钮：
- 🖼 识别图片中的公式（上传/拖入/粘贴公式图片）
- ✎ 识别手写公式（打开手写板）

## 边界（诚实标注）

- **依赖用户已配置视觉模型**；未配置 / 非视觉模型 → 提示去配置，不崩。识别质量取决于模型（手写识别对模型能力要求较高，`qwen2.5-vl`/`gpt-4o` 类相对可靠；弱模型可能输出不如人意，用户可手改 textarea）。
- **识别结果自动回填 textarea，不直接提交**——用户可编辑/改后再点「确定」，保留人工确认（同「薄 Agent」的不丢确认红线）。
- **付费识别服务（Mathpix/MyScript）不接**——违反本地优先/可离线/无云依赖；视觉大模型已覆盖「公式转 LaTeX」主要场景。
- **不实现云端限流**（wolai 是服务端计费限流；我们走用户自配的视觉端点，无此语义）。
- 手写识别的**输入是 PNG 画布**，与图片识别共用 `ocrWithVision`；二者只是输入源不同。

## 验证

- `npx tsc --noEmit` 0 错。
- `node scripts/smoke-web.mjs` 全绿。
- dev 实测：
  - 上传/拖入一张含公式的图片 → textarea 出现 LaTeX、预览渲染。
  - 手写板写 `E=mc²` → 提交 → textarea 出现 `\[ E=mc^2 \]`、预览渲染。
  - 未配视觉模型 → 提示去配置，不崩；弱模型输出差 → 可手改。
  - 公式编辑器原希腊字母/符号/预览/提交不回归。

## 文件清单

- `src/lib/ai/ocrVision.ts`（或新增 `formulaVision.ts`）：加 `FORMULA_PROMPT` + `recognizeFormulaImage(config, dataUrl)`（薄封装 `ocrWithVision`）。
- `src/store/formulaEditor.ts`：不变（或加 `pendingImage` 等识别状态）。
- `src/components/FormulaEditorDialog.tsx`：加 🖼 / ✎ 两个按钮 + 图片选择/拖放 + 识别逻辑。
- `src/components/FormulaHandwritePad.tsx`（新增）：手写画布。
- `src/App.css`：手写板 + 识别按钮样式。
