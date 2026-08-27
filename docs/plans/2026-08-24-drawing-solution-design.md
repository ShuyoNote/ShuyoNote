# 「绘图方案」设计（Excalidraw + mermaid + AI 文生图）

> 目标版本：v1.60.x（提议）。关联：[路线图](../roadmap.md)、[AI 薄 Agent 方案](./2026-08-24-thin-agent-interface-plan.md)、[本地优先方案](./2026-08-15-local-first-note-app-plan.md)。
> 状态：**已实现（最终版）**。为 ShuyoNote 补齐「动手画」能力：自由手绘/涂鸦、结构化流程图/思维导图、以及 AI 生成图片，三块能力共用一套「内容寻址附件」底座。
> ⚠️ **最终修正（v1.59.128）**：绘图块改用 **Excalidraw 0.17.1**——Excalidraw **0.18.1** 内置 Radix Portal 在 React 19 下触发 `Maximum update depth` 无限循环（复现确认），而 **0.17.1**（`patch` 稳定版）在 React 19 正常。故废弃自研 `DrawCanvas`，绘图块内嵌 Excalidraw（手绘/文字/形状/图片/导出 JSON·SVG 原生能力）。mermaid 块（`/流程图`）与 AI 文生图（`/AI 绘图`）仍按方案实现。

## 1. 背景与目标

- 现状：图片走 `ImageNode`/`ImageRowNode` + 附件内容寻址；有**关系图**（力导向）、数据库、双链/反链、Markdown 往返。**没有任何画布 / 手绘 / 流程图 / 思维导图 / AI 生图能力**。
- 目标：给 ShuyoNote 增加三种「绘图」能力，且不破坏「本地优先 + 数据可搬移」：
  1. 自由**手绘 / 涂鸦**（触控笔 / 鼠标任意画）；
  2. 结构化**流程图 / 思维导图**（打字生成 + 可手画）；
  3. **AI 文生图**（文字描述 → 图片插入正文）。

## 2. 引擎选型（已确认）

| 引擎 | 许可 | 手绘 | 流程图/思维导图 | 结论 |
|------|------|------|----------------|------|
| **Excalidraw**（`@excalidraw/excalidraw`） | **MIT** | ✅ | ✅（形状/箭头/便签；思维导图靠人工布局） | **采用**：一张画布同时覆盖手绘与自由画图，纯前端、离线可打包、React 原生 |
| mermaid | **MIT** | ❌ | ✅（flowchart / mindmap / sequence / class，文本→SVG） | **采用**：结构图「打字生成」，轻量、可入库 |
| tldraw | 许可历史变动 | ✅ | ✅ | 不采用：条款易踩坑，偏「白板」而非「画图」 |
| React Flow（`@xyflow/react`） | MIT | ❌ | ✅（节点连线） | 不单独采用：无手绘，与 Excalidraw 能力重叠 |
| AI 文生图 | — | — | — | **采用**：接现有 `src/lib/ai/` provider 模式 |

> 采用 **Excalidraw + mermaid 双轨**（用户已确认）：Excalidraw 管「动手画」的自由图形，mermaid 管「打字生成」的结构图，各取所长。

## 3. 目标体验

### 3.1 绘图块（Excalidraw）
- 斜杠 `/绘图`：插入一个绘图块，块内显示 **Excalidraw 只读 PNG 预览** + 「编辑」按钮。
- 点击「编辑」→ 打开**全屏 Excalidraw 编辑器**（笔/橡皮/形状/箭头/文字/便签），支持撤销重做、导出 PNG/SVG/JSON。
- 保存：把 Excalidraw 的 JSON（`elements`+`appState`+`files`）写入**内容寻址附件**；导出 PNG 作为缩略图与反链展示；节点只存引用（`hash/mime/w/h/thumbHash`）。
- 避免在 Lexical 块内做焦点/帧争夺：绘图块只负责「预览 + 打开编辑器」的入口，编辑在独立全屏态完成。

### 3.2 mermaid 块
- 斜杠 `/mermaid`：插入 mermaid 块，输入源文本 + 选择 syntax（flowchart / mindmap / sequence / class…）。
- 渲染：mermaid → SVG（离线打包，无 CDN）。
- 点击块 → 打开**源文本编辑器**，改完重新渲染；解析失败显示内联错误 + 保留源文本，绝不崩。

### 3.3 AI 文生图
- 斜杠 `/AI 绘图`：弹出输入框描述画面 → 调用已配置文生图 provider（autoglm / 本地 SD / Ollama，沿用 `src/lib/ai/` 的 config / transport 模式）→ 生成图片字节 → 存为附件 → 插入 `ImageNode`。
- provider 不可用 / 失败 → toast + 可重试，不阻塞正文。

## 4. 技术要点

### 4.1 存储（复用内容寻址附件）
- 大字节统一走**内容寻址附件**（现有 `blobStore` / `save_image` / 各平台附件命令），节点只存 `hash`：
  - Excalidraw JSON（`application/json`）
  - 导出的 PNG 缩略图（`image/png`）
  - AI 生成图（`image/png` / `image/jpeg`）
- 收益：跨页面**去重**、进现有同步 / 备份 / 清理通道、随空间导出。
- 双平台：web 壳（`web.ts`）与 Tauri 复用同一批附件命令，**前端即可跑通**，无需新增 Rust 命令。

### 4.2 Lexical 节点
- 新增 `DrawingNode`、`MermaidNode`（`DecoratorNode`），实现 `exportJSON` / `importJSON` 进出页面 `content_json`；`serialized` 存引用 + 源文本。
- `DrawingNode` 额外带**图片说明 `caption`**（用户可编辑，见 4.5），随节点序列化进出 `content_json`，并为在只读内嵌块里的视图记忆存 `zoom/scrollX/scrollY` 与 `height`。
- 新节点注册进 `Editor.tsx` 的节点表、`markdownTransformers`（可选：mermaid 以代码块形式导出）、`htmlToLexical`（可选导入）。

### 4.3 搜索 / 反链 / 关系图
- 这些基于 `content_text`：绘图块**抽取 Excalidraw 文字元素**进 `content_text`（让「图里的字」可搜到）；mermaid 把 `src` 文字注入 `content_text`。属于加分项、非必须。
- `DrawingNode.getTextContent()` 返回**场景文字 + 用户图片说明 `caption`**，二者都进 `content_text`，说明文字同样可搜索/进反链。

### 4.4 依赖 / 打包
- `@excalidraw/excalidraw` 与 `mermaid` 均为 MIT、纯前端可离线打包；体积较大，按需动态 import（如进入编辑态 / 渲染 mermaid 时才加载），避免拖大首屏 chunk。

### 4.5 图片说明（caption）——已实现
为让「图下方配一句说明文字」成为**绘图块自己的字段**（随块移动/保存、可搜索），而非绘图块下方的独立段落：

- **节点**：`DrawingNode` 增加 `__caption: string | null`，经 `exportJSON`/`importJSON` 序列化进出 `content_json`，`setDrawing({caption})` 可写；`getTextContent()` 返回**场景文字 + caption**，二者并入 `content_text`（搜索/反链可见）。
- **展示**：`InlineDrawing` 在绘图块底部渲染一个**可编辑说明区 `.inline-drawing-caption`**——`contentEditable`、占位符「添加图片说明…」（`:empty::before`）、`Enter` 失焦、输入**防抖写节点**、失焦 flush。**平时 `display:none`**（不占底部空白行），**悬停绘图块或聚焦时水平居中显示**（`text-align:center` + 外边距居中）。
- **保存**：说明随节点走页面 `content_json`，刷新/重开保留；全屏编辑保存后内嵌块**自动适配整幅图**（清空视图记忆），说明区仍在块底部。
- **布局**：内嵌画布在「适配内容」后**按内容贴合高度**（内容高 × 适配缩放 + 内边距，钳制 MIN/MAX），小图不再留大片底部空白；并保留底部拖拽手柄手动调高（160–4000px）。

## 5. 验收 / 里程碑

建议**分三块里程碑**交付（每块独立升版本 / 提交 / 标记路线图）：

- [x] **M-A 绘图块（Excalidraw）**：`/绘图` 插入、全屏编辑、PNG 预览、JSON+PNG 附件落库、反链/搜索文字抽取；`tsc`/`build` 通过。**已追加**：图片说明 `caption`（可编辑、随块保存、可搜索、默认隐藏/悬停居中）、内嵌块贴合内容高度、全屏保存后自动适配整幅图、保存不再卡「保存中…」。
- [ ] **M-B mermaid 块**：`/mermaid` 输入 + syntax 选择、离线 SVG 渲染、解析失败容错、源文本编辑；`tsc`/`build` 通过。
- [ ] **M-C AI 文生图**：`/AI 绘图` 调 provider → 附件落库 → 插入 `ImageNode`；provider 失败降级；`tsc`/`build` 通过。
- [ ] `scripts/smoke-web.mjs` 新增**纯函数**断言（Excalidraw 文字抽取、mermaid syntax 检测、附件引用校验）且原断言无回归；`tsc`/`vite build`/`cargo check` 通过。

## 6. 相关文档

- [本地优先方案](./2026-08-15-local-first-note-app-plan.md)
- [AI 薄 Agent 方案](./2026-08-24-thin-agent-interface-plan.md)
- [路线图](../roadmap.md)
