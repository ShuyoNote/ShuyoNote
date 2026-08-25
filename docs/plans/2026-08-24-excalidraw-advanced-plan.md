# 「Excalidraw 绘图高级功能」方案（M23）

> 目标版本：v1.60.x（提议）。依赖：[绘图方案](./2026-08-24-drawing-solution-design.md)（绘图块已内嵌 **Excalidraw 0.17.1**，v1.59.128）。
> 状态：**规划（建议）**。挖掘 Excalidraw 0.17.1 的高级能力，规划如何把它们接入 ShuyoNote。能力盘点基于对已安装包的实际 API 检查（非印象）。

## 1. 背景与目标

- 绘图块已从自研 `DrawCanvas` 切换到 **Excalidraw 0.17.1**（React 19 兼容，v1.59.128），手绘/文字/形状/箭头/图片/导出等原生能力已可用。
- 目标：在此基础上，把 Excalidraw 的**进阶能力**接入 ShuyoNote，让它成为「**可编程、可搜索、可导航、可导出、可联动 AI**」的白板，而非孤立的绘图。

## 2. Excalidraw 0.17.1 能力盘点（实测 API）

| 能力 | 依据（export / prop） | 说明 |
|------|----------------------|------|
| 命令式 API | `excalidrawAPI`：`updateScene`/`getSceneElements(IncludingDeleted)`/`getFiles`/`addFiles`/`scrollToContent`/`refresh`/`setToast`/`onChange`/`onPointerDown` | 程序化读改场景、滚到内容、加文件 |
| 元素编程化 | `convertToExcalidrawElements` / `newElementWith` / `mutateElement` / `bumpVersion` | 把外部数据转成元素、改元素做一键排版 |
| 编辑动作 | actions：对齐/分布/翻转/分组/层叠(z-index)/复制/粘贴/文本绑定/链接 等（几十个） | 程序化排版与组织 |
| 只读查看 | `viewModeEnabled` | 只读嵌入（反链/wik/预览） |
| 自定义 UI | `Sidebar` / `DefaultSidebar` / `MainMenu` / `Button` / `WelcomeScreen` / `Footer` / `UIOptions` / `renderCustomUI` / `onPointerDown` | 自定义侧栏、菜单、覆盖层、命中外扩 |
| 坐标/命中 | `sceneCoordsToViewportCoords` / `viewportCoordsToSceneCoords` / `getCommonBounds` / `elementsOverlappingBBox` / `isElementInsideBBox` | 命中检测、元素级跳转 |
| 数据 | `serializeAsJSON` / `loadFromBlob` / `loadSceneOrLibraryFromBlob` / `getSceneVersion` / 库(`useHandleLibrary`/`mergeLibraryItems`/`serializeLibraryAsJSON`) | 场景 JSON / 导入 / 元素库 |
| 导出 | `exportToBlob` / `exportToSvg` / `exportToCanvas` / `exportToClipboard` | PNG/SVG/Canvas/剪贴板 |
| 结构 | Frames（`frame` 工具 + `frameRendering`/`frameToHighlight`） | 大图 **frame 分区** |
| 常量/国际化 | `THEME` / `FONT_FAMILY` / `MIME_TYPES` / `useI18n` / `languages` / `defaultLang` | 主题/字体/多语言 |
| **不在 0.17.1** | `DiagramToCodePlugin` / `TTDDialog`（0.18+）；真正多人协同需 WebSocket 后端（`onCollaboration` 钩子缺失，仅有 `LiveCollaborationTrigger`/`isCollaborating`） | 代码生成、实时协同超出本版本 |

## 3. 集成方案 / 里程碑

> 按「价值 ÷ 工程量」排序，建议**分四期**。每期：验证（smoke + tsc + build + 无头浏览器）、升版本、提交、路线图标记。

### M23.1 编辑/导出体验增强（低工程量，直接可用）
- **只读嵌入**：页面内可嵌**只读绘图预览**（`viewModeEnabled`），用于反链/引用/文档。
- **导出增强**：绘图块菜单加「导出 SVG / PNG / 复制到剪贴板」（`exportToSvg`/`exportToBlob`/`exportToClipboard`）。
- **自定义菜单/UI**：用 `MainMenu`/`UIOptions` 收敛默认项，加「AI 生成」「另存 SVG」「链接到页面（白板节点→页）」入口。
- **Frames 分区引导**：提示大图用 frame 分区（原生能力，仅做入口/引导）。

### M23.2 元素编程化 + AI / mermaid 联动（高价值）
- **AI 文生图注入画布**：`/AI 绘图` → 文生图 → `excalidrawAPI.addFiles`（图片元素）+ `updateScene` 注入。
- **mermaid → Excalidraw 元素**：把 mermaid 渲染为图片元素注入，或 `convertToExcalidrawElements` 转成元素数组（可选中/再编辑）。
- **外部数据导入**：`loadSceneOrLibraryFromBlob` / `.excalidraw` 导入、`convertToExcalidrawElements` 从数据建元素。
- **一键排版**：`newElementWith`/`mutateElement` + actions（对齐/分布/分组）做自动化排版。

### M23.3 自定义侧栏 + 白板导航（差异化）
- **属性侧栏**：`Sidebar`/`DefaultSidebar` —— 选中元素显示名称/颜色/尺寸，并可**链接到 ShuyoNote 页面/标签**。
- **画布节点 → 页面跳转**：`onPointerDown` + `elementsOverlappingBBox`/坐标转换 做命中检测，把绘图里的「节点」变成**页面锚点**（白板=导航，呼应「织网」）。

### M23.4 数据/检索集成
- `.excalidraw` JSON 落**内容寻址附件** + 每页**版本快照**（已有 `page_versions`）。
- 文字元素进 `content_text`（已做）；**元素级命中**（`elementsOverlappingBBox`）用于元素级搜索/定位。
- **框架分区导出**：导出按 frame 分别导出/生成目录。

### M23.5 协同（诚实：需后端，暂缓）
- 0.17.1 有 `LiveCollaborationTrigger`/`isCollaborating`，但真正多人实时需 WebSocket 同步服务，ShuyoNote 画布**无此服务**。**列为后续/需服务器**；先用「分享 `.excalidraw` 文件 / 导入 / 只读嵌入」替代，不阻塞。

## 4. 验收

- M23.1–M23.4 各期：无头浏览器验证（挂载/功能/保存→预览）+ `scripts/smoke-web.mjs` 新增相关纯函数断言且原断言无回归。
- `tsc` / `vite build` / `cargo check` 通过；每期升版本 + 提交 + 路线图标记。

## 5. 相关文档 + 取舍

- [绘图方案](./2026-08-24-drawing-solution-design.md)（Excalidraw 0.17.1 基底）
- [路线图 M22](../roadmap.md)
- 取舍（诚实标注）：① **代码生成（图→代码）与真正多人协同**不在 0.17.1 范围（代码生成需 0.18+；协同需 WebSocket 后端）——暂列为后续；② 自定义侧栏/白板导航（M23.3）工程量中等但最能体现「白板≠孤岛」差异化；③ 元素库/导入导出为常态化数据能力。
