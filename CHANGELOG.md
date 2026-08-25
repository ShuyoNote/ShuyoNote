# Changelog

本文件记录 ShuyoNote 的版本变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 与语义化版本。

## [1.59.135] - 2026-08-24

### 新增 / 变更

- **绘图「画板化」改进**：Excalidraw 编辑器新增**点阵网格背景**（`gridModeEnabled`）、**「＋」折叠菜单**（主题跟随系统/浅色/深色 + Mermaid 绘图）、标题改为「画板」、只读切换移入顶部、图标按钮分组。**移除 PlantUML**（需联网端点且触发依赖优化问题）；Mermaid / AI 插图 / 图片注入 / 导出 / 只读保留。`scripts/smoke-web.mjs` 225→**223 全绿**（移除 PlantUML 断言）。
> ⚠️ 已知：**`dev:web`（浏览器开发）下 Excalidraw 0.17.1 的 UMD 包在 Vite 8 依赖预打包时触发 `css-loader` 运行时兼容错误**（与 PlantUML 无关，生产构建 `vite build` 正常）。桌面/Tauri 生产构建不受影响；如遇 dev:web 绘图报错，可用生产构建验证，或调研 Vite 8 + Excalidraw 打包兼容（Vite 7 改触 Excalidraw 嵌套 React 问题）。

---

## [1.59.134] - 2026-08-24

### 修复

- **加载已有绘图报错**：`读取绘图失败：TypeError: items.reduce is not a function`。根因：Excalidraw 0.17.1 的 `restore` 签名是 `restore(data, localAppState, localElements)`（第一参数是**整个场景对象** `{elements, appState, files}`），而代码误传 `(elements, appState, files)`，把数组当成了 `data`。已改为 `restore({ elements, appState, files }, null, null)`，现在**打开已保存的绘图（其 `.excalidraw` JSON）能正常载入**。`scripts/smoke-web.mjs` 223 全绿。

---

## [1.59.133] - 2026-08-24

### 美化

- **绘图界面重设计**：Excalidraw 编辑器顶栏改为**分组图标按钮**（插入/AI/流程/链接 | 导出/复制/只读 | 保存/取消），**保存**用强调色主按钮、「取消」用幽灵按钮；顶部标题带「EXCALIDRAW」强调色小胶囊；Excalidraw **跟随 App 深/浅主题**（`theme` 按 `data-theme` 切换，画布与内部 UI 同步变色）。已用无头浏览器分别在**浅色/深色**下截图验证。

---

## [1.59.132] - 2026-08-24

### 新增

- **数据/检索集成（M23.4）**：把绘图文字抽取收敛为可测纯函数 `excalidrawSceneText`/`excalidrawSceneHasContent`（→ `content_text`，供搜索/反链）；`.excalidraw` JSON 内容寻址 + 版本快照沿用原链路；元素级命中归于 M23.3。`scripts/smoke-web.mjs` 221→**223 全绿**。

---

## [1.59.131] - 2026-08-24

### 新增

- **白板导航（M23.3）**：绘图编辑器新增「🔗 链接」——选中图形后链接到任意页面（元素 `link` 存 `shuyonote://page/<id>`）；**只读模式**下点击带链接的图形即**应用内跳转**到该页面（`onPointerDown` 命中检测 + `openPage`）。白板节点→页面，让画布成为织网导航的一部分。`scripts/smoke-web.mjs` 221 全绿（不变）。

---

## [1.59.130] - 2026-08-24

### 新增

- **元素编程化 + AI/mermaid 注入画布（M23.2）**：绘图编辑器新增「🖼 图片 / 🤖 AI 插图 / 📊 mermaid 流程」按钮，用 `excalidrawAPI.addFiles` + `updateScene` 把**图片/AI 文生图/mermaid 流程图渲染为画布图元**，可选中再编辑；`makeImageEl` 构造合法 Excalidraw image 元素，走内容寻址。AI 未配置时 toast 降级；无头浏览器验证「📊 图 → 输入 → 生成」全链路无报错。

---

## [1.59.129] - 2026-08-24

### 新增

- **绘图导出/只读（M23.1）**：Excalidraw 编辑器新增工具栏——**导出 SVG / PNG / 复制到剪贴板**（`exportToSvg`/`exportToBlob`/`exportToClipboard`），以及**只读⇄编辑切换**（`viewModeEnabled`，预览不改）；`UIOptions` 收敛默认导出菜单，统一走 ShuyoNote 入口。`scripts/smoke-web.mjs` 221 全绿（不变）。

---

## [1.59.128] - 2026-08-24

### 重构

- **绘图块改用 Excalidraw（React 19 兼容版 0.17.1）**：找到了 React 19 可用版本——**Excalidraw 0.18.1** 触发 `Maximum update depth` 无限循环；**0.17.1**（`patch` 稳定版）在 React 19 下正常渲染，已用无头浏览器验证（挂载/工具栏/保存→块内 PNG 预览，全程无报错）。`DrawingEditorModal` 改为内嵌 Excalidraw，绘制内容以 **`.excalidraw` JSON**（`serializeAsJSON`）+ **PNG 预览**（`exportToBlob`）落内容寻址附件；文字元素抽取进 `content_text`（`init` `restore` 载入旧场景可再编辑）。移除自研 `DrawCanvas` 与 `scene.ts`（其高级能力由 Excalidraw 原生文字/形状/图片/导出等替代）。`scripts/smoke-web.mjs` 227→**221 全绿**。

---

## [1.59.127] - 2026-08-24

### 新增

- **绘图高级功能（M22.1 进阶）**：`DrawCanvas` 重构为「矢量形状 + 图层 + 视口」模型（世界坐标 + `ctx.setTransform` 映射，任意缩放/平移下鼠标与落笔严格对齐）：
  - **文字标注**（点画布输入文字）＋ **更多形状**（三角形/菱形/五角星/星形，+原有 线/矩形/椭圆/箭头）；
  - **无限画布**：`✋` 拖动平移 + 滚轮/按钮缩放 + `⤢` 适应内容；
  - **图层系统**：新增/上移/下移/显示隐藏/删除图层（预览块快照不变，仍导 PNG 落内容寻址附件）；
  - **插入图片**（选文件 → 走附件）＋ **AI 插图**（文生图）/ **mermaid 流程图**（渲染为画布图元）；
  - **矢量导出 SVG**（`sceneToSvg`）。新增纯函数模块 `src/lib/scene.ts`（`emptyScene`/`sceneToSvg`/`fitView`/`normRect`/`polygonPoints`/`shapeBounds`/`sceneBounds`）。`scripts/smoke-web.mjs` 221→**227 全绿**。

---

## [1.59.126] - 2026-08-24

### 修复

- **绘图全屏鼠标定位不准**：`DrawCanvas` 原以固定 960×540 画布缓冲 + CSS 拉伸铺满全屏，导致 `clientX - rect.left`（CSS 像素）与实际绘制坐标（缓冲像素）错位。改为将画布缓冲**大小设为实际显示尺寸**、笔迹以**归一化坐标（0..1）**存储再映射到缓冲，指针与落笔 1:1 对齐；已有绘图作为底图在下一次重绘时保留，不丢失。已用无头浏览器在「目标点落笔 → 读取该点像素」验证命中，无报错。

---

## [1.59.125] - 2026-08-24

### 修复 / 重构

- **绘图块引擎改用无依赖 HTML5 Canvas（M22.1 重构）**：Excalidraw 0.18 内置的 Radix Portal 在 React 19 下触发 `Maximum update depth` 无限循环（已复现确认），故弃用。改为自研 `DrawCanvas`（自由手绘 + 线条/矩形/椭圆/箭头 + 橡皮 + 颜色/粗细 + 撤销/重做/清空），零外部依赖、离线、无 Portal 兼容问题；画布导出 PNG 存内容寻址附件，块内仍用 `MediaResolver` 预览。移除 `@excalidraw/excalidraw` 依赖与相关纯函数。无头浏览器验证「`/绘图` → 画布绘制 → 保存 → 块内预览」全链路无报错。`scripts/smoke-web.mjs` 225→**221 全绿**（移除 Excalidraw 相关断言）。

---

## [1.59.124] - 2026-08-24

### 新增

- **AI 文生图（M22.3）**：斜杠 `/AI 绘图` 输入画面描述 → 调用已配置的 OpenAI 兼容文生图端点（`/images/generations`，沿用 AI 设置）→ 图片存为内容寻址附件 → 插入 `ImageNode`；provider 未启用/不支持/请求失败时 toast 降级，不阻塞正文。新增纯函数 `buildImageGenUrl`/`buildImageGenBody`/`parseImageGenResponse`/`b64ToBytes`/`bytesToDataUrl`。`scripts/smoke-web.mjs` 220→**225 全绿**。

---

## [1.59.123] - 2026-08-24

### 新增

- **mermaid 块（M22.2）**：斜杠 `/流程图/思维导图` 插入 mermaid 块，选择 syntax（flowchart/sequence/class/state/er/mindmap/timeline/kanban/gantt/pie），离线渲染 SVG（无 CDN）；解析失败内联报错 + 可编辑源文本，绝不崩；源文本进 `content_text`（可搜）。新增 `MermaidNode`、纯函数 `detectMermaidSyntax`/`mermaidRenderable`/`mermaidSyntaxOptions`；mermaid 按需懒加载（独立 chunk）。`scripts/smoke-web.mjs` 216→**220 全绿**。

---

## [1.59.122] - 2026-08-24

### 新增

- **绘图块（M22.1，Excalidraw）**：斜杠 `/绘图` 插入绘图块，点击打开全屏 Excalidraw 编辑器（笔/橡皮/形状/箭头/文字/便签）；保存时把场景 JSON + 导出 PNG 落为内容寻址附件（节点只存 `hash` 引用，幂等去重）；文字元素抽取进 `content_text`（可搜/进反链）。新增 `DrawingNode`、`DrawingEditorModal`、纯函数 `excalidrawText`/`drawingTextFromJson`/`drawingHasContent`；Excalidraw 按需懒加载（独立大 chunk，不拖大首屏）。`scripts/smoke-web.mjs` 212→**216 全绿**。

---

## [1.59.121] - 2026-08-24

### 新增

- **关系图探索增强（M21.2）**：关系图新增**关键词高亮**（输入关键词高亮匹配节点、弱化其余）、**聚类聚拢**（按标签/属性维度的同类节点互相拉近成簇）、**节点锁定**（双击节点或锁按钮 📌 固定，不再随力导向移动）；保留按维度着色/过滤、点击跳转、局部缩放。

---

## [1.59.120] - 2026-08-24

### 新增

- **静态 wiki 导出（M21.1）**：命令面板新增「导出当前空间为 wiki」，把当前空间导出为可独立浏览的静态 HTML wiki——每页一个 `.html`（`[[标题]]` 双链渲染为可点击链接 + 反向链接区 + 标签），并生成含页面树的 `index.html`，整体打包为 `wiki-export.zip`，可投喂任意静态托管（GitHub Pages / file://）。纯函数 `buildWikiExport`/`wikiSlug`/`renderWikiBody`。`scripts/smoke-web.mjs` 207→**212 全绿**。

---

## [1.59.119] - 2026-08-24

### 新增

- **语义检索接入 AI（M20.3）**：侧边栏 AI 的 `search_pages` 工具描述新增「语义相近」提示，检索结果经 M20.2 语义排序后供模型引用，「问知识库」能命中意思相关的内容（`search_pages` → `api.search` → 语义重排）。

---

## [1.59.118] - 2026-08-24

### 新增

- **语义检索（M20.2）**：搜索在原有词频（TF）匹配基础上，新增基于字符二元组（char-bigram）Jaccard 的语义排序，优先展示语义更贴近的页面；纯函数 `charBigrams`/`semanticScore`/`semanticRank`，语义作为 TF 之上的有界加分，不改变「命中次数多者优先」的主排序。`scripts/smoke-web.mjs` 204→**207 全绿**。

---

## [1.59.117] - 2026-08-24

### 新增

- **内联 AI 起草「创建新页面并插入内容」动作（M18 二期）**：草案动作菜单新增「**新建页**」，一键把当前草案建为新页面并插入内容。

---

## [1.59.116] - 2026-08-24

### 新增

- **链接建议增强（M19.3）**：输入 `[[` 弹出按匹配度 + 最近编辑排序的页面候选下拉（`PageLinkSuggestPlugin`），Enter/方向键/点击选择并插入 `[[标题]]`；新增纯函数 `suggestPageLinks`。`scripts/smoke-web.mjs` 203→**204 全绿**。

---

## [1.59.115] - 2026-08-24

### 新增

- **模板变量（M20.1）**：新增 `substituteTemplateVars` 纯函数，模板建页时把 `{{date}}`/`{{title}}`/`{{selected}}` 替换为创建时上下文（日期/模板名/选中文本）。`scripts/smoke-web.mjs` 202→**203 全绿**。

---

## [1.59.114] - 2026-08-24

### 新增

- **双链别名 + 精确块链反链识别（M19.2 识别层）**：`get_backlinks` 现能识别 `[[标题|别名]]`、`[[标题#块]]`（含 `[[标题|别名#块]]`），这些形式同样形成页面反链（可交互渲染/跳转作为后续项）。`scripts/smoke-web.mjs` 200→**202 全绿**。

---

## [1.59.113] - 2026-08-24

### 新增

- **未链接提及（M19.1）**：页面底部（反链区）新增「未链接提及」——扫描当前页正文里以纯文本出现、未打 `[[ ]]` 的其它页面标题，显示「改为链接」按钮，点击即把该处文字包成 `[[标题]]`（复用现有双链解析，形成页面反链）。新增 `src/lib/mention.ts`（纯函数）、`src/components/UnlinkedMentionsPanel.tsx`、相关样式；`scripts/smoke-web.mjs` 198→**200 全绿**（新增两条断言）。

---

## [1.59.112] - 2026-08-24

### 新增

- **补充 M19–M21 方案文档**：新增 `docs/plans/2026-08-24-wiki-weave-plan.md`（Wiki 织网增强）、`2026-08-24-template-var-semantic-search-plan.md`（模板变量 + 语义检索）、`2026-08-24-static-wiki-export-graph-plan.md`（静态 wiki 导出 + 关系图探索），并在 `docs/README.md` 索引、`docs/roadmap.md` 里程碑头加上方案链接。

---

## [1.59.111] - 2026-08-24

### 新增

- **路线图补充「值得做」里程碑**：`docs/roadmap.md` 新增 **M19 Wiki 织网增强**（未链接提及 / 双链别名 / 精确块链）、**M20 模板变量 + 语义检索（RAG）**、**M21 静态 wiki 导出 + 关系图探索**，并加入优先级表与竞品差距跟踪；根 `README.md` 路线图引用同步更新。

---

## [1.59.110] - 2026-08-24

### 修改

- **更新整理文档体系**：根 `README.md` 补充「**AI 助手（薄 Agent + 内联起草）**」特性块、路线图 **M17（已达成）/ M18（规划中）**、文档体系索引（登记 `docs/development.md` 开发指南与 `docs/plans/2026-08-24-inline-ai-draft-plan.md`、项目结构补 `src/lib/ai/`），并同步版本徽章。

---

## [1.59.109] - 2026-08-24

### 修复

- **内联 AI 插入位置不准确**：之前「完成」把内容追加到页面末尾。现改为记录**按空格所在的块**（`aiBarAnchorKey`），「完成」时把内容**插入到该块之后**（若该块已不存在则回退到末尾）。

---

## [1.59.108] - 2026-08-24

### 修改

- **填入提示词后光标定位到省略号**：选中「用 AI 写作」下拉项，提示词填入输入框后会自动聚焦并把**光标放到 "…" 之后**，方便用户接着输入主题/要求。

---

## [1.59.107] - 2026-08-24

### 修改

- **选中「用 AI 写作」下拉项改为"填入合适提示词"**：不再立即发送，而是把对应动作的提示词（如"帮我写一篇小红书种草笔记，内容主题/要求是…"）填入输入框，由用户按需补充后再发送。创作类提示词统一成"…主题/要求是…"自然句式，并新增「小红书种草笔记」。

---

## [1.59.106] - 2026-08-24

### 修改

- **选中「用 AI 写作」下拉项即立即执行**：不再回填输入框等待发送，点选即调用对应动作（总结/翻译/润色/纠错/续写/创作等）。

---

## [1.59.105] - 2026-08-24

### 修复

- **编辑类动作（总结/翻译/润色/纠错/续写）模型看不到当前页内容**：之前内联起草的仅内容提示不含页面正文，模型未用 `read_page` 时误答"当前页面内容为空"。现在**发起编辑类动作时把当前页正文（最多 6000 字）随提示传给模型**，模型据此总结/翻译/润色/纠错。

---

## [1.59.104] - 2026-08-24

### 修复

- **「用 AI 写作」下拉上下文误判**：之前用 `children 数量>0` 判断有无内容，空页的占位空段落也计为"有内容"，导致总显示编辑类。改为**检测真实文本**（递归找非空 text 节点 / `content_text` 非空），空页才显示创作类。

---

## [1.59.103] - 2026-08-24

### 修改

- **「用 AI 写作」下拉按当前页上下文自适应**：页面**有内容**时显示编辑类动作（续写 / 根据页面内容生成：总结·翻译 / 编辑页面内容：文本润色·智能纠错）；页面**为空**时显示内容创作类（文章大纲 / 短篇故事 / 文章 / 会议纪要 / 待办清单）。

---

## [1.59.102] - 2026-08-24

### 修改

- **内联 AI 弹窗可用 ESC 取消**：无论是否在生成，只要弹窗打开，按 **ESC** 即**取消并关闭**（若正在创作则先停止再关闭）。

---

## [1.59.101] - 2026-08-24

### 修改

- **内联 AI「用 AI 写作」下拉改为分组菜单**（对齐 wolai/Notion 参考）：顶部「续写」，分组「根据页面内容生成」（总结 / 翻译）、「编辑页面内容」（文本润色 / 智能纠错）；分组标题作为小标题，下拉可滚动（`max-height: 260px`）。

---

## [1.59.100] - 2026-08-24

### 修复

- **内联 AI 弹层内容多了仍看不全**：之前翻转/高度按固定 360px 估算，内容变多时偏差导致弹层超出视口。现改为**渲染后实测并钳制**——弹层出现后测量自身尺寸，若超出视口则自动把 `top`/`left` 收进视口（上翻或左移），并在流式创作时**自动滚动到底部**显示最新内容，保证始终完整可见。

---

## [1.59.99] - 2026-08-24

### 修改

- **内联 AI 弹层改用小圆角**：`.ai-inline-pop` 及其内部（起草条/模板下拉/草案卡）的 `border-radius` 由 `--radius` 统一改为 `--radius-sm`（6px）。

---

## [1.59.98] - 2026-08-24

### 修复

- **内联 AI 弹层在页面底部被截断**：之前弹层固定出现在光标下方，页面滚动到底时光标靠下会超出视口。现改为：**下方空间不足（<340px）时自动翻转到光标上方**，并水平钳制在视口内；弹层自身 `max-height: 70vh; overflow-y: auto`，内容超高时内部滚动，保证完整可见。

---

## [1.59.97] - 2026-08-24

### 修改

- **内联 AI 默认展开「用 AI 起草」下拉**：浮动弹层出现时默认打开模板下拉（文章大纲/内容简介/社交/邮件/广告/短篇故事），无需先点模型按钮。

---

## [1.59.96] - 2026-08-24

### 修改

- **内联 AI 弹层加宽**：浮动弹层宽度由固定 360–480px 改为与**页面区一致**（`--doc-width`，780px），并钳制到视口（`max-width: calc(100vw - 24px)`），避免超出屏幕。

---

## [1.59.95] - 2026-08-24

### 修复

- **内联 AI 起草把"不该有的内容"也插入页面**：之前「完成」会把模型整段回复（含"草稿已生成…""确认无误的话…"开场/结尾说明、`**`粗体、`---` 分隔线等元信息）原样插入页面。现为内联起草使用**仅内容**的系统提示（只输出内容本身，不要开场白/结尾说明/markdown 标记、不要声称已保存），并在「完成」时用 `cleanDraftText` 清理残留（去 markdown 标记与纯分隔线）。`scripts/smoke-web.mjs` 197→**198 全绿**（新增 `cleanDraftText` 用例）。

---

## [1.59.94] - 2026-08-24

### 修改

- **内联 AI 起草条改为"随光标走 + 背景关闭"的浮动弹层**：`InlineAiDraftBar` 由「标题下方的固定行」改为 `position:fixed` **跟随光标**的浮层（在空行按空格时锚定到光标位置），支持 **点击背景即关闭**（`mousedown` 在浮层外则关闭）、Esc 关闭；`useEditorStore` 增加 `aiBarPos` 保存锚点坐标。
- **空格触发可靠性修复**：`AiSpaceTriggerPlugin` 不再在挂载时取 `getRootElement()`（此时可能为 null 导致监听器从未挂上），改为**在 keydown 时实时取根元素**，并始终挂 `document` 捕获监听，避免"调不出"。

---

## [1.59.93] - 2026-08-24

### 修复

- **「空格打开 AI」仍失效**：`KEY_DOWN_COMMAND` 路由对单独的空格键在该编辑器里不可靠；改为 **`document` 捕获阶段**监听 `keydown`（先于事件到达编辑器），且仅当目标在编辑器根元素内、且当前为**空行**时才拦截并打开 AI。保留临时诊断 `[ShuyoNote-debug] space in editor; blank=…`，用于确认触发路径与空行判定是否命中。

---

## [1.59.92] - 2026-08-24

### 修复

- **「空格打开 AI」失效**：`AiSpaceTriggerPlugin` 之前加 `e.isComposing` 拦截空格——中文输入法（拼音/搜狗）激活时，即使空行按空格也可能被判为组合中（`isComposing`），导致触发被跳过。移除该拦截：改用「**空行判定**（该块无文字）作为唯一安全闸」——空行按空格才打开 AI（此时并无文字可被 IME 上屏，不会打断输入）；有文字的行（含打了一半的拼音候选）绝不触发，正常打字不受影响。

---

## [1.59.91] - 2026-08-24

### 修改

- **去掉空白页噪音日志**：页面内容为空（正常新建的空白页）不再打印 `[ShuyoNote] 页面无 content_json(空内容)。`；仅当内容确实无法解析时才输出诊断（`页面内容不可用…`），空白页静默按空编辑器处理。

---

## [1.59.90] - 2026-08-24

### 修改

- **去掉「✦ 用 AI 起草」按钮**：内联 AI 起草改为仅由**空块按空格**触发（`AiSpaceTriggerPlugin`，与占位文案一致），移除常驻的「用 AI 起草」胶囊入口及其样式；并让 `aiBarOpen` 在编辑器卸载（切页）时自动复位，避免起草条残留在新页。

---

## [1.59.89] - 2026-08-24

### 修改

- **新建页面默认名称「新页面」**：无标题创建页面时，默认标题由「未命名」改为「新页面」；web 平台 `web.ts` 与桌面后端 `commands.rs` 同步（文件夹/数据库仍为「新建文件夹/新建数据库」）。`scripts/smoke-web.mjs` 196→**197 全绿**（新增默认标题断言）。

---

## [1.59.88] - 2026-08-24

### 新增

- **编辑器占位文案 + 「空格打开 AI」触发**：正文占位符改为「输入 '/' 选择，按 '空格' 打开 AI...」；新增 `AiSpaceTriggerPlugin`——在**空块**上按空格即打开内联 AI 起草条（`e.isComposing` 时忽略，避免打断中文输入法确认；仅在空段落触发，不影响正常打字），并聚焦起草条输入框。

---

## [1.59.87] - 2026-08-24

### 新增

- **内联 AI 起草（M18 最小闭环）**：页面向导新增「✦ 用 AI 起草」入口 → 唤起内联起草条（输入 + 模型 + 「用 AI 起草」模板下拉：文章大纲/内容简介/社交媒体帖子/电子邮件/广告文案/短篇故事）→ 发送后流式写入**高亮待定草案卡**（含「已深度思考」块 + 「AI 正在创作···」状态 + Esc 停止）→ 动作：**完成**（插入正文并自动保存）/ **续写** / **重新生成** / **关闭**（丢弃）。复用 `runAiLoop` 底座，写操作先落「待定草案」、点「完成」才落库。
- 新增 `src/lib/ai/inlineDraft.ts`（模板 + 运行/校验助手）、`src/components/InlineAiDraftBar.tsx` 及相关 CSS。
- `scripts/smoke-web.mjs` 保持 **196 全绿**；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.86] - 2026-08-24

### 新增

- **`docs/roadmap.md` 补 M18 里程碑**：新增「内联 AI 起草」里程碑（含 M18.1 内联起草条+模板下拉 / M18.2 流式写入+待定块高亮 / M18.3 生成后动作菜单 / M18.4 安全与验收，标注「规划，建议」），并在「下一阶段优先级」「竞品差距跟踪」各加一行，与 M17 薄 Agent 底座衔接。

---

## [1.59.85] - 2026-08-24

### 新增

- **落地「嵌入式 vs 侧边栏 AI 助手」职责划分**：在 [docs/plans/2026-08-24-inline-ai-draft-plan.md](docs/plans/2026-08-24-inline-ai-draft-plan.md) 新增「职责划分」章节（职责矩阵 / 边界规则 / 快速判断），明确两者共用薄 Agent 核心、但内联＝就地写、侧边栏＝全局问/做；`docs/README.md` 方案索引同步更新。

---

## [1.59.84] - 2026-08-24

### 新增

- **文档体系落地「内联 AI 起草」方案**：新增 [docs/plans/2026-08-24-inline-ai-draft-plan.md](docs/plans/2026-08-24-inline-ai-draft-plan.md) —— 把 AI 从「右侧聊天面板 + 二段确认」扩展为「内嵌文档流 + 流式写入 + 高亮待定块 + 动作菜单/快捷键」（对标 wolai/FlowUs/Notion AI），并给出 ShuyoNote 的安全折中（写操作先落「预览高亮待定块」、点「完成」才落库、不丢确认红线）；已登记进 `docs/README.md` 方案索引。

---

## [1.59.83] - 2026-08-24

### 修改

- **页面标题左对齐**：给 `.title-input` 显式加 `text-align: left`，确保页面标题始终靠左（与 wolai / FlowUs 对齐）。

---

## [1.59.82] - 2026-08-24

### 新增

- **落地文档体系**：新增 [docs/development.md](docs/development.md)（开发指南：技术栈与目录、运行、测试与验证权威循环、**版本号提升规则**、CHANGELOG 与文档约定、常见坑），根目录新增 `CONTRIBUTING.md` 作为贡献入口；`docs/README.md` 索引补充「目录结构」树与「工程开发」导航/章节，并把版本引用同步到 v1.59.82。

---

## [1.59.81] - 2026-08-24

### 修复

- **彻底修复 AI 写入产生空白页（根因）**：定位到 AI 内容生成器 `appendBlocksToJson`/`pageJsonFromText` 产出的 Lexical 文档，其 `root` 节点**缺少 `type:"root"`**（只有 `children`）。Lexical 解析要求 `root` 节点带 `type:"root"`，否则抛 `parseEditorState: type "undefined" + not found` → 整页回退空白。已修复：
  - `safeRoot`（`src/lib/ai/lexical.ts`）给 `root` 节点的类型加 `type:"root"` 与 `version`；
  - `pageJsonFromText` 的空文档默认值补上 `"type":"root","version":1`；
  - `lexicalStateValid`（`src/lib/lexicalValidate.ts`）在解析前**规范化 root**（缺失则补 `type:"root"`/`version`），让已存库的旧坏文档也能自动恢复，而非空白。
- `scripts/smoke-web.mjs` 195→**196 全绿**（新增：root 缺 `type:"root"` 自愈用例）；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.80] - 2026-08-24

### 修复

- **空白页定位到具体坏节点**：上次确认解析错误是 `type "undefined"`，但可见片段是合法段落——坏节点在被截断的更后面。现增加「扫描坏节点」诊断：整页/逐块均失败时，会在 Console 打印 `| offending node: …`（该节点 JSON 片段，含缺失/未注册 `type`），并放宽 content_json 片段到 600 字，便于一眼锁定罪魁节点。
- `scripts/smoke-web.mjs` 保持 **195 全绿**；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.79] - 2026-08-24

### 修改

- **目录面板默认关闭**：此前右侧「目录」抽屉默认展开（`toc: true`），进入应用即占据右侧空间。现改为默认关闭（`toc: false`），需要时点右缘 ☰ 按钮打开。

---

## [1.59.78] - 2026-08-24

### 修复

- **空白页定位到解析原因**：上次诊断确认该页 `content_json` 是「正常段落 + 文字」，但整页/逐块预解析都为空（此前错误被 `onError` 静默吞掉）。现将 Lexical 的预解析错误记录下来，并在「空白页」诊断里一并打印 `parse error: …`，用于精确判断是哪种 Lexical 解析异常导致回退为空。
- `scripts/smoke-web.mjs` 保持 **195 全绿**；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.77] - 2026-08-24

### 修复

- **空白页诊断**：页面内容为空或被判为不可用时，会在 Console 打印 `[ShuyoNote] 页面内容不可用/无 content_json/逐块兜底失败…`（含 content_json 长度与前 300 字片段），用于精确定位「该页确实没有保存内容」还是「内容被判定为损坏」。
- `scripts/smoke-web.mjs` 保持 **195 全绿**；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.76] - 2026-08-24

### 修复

- **彻底消除 Console 的 `type "undefined"` 报错（静默预解析）**：此前 `probeEditor` 未配置 `onError`，Lexical 在预解析碰到坏节点时会内部捕获并把错误路由到默认的 `console.error`（DevTools 显示为 `Error: parseEditorState: type "undefined" + not found`），导致每次打开损坏页都刷 Console。现给探针编辑器配置 `onError: () => {}`，预解析完全静默，不再刷 Console。
- **坏节点位置不止 `children`，还可能是 `$slots`**：Lexical 0.49 的 shadow-root 槽帧把节点放在节点的 `$slots` 对象里，之前净化器只遍历 `children`，会漏掉这类坏节点。现同时净化 `$slots`（缺 `type` / 未注册类型一并剔除）。
- **好内容按块兜底保留**：整页预解析若仍失败（个别块坏到净化器无法识别），会**逐顶层块**单独预解析，保留能解析的好块、丢弃坏块，页面不再整页空白。
- `scripts/smoke-web.mjs` 194→**195 全绿**（新增：`$slots` 坏节点剔除用例）；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.75] - 2026-08-24

### 新增

- **思考过程实时流式显示**：推理型模型（`deepseek-v4-flash` 等）的 `reasoning_content` 现在**边想边显示**到「已深度思考」块，而不是等整段思考结束才整个出现。为此把思考增量从 transport → host → store 一路透传（`onThinking`），并调整面板渲染：内容尚未产出时「思考」块也先展示，且随流式内容自动滚动到底部。

### 修改

- `llm.ts` 新增 `onThinking` 回调，流式读取 `reasoning_content` 时实时回调；`host`/`store` 逐层透传；面板运行中即显示思考块并自动滚到底。
- `scripts/smoke-web.mjs` 193→**194 全绿**（新增：`onThinking` 实时收到思考增量用例）；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.74] - 2026-08-24

### 修复

- **彻底移除 `type "undefined"` 报错并保留好内容**：此前净化器只拒绝「`type` 缺失」的节点，却放过了「`type` 为字符串 `"undefined"`」或其它**未注册类型**的节点——Lexical 无法解析它们，抛出 `type "undefined" + not found`（只降级为空、不崩，但会刷 Console 且丢失相邻好内容）。现净化器：① 丢弃 `type` 为字面 `"undefined"`/`"null"` 的节点；② 传入编辑器已知节点类型集合时，丢弃任何**不在注册表内**的 `type`。坏块被剔除、好内容保留，不再崩、Console 不再刷错误。
- **Editor.tsx** 依据 `EDITOR_NODES`（并补充 root/paragraph/text/linebreak/tab 等核心类型）构建允许类型集合，传给净化器。
- `scripts/smoke-web.mjs` 191→**193 全绿**（新增：字面 `"undefined"` 剔除、未注册类型剔除两个用例）；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.73] - 2026-08-24

### 修复

- **推理型模型（如 deepseek-v4-flash）「只思考不回答」**：根因是请求把 `max_tokens` 上限设为 **512**，而推理模型的 `reasoning_content` 会先消耗大量 token，导致在产出最终 `content` 前就被截断（`finish_reason=length`）——界面只见思考、无回答、也无报错。现将默认最大输出提升到 **8192**，给「思考 + 回答/工具调用」留足空间。
- **截断可识别**：当流在作答前以 `finish_reason=length` 结束，提示「模型输出达到长度上限（max_tokens）时被截断…」，而不是笼统的「未返回内容」。
- `scripts/smoke-web.mjs` 189→**191 全绿**（新增：`finish_reason=length` 截断报错用例）；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.72] - 2026-08-24

### 修复

- **AI 无回应时给出可视化诊断**：若模型端点返回了内容但无法被解析、或返回错误/空完成体，现在把**原始响应体**打印到 Console（`[ShuyoNote] AI 未返回内容，原始响应：…`），并在错误提示中带出**响应片段**——不再是无声空白，可直接判断是「工具定义不被支持 / 空 content / 错误对象」中的哪种。
- **流式不再无限挂起**：流读取增加 90 秒空闲超时；超时给出「AI 响应超时」提示并复位，避免一直卡在「停止」状态。
- `scripts/smoke-web.mjs` 保持 **189 全绿**；`tsc`/`vite build`/`cargo check` 均通过。

---

## [1.59.71] - 2026-08-24

### 修复

- **AI 助手「发送后无回应」**：Web 端直接 fetch 云端模型时，若端点忽略 `stream:true`、返回普通 JSON 完成体（或裸 NDJSON / 不带 `data:` 前缀的流），旧解析器只认 SSE `data:` 帧 → 内容为空 → 界面只见用户气泡、无 LLM 回应、也无报错。现改为**容错解析**：`extractFromJson` 同时读取增量 delta 与一条完整 message 的 `content`/`reasoning_content`/`tool_calls`；`readBodyStream` 处理末尾不带换行的单条 JSON，并识别 HTTP 200 但含 `error` 字段的返回（转为可读报错，不再是静默空白）。
- **空回应不再静默**：`run` 即便成功、若无回复且无待确认草稿，会提示「模型没有返回内容…」（据此可到设置里「测试连接」）。
- `scripts/smoke-web.mjs` 187→**189 全绿**（新增：非 SSE JSON 完成体、裸 NDJSON 帧两个用例）。

---

## [1.59.70] - 2026-08-24

### 修复

- **损坏页不再整页空白（自愈式解析）**：此前 `lexicalStateValid` 只要发现任一带缺失 `type` 的坏节点就拒绝**整篇**内容，使得一个「多数字段有效、仅个别块损坏」的页面打开为空白。现改为**净化**：递归遍历所有 `children`，只丢弃不带非空字符串 `type` 的元素，其余有效块全部保留并正常渲染；仅当无一可用、JSON 不可解析或无 `root` 时才回退空态。图片行 `items` 等非 `children` 数据数组不受影响。
- **可诊断**：页面内容被拒时打印 `[ShuyoNote] rejected content_json…` 标记与原始 JSON；应用启动时打印 `[ShuyoNote] bootstrap v…`，便于确认浏览器实际运行的构建版本。
- `scripts/smoke-web.mjs` 186→**187 全绿**（新增：净化「混入坏节点的文档保留好内容」、丢弃坏文本节点但保留父块两个用例）。

---

## [1.59.69] - 2026-08-24

### 修复

- **彻底拦截 `type "undefined"` 错误**：此前 `lexicalStateValid` 用「节点特征启发式」，漏掉「无 type 且无任何特征键」的坏对象，探针仍会解析它并让 Lexical 打 `type "undefined"` 日志。现改为**严格规则**：`root.children` 及其所有嵌套 `children` 的**每个元素必须是带字符串 type 的节点**（`validateNodes`），否则整页回退空态；探针不再跑到坏文档（不崩、也不再刷错误日志）。图片行 `items` 等非 `children` 数据数组不受影响。
- `scripts/smoke-web.mjs` 185→**186 全绿**（新增：拒绝「通用对象子节点」用例）。

---

## [1.59.68] - 2026-08-24

### 修复

- **AI 确认后无反应（追加到当前页）**：确认草稿后 `updateCurrent` 改了 `current.content_json`，但 Lexical 编辑器有自身状态、`initialConfig` 是空 deps 的 `useMemo`，不会重解析——当前页看不到追加内容。现给 notes store 加 `reloadTick`，编辑器 key 改为 `${pageId}:${reloadTick}`；AI 确认追加到当前页时 `bumpReload()`，强制编辑器重载并展示追加内容（正常手动编辑不会触发，不丢光标/撤销）。
- `tsc`/`vite build`/`cargo check` 均过；`scripts/smoke-web.mjs` 185 全绿。

---

## [1.59.67] - 2026-08-24

### 修复

- **点击回收站图标没反应**：回收站按钮在侧边栏最底部，`usePopover` 恒把弹层开在按钮**下方**（`rect.bottom+6`）→ 弹层落到视口外，看似无反应。现 `usePopover` 在按钮贴近视口底部时改为**向上弹**（`bottom` 锚定）；回收站弹层改为同时接受 `top`/`bottom`。

---

## [1.59.66] - 2026-08-24

### 优化

- **浏览器标签/窗口标题带版本号**：web 版运行后标签显示「ShuyoNote 数友笔记 · v{version}」（`main.tsx` 从 `package.json` 读版本设置 `document.title`，与桌面窗标题一致）；静态 `<title>` 改为「ShuyoNote 数友笔记」。

---

## [1.59.65] - 2026-08-24

### 修复

- **web 版刷新后删除失效**：`bootSpaces` 启动时总是用「空间快照」`store.restore()` 覆盖 live store，而页面增删改**不回写快照**（只在切空间/建空间/导入/恢复时写），导致刷新后从过期快照恢复、删除的页面/文件夹又出现。现改为：启动时若 **live store 已有数据**（IndexedDB 里就是最近一次活动空间的最新数据，删除已生效），则**保留它并刷新该空间快照**，不再用过期的 spaceStore 快照覆盖；仅当 live store 为空时才从快照恢复/播种。

---

## [1.59.64] - 2026-08-24

### 修复

- **消除控制台 `type "undefined"` 噪音**：崩溃（`editor state is empty`）在上一版已由 `state.isEmpty()` 兜底；本版再**在探针解析的极短窗口内静音 `console.error`**（Lexical 对坏节点是 console.error 而非抛异常），`finally` 恢复，彻底移除这条用户可见的错误日志。编辑器对坏页显示空页、无报错。

---

## [1.59.63] - 2026-08-24

### 修复

- **编辑器崩溃（根因确认）**：堆栈显示错误从**探针编辑器** `parseEditorState` 抛出——Lexical 解析到损坏节点时**不抛异常而是吞掉错误、打 log 并返回空 EditorState**；我把这个空状态又交给了真实 LexicalComposer，导致 `setEditorState: editor state is empty` 崩溃。现：
  - `Editor.parseEditorState` 在探针解析后**检查 `state.isEmpty()`**，空结果视为解析失败 → 返回 `null`，让 LexicalComposer 用安全的空编辑器态；
  - `lexicalValidate.treeValid` 增加**每个 `children` 元素必须带字符串 `type`**（children 必为节点；图片行 `items` 非 children 不受影响），在交给探针前就拒绝坏文档，避免 Lexical 的 `type "undefined"` 内部日志。
- `scripts/smoke-web.mjs` 185 全绿。

---

## [1.59.62] - 2026-08-24

### 修复

- **编辑器崩溃（根治方案）**：不再只靠启发式校验，改用**探针编辑器**——`Editor.tsx` 用与真实编辑相同的节点注册表 `createEditor` 建一个临时 editor，在把 `content_json` 交给 LexicalComposer 前**先 `probeEditor.parseEditorState` 试读一次**；任何解析异常（含 `type "undefined"`）都被捕获并**回退为空态**，绝不让真实编辑器崩。
- `parseEditorState` 现返回 `EditorState | null`；`lexicalStateValid` 保留为快速预检。

---

## [1.59.61] - 2026-08-24

### 修复

- **编辑器崩溃（二次）**：上一版防御校验只递归 `children`，漏掉**非 children 位置**的缺 `type` 节点，且会误拒图片行等「无 type 的纯数据项」。现改为**启发式校验**（`src/lib/lexicalValidate.ts`）：只把「有节点特征（version/children/text/format…）却无 `type`」的对象判为损坏并回退空态，纯数据项（如图片行 `items`）放行；`lexicalStateValid` 替换原校验。
- `scripts/smoke-web.mjs` 179→**183 项全绿**（新增：接受合法/图片行、拒绝缺 type 节点、拒绝空根）。

---

## [1.59.60] - 2026-08-24

### 修复

- **AI 窗口拖拽把手未对准边缘**：原先 hover 用 `outline` 环绕整条 8px 区域，视觉上不贴边。改为**左缘 1px 高亮线 + 居中小握把**（`::before`/`::after`），紧贴面板左缘（即内容分界线），拖拽更直观。

---

## [1.59.59] - 2026-08-24

### 修复

- **编辑器崩溃「parseEditorState: type "undefined"」**：某页面 `content_json` 里若含**缺 `type` 字段的节点**，Lexical 解析时 type 为 undefined 会直接崩溃（连带 `setEditorState: editor state is empty`）。`Editor.tsx` 的 `parseEditorState` 现**递归校验节点树**，遇到这类损坏节点即回退为空态而非崩溃。
- **AI 写页加固**：`create_page` 空内容也产出合法 `{"root":{"children":[]}}`（`tools.ts` `pageJsonFromText` / `apply.ts`），不再写入空字符串，避免潜在空态异常。

---

## [1.59.58] - 2026-08-24

### 新增

- **AI 助手窗口可拖拽调宽**：右抽屉左缘新增拖动条（`col-resize`），拖拽在 300–640px 间实时调整宽度；宽度存为 CSS 变量 `--ai-w` 并持久化到 localStorage（`shuyonote.ai.panelWidth`），内容让位 `.main` 同步跟随。

---

## [1.59.57] - 2026-08-24

### 新增

- **对话式界面（对齐 Wolai）**：AI 面板改为**聊天气泡**——`history` 里的用户/助手消息渲染成气泡（用户右侧 accent 底 / 助手左侧卡片），并支持流式中的实时用户/助手气泡。
- **「已深度思考」可折叠块**：采集模型推理（`reasoning_content`，非流式 + Web/桌面流式），在最新助手气泡下用 `<details>` 折叠展示。
- `llm.ts` 增加 `thinking`（Ollama `/api/chat`、OpenAI 兼容的 `message/delta.reasoning_content`）；`host.ts` 把 `thinking` 透出；`store` 记录 `thinking` 与流式中的 `currentPrompt`。
- `scripts/smoke-web.mjs` 178→**179 项全绿**（新增：流式采集 `reasoning_content`）。

---

## [1.59.56] - 2026-08-24

### 新增/样式

- **AI 助手面板对齐 Wolai 内容型布局**：头部改为「标题 + 副标题（基于当前空间你所有有权限的页面进行回答）」+ 设置/关闭；全宽欢迎卡；**编号建议卡（1./2./3.）+ 换一批**；底部「＋ 新会话 + 模型」栏；输入框右侧改为**发送图标**（运行中变停止图标）。
- 移除底部重复模型名（已移至脚栏）、废弃的 `.ai-chip`/`.ai-empty` 样式、右键悬浮 Sparkle/目录按钮。
- `tsc`/`vite build`/`cargo check` 均过；`scripts/smoke-web.mjs` 178 全绿。

---

## [1.59.55] - 2026-08-24

### 优化

- **AI 助手底部更紧凑**：删除底部右下角的模型名（顶部标题栏已显示），只留「＋ 新会话」；收紧输入区与底部内边距。

---

## [1.59.54] - 2026-08-24

### 优化

- **移除旧的目录悬浮按钮**：删除 `TableOfContents` 里右缘的「📑」`toc-toggle` 按钮及其样式；目录开关统一由右缘竖排图标栏的「☰」承担，避免重复入口。

---

## [1.59.53] - 2026-08-24

### 新增

- **右缘竖排图标栏（对齐 Wolai 启动入口）**：新增 `RightRail`，在窗口右缘一条竖排图标栏（AI / 目录），点击即在右侧抽屉间互斥切换；**移除了原右下角悬浮 Sparkle 按钮**（由右栏承担 AI 启动）。未启用时点栏上 AI 仍可进入设置。

---

## [1.59.52] - 2026-08-24

### 样式

- **目录当前节改为填充式高亮（对齐 Wolai）**：active 标题由「细彩条 + 淡底」改为**accent 填充 pill（白字）**，当前节更醒目；目录默认打开并让内容左移，紧贴内容右侧（Wolai 的右侧大纲栏形态）。

---

## [1.59.51] - 2026-08-24

### 新增/样式

- **右侧抽屉互斥（对齐 Wolai 单右栏）**：新增 `src/store/rightPanel.ts` 统一协调「AI 助手」与「目录」两个右侧抽屉——开 AI 自动关目录、开目录自动关 AI，避免叠放；所有 AI 入口（新建页引导/侧边栏/命令面板/悬浮钮）改走 `rightPanel.openAi`。
- **内容让位**：AI 面板打开时给 `.main` 加 `is-ai-open` 预留 380px 右侧空间（内容左移而非被覆盖，Wolai 风格）；目录沿用 `is-toc-open` 预留 280px。
- 目录样式保持 GitHub 式（当前节高亮彩条），与 Wolai 大纲一致。
- `tsc`/`vite build`/`cargo check` 均过；`scripts/smoke-web.mjs` 178 全绿。

---

## [1.59.50] - 2026-08-24

### 新增/样式

- **AI 助手重构为右侧停靠抽屉**（对齐 FlowUs/Wolai）：由右下角悬浮改为**右侧滑入抽屉**（复用 `.toc-panel` 模式），与文档并排、不遮挡正文。
- **上下文相关的一键操作**：快捷建议随「当前是否打开页面」变化（有页：总结当前页/列提纲/今日待办/校对…；无页：新建周计划/会议纪要/整理笔记…），并带**「换一批」**轮换。
- **欢迎语**：空态显示「Hi，我是 ShuyoNote 的 AI 助手…」卡片。
- **模型标签 + 新会话**：面板头部与底部显示当前模型（`config.model`）；底部提供**「＋ 新会话」**（清空历史开始新对话）。
- 输入框占位改为「问我你的问题…」；空态由居中小字改为建议列表 + 欢迎卡。
- `tsc`/`vite build`/`cargo check` 均过；`scripts/smoke-web.mjs` 178 全绿。

---

## [1.59.49] - 2026-08-24

### 修复

- **流式时写操作能真正产出草稿**：此前流式请求**未把 `tools` 传给模型、也未捕获流式响应里的 `tool_calls`**，导致模型只能用文字“叙述”要建页/追加，而无草稿可确认（表现像“卡死/没干活”）。现：
  - `llm.ts` 流式请求带上 `tools`，并从 NDJSON/SSE 流里**累计捕获 `tool_calls`**（Ollama 整段 / OpenAI 按增量索引拼装），流式路径返回 `nativeToolCalls`。
  - 桌面端 `ai_complete_stream` 同样传 `tools`、捕获 `tool_calls`，并在 `done` 事件里带回。
  - `createBackendStreamingTransport` 从 `done` 事件的 `toolCalls` 还原原生工具调用。
  - `scripts/smoke-web.mjs` 176→**178 项全绿**（新增：流式捕获原生 tool_call、流式写操作产出草稿）。

---

## [1.59.48] - 2026-08-24

### 新增

- **桌面端流式输出（后端事件总线）**：新增 `ai_complete_stream` Rust 命令（`reqwest` 以 `stream:true` 拉取，逐 token 通过 `app.emit("ai-stream:{runId}", {delta}/{done})` 推回）；前端新增 `createBackendStreamingTransport`（订阅事件并累积增量）。桌面端云/本地 LLM 现在也逐字显示，不再回退非流式。
- `store` 以 `IS_WEB` 分流：Web 用直接 fetch 流式，桌面用后端事件总线流式；两者都用 `onDelta` 节流实时更新回复卡。
- `cargo check` 编译 v1.59.48；`smoke-web` 176 全绿（Web 流式累积已覆盖，桌面事件总线为运行时验证）。

---

## [1.59.47] - 2026-08-24

### 新增

- **流式输出（Web）**：纯 HTTP 传输在收到 `onDelta` 回调时改走 `stream:true` 逐 token 解析——Ollama 用 NDJSON、OpenAI 兼容用 SSE；store 在 **Web 平台**用直接 fetch 流式并节流实时更新回复卡，桌面端维持后端非流式（绕过 CORS）。工具循环照常执行，每步模型输出皆可流式显示。
- `host.ts` 透传 `onDelta` 到传输层；store 以 `IS_WEB` 区分流式/非流式。
- `scripts/smoke-web.mjs` 174→**176 项全绿**（新增：NDJSON/SSE 流式累积）。

---

## [1.59.46] - 2026-08-24

### 新增/优化

- **停止/取消**：请求进行中「发送」变为「停止」按钮；`store` 用 `runSeq` 使过期结果/异常被丢弃，跨平台无需后端改动。
- **工具调用透明化**：`runAiLoop` 收集 `activity`（如「搜索『…』」「读取页面«…»」「新建页面『…』」），在回复卡下方以标签显示模型调用了哪些工具。
- **草稿预览**：`create_page`/`append_block` 草稿卡片展开预览将写入的标题/正文/追加文本（`src/lib/ai/preview.ts`），确认前可见。
- **会话持久化**：`history` 存入 localStorage（`shuyonote.ai.history`），刷新后保留多轮上下文。
- `scripts/smoke-web.mjs` 170→**174 项全绿**（新增：create_page activity、草稿预览三态）。

---

## [1.59.45] - 2026-08-24

### 新增

- **AI 回复 Markdown 渲染**：`src/lib/markdown.ts`（纯 `parseMarkdown`/`parseInline`）+ `src/components/Markdown.tsx`。支持标题/加粗/斜体/行内代码/链接/有序无序列表/引用/围栏代码/分隔线；**XSS 安全**——不输出原始 HTML、链接仅允许 http/https。回复卡改为渲染后的富文本。
- **多轮对话上下文**：`store/ai.ts` 维护限长 `history`（最近 8 轮），`runAiLoop` 接受 history 种子；追问（如「再详细点」）会带上之前对话，不再每次从头。回复卡「清空」即开新对话。
- `scripts/smoke-web.mjs` 161→**170 项全绿**（新增：Markdown 各级结构 + javascript: 链接被拒 + HTML 按纯文本处理）。

---

## [1.59.44] - 2026-08-24

### 样式

- **AI 助手面板视觉打磨**：空白态改为 Sparkle 图标 + 文案 + 快捷指令 chips（总结当前页/新建周计划/补充提纲/今日待办，点击直发）；输入框更圆润聚焦高亮，发送按钮改圆角药丸并对齐底部，面板整体更协调。

---

## [1.59.43] - 2026-08-24

### 优化

- **AI 助手标题栏更紧凑**：头部 padding 12×14→7×10、图标 17→15px、标题 14→13px、齿轮/关闭按钮 26→22px，栏高于更矮。

---

## [1.59.42] - 2026-08-24

### 优化

- **AI 助手头部更紧凑**：「设置」由大文本按钮改为小齿轮图标按钮（26px，含 tooltip「AI 设置」），配置完成后不常用的设置入口不再占位；未启用时仍由正文的「打开设置并启用」突出引导。

---

## [1.59.41] - 2026-08-24

### 优化

- **模型候选下拉**：AI 设置里「测试连接」成功后，把探测到的模型写入 `<datalist>`，用户可直接从候选中选模型，避免手打错名称。
- 修复云厂商（如 DeepSeek V4 网关）返回 400「不支持的模型名」时用户无从得知正确名称的问题：该类错误现在会把服务端提示（含支持的模型名列表）显示在助手面板与测试提示里。

---

## [1.59.40] - 2026-08-24

### 新增

- **云 LLM 后端代理（绕过 CORS）**：前端直连 DeepSeek/OpenAI 等会被浏览器/WebView2 以 CORS 拦截，此前云服务「没生效」。现按用户选择改为**受限后端代理**：
  - `src-tauri/src/ai.rs` 新增 `ai_complete`（`reqwest` 转发 `/api/chat` 或 `/v1/chat/completions`，解析 `content`/`tool_calls`）与 `ai_probe`（`/api/tags` 或 `/v1/models` 探测）。
  - `api.ts` 新增 `api.aiComplete` / `api.aiProbe`；桌面端走 Rust（无 CORS），Web 端 web handler 复用纯 HTTP 逻辑（本地 Ollama 可用，云受 CORS 限制——为已接受取舍）。
  - `src/lib/ai/transport.ts` 新增 `createApiTransport` / `probeApi`；store 发送与「测试连接」改走 `api.*`。
  - `llm.ts` 保留纯 HTTP 实现（供 web handler + 测试），`parseToolArgs` 导出。
  - `scripts/smoke-web.mjs` 159→**161 项全绿**（新增：web 平台 `ai_complete`/`ai_probe` 端到端）。

---

## [1.59.39] - 2026-08-24

### 新增

- **支持 OpenAI 兼容服务（DeepSeek / OpenAI 等）**：之前只实现了 Ollama 协议（`/api/chat`），用户填 DeepSeek 这类 OpenAI 兼容地址时「没生效」。现在：
  - `llm.ts` 新增 `createOpenAICompatTransport`（`POST {base}/v1/chat/completions`，Bearer 鉴权，解析 `choices[0].message` 与 `tool_calls`）与 `testOpenAICompatConnection`（`GET /v1/models`）。
  - 设置面板新增**服务商**选择（`Ollama 本地` / `OpenAI 兼容`）与 **API Key** 字段；默认模型与地址随服务商联动（OpenAI 兼容默认 `deepseek-chat` / `https://api.deepseek.com`）。
  - `store/ai.ts` 配置新增 `provider`/`apiKey`；`run`/「测试连接」按服务商路由（`createProviderTransport` / `testProviderConnection`）。
  - 鉴权失败（401/403）提示检查 API Key；`tool_calls` 的 `arguments` 兼容「对象」与「JSON 字符串」两种形态。
  - `scripts/smoke-web.mjs` 155→**159 项全绿**（新增：OpenAI 兼容探测 / 错 Key 鉴权失败 / OpenAI 兼容传输往返 / `createProviderTransport` 路由）。

---

## [1.59.38] - 2026-08-24

### 优化

- **AI 设置「测试连接」**：设置面板新增「测试连接」按钮，调用 `/api/tags` 检测本地 Ollama 是否可达、列出已安装模型，并提示当前模型是否可用——直接对症「设置了却像没生效」（多为服务未运行 / 地址错误 / 模型名不符）。
- **更可读的连接报错**：`llm.ts` 区分「服务未启动 / 地址错」（提示 `ollama serve`）与「CORS 被拦」（提示 `OLLAMA_ORIGINS=*`），不再抛笼统的 `Failed to fetch`。
- `scripts/smoke-web.mjs` 153→**155 项全绿**（新增：`testOllamaConnection` 对本地 HTTP 服务端到端往返 + 模型列表识别；`createOllamaTransport` 往返返回 assistant 内容）；改用 `process.exitCode` 退出，避免 Windows libuv 断言。

---

## [1.59.37] - 2026-08-24

### 修复

- **AI 设置可发现性**：之前 `AiAssistantPanel` 在 `config.enabled=false`（默认关）时直接不渲染，且设置对话框只能从面板头部的「设置」进入——新用户因此**无法打开设置去启用 AI**。现在右下角 Sparkle 悬浮按钮**始终可见**；面板在未启用时显示提示卡片并带「打开设置并启用」按钮，输入框/发送随之禁用。

---

## [1.59.36] - 2026-08-24

### 新增

- **薄 Agent 接口（M17，前端实现）**：按 `docs/plans/2026-08-24-thin-agent-interface-implementation-plan.md` 落地一个**最小暴露面**的 AI 助手。
  - `src/lib/ai/`：`types.ts`（AI 工具/消息契约）、`lexical.ts`（纯文本→Lexical JSON 助手）、`tools.ts`（**7 个白名单工具**：search_pages / read_page / read_block / get_backlinks / list_files / create_page / append_block）、`llm.ts`（可 mock 的 Ollama 传输 + 工具调用解析）、`host.ts`（受限宿主循环：读工具直接执行，写工具只产出**草稿**，绝不提交）、`apply.ts`（在用户确认后把草稿落到语义命令层）。
  - `src/store/ai.ts`：启用/禁用开关 + 本地模型端点配置（默认**关闭**，默认 Ollama `http://localhost:11434`）、运行状态与会话草稿。
  - `src/components/AiAssistantPanel.tsx` + `AiSettingsDialog.tsx`：右下角助手面板（输入框 + 回复 + 「由 AI 生成，仅供参考」+ 待确认操作列表）与设置对话框。
  - 入口按 `config.enabled` 显隐：新建页引导「用 AI 开始创作」、侧边栏「AI 助手」、命令面板 `ai.open`（`registry.ts` 新增带 `when` 门的命令）。
  - **安全红线**：无 shell / 任意文件读写 / 默认联网；`create_page`/`append_block` 均为草稿，需用户确认后才 `create_page`/`save_page`；全部复用既有语义命令，**未新增任何后端命令**（append 通过前端对 `save_page` 的包装实现）。
  - `scripts/smoke-web.mjs` 142→**153 项全绿**（新增：工具调用解析 / Lexical 追加与文本抽取 / `runAiLoop` 写路径只产草稿且不触达后端）。

---

### 优化

- **静默 Rust 编译警告**：`plugins.rs` 的 `thread_local!` 上误用 rustdoc 注释 + `Manifest.author` 未读字段——改为普通注释 + `#[allow(dead_code)]`，`cargo check` 干净。
- **文档同步**：`docs/roadmap.md` 把 M16.6 / M16.7 / M16.8（web 能力补齐 / 体验优化 / 数据安全）从「规划」追记为 **✅ 已实现**（对应 v1.59.24–30），并追加闭环：孤儿附件清理 / 跨空间复制 / `get_attachment` / 回收站恢复（v1.59.32–34）。

---

## [1.59.34] - 2026-08-24

### 修复

- **`get_attachment` 返回真实元数据**（web）：之前返回 null。现在按 id 读取附件行并从 blob store 解析显示地址；`list_page_attachments` 的路径改用惰性 `blobUrl`（而非 base64 data-URL，大媒体更省内存）。
- **回收站恢复走通**：删除页面后其附件（按 `page_id` 保留）随页面 `restore_page` 重新出现，`get_attachment` 恢复后仍可解析。
- `scripts/smoke-web.mjs` 139→**142 项全绿**（新增：get_attachment 元数据 / 恢复后附件重现 / 恢复后仍可解析）。

---

## [1.59.33] - 2026-08-24

### 修复

- **跨工作空间复制页面**（web）：`copy_page_to_workspace` 之前空操作。现在实现：从当前空间读取目标页面**子树**（BFS 收集），按新 id 重写，连同 page_props/page_tags/attachments 一起写入目标空间的快照（同空间则直接写入当前库）；附件字节保持全局内容寻址共享。返回新根 id。
- `scripts/smoke-web.mjs` 136→**139 项全绿**（新增：跨空间复制返回新 id / 目标空间出现副本 / 副本保留内容）。

---

## [1.59.32] - 2026-08-24

### 修复

- **清理孤立附件真正生效**（web）：`cleanup_orphan_attachments` 之前返回 0（空桩）。现在计算附件表引用的 hash 集合，删除 blob store 中**无任何行引用**的字节（内容寻址零引用规则）；`cleanup_temp_files` 浏览器无临时目录仍返回 0。
- `scripts/smoke-web.mjs` 133→**136 项全绿**（新增：孤儿清理返回计数 / 引用字节不删 / 再次清理）。

---

## [1.59.31] - 2026-08-24

### 修复

- **文件夹折叠时附件不折叠**：侧边栏 `TreeFiles`（文件夹内附件列表）之前**不受 `expanded` 控制**，文件夹折叠了附件仍显示。改为 `isFolder && expanded` 才渲染，与子页面一起折叠/展开。

---

## [1.59.30] - 2026-08-24

### 优化

- **自动化测试补强**（P1-4）：把拖拽排序的纯函数 `computeReorder` 抽到 `src/lib/treeReorder.ts`（无 React/DOM 依赖），并导出 `tokenize` 供测试；`scripts/smoke-web.mjs` 新增纯逻辑单测（inside 嵌套 / before-after 同级取中 / 拒绝自移动 / CJK+英文 tokenize）。129→**133 项全绿**。

---

## [1.59.29] - 2026-08-24

### 修复

- **写库失败不再静默丢数据**（P1-3）：`sqliteStore.persist()` 之前 `adapter.save` 失败是 fire-and-forget 静默。现在持久化失败会**保留内存状态**（不阻断 CRUD），并通过 `onPersistError` 回调 + `persist-error` 事件暴露给 UI，可提示"有未保存改动"，避免崩溃/吞错。
- `scripts/smoke-web.mjs` 126→**129 项全绿**（新增：persist 失败时内存写入成功 / 内存行可读 / onPersistError 被触发）。

---

## [1.59.28] - 2026-08-24

### 优化

- **大媒体内存保护**（P1-2）：web 端文件选择/上传增加**单文件 50MB 上限**，超限跳过并提示改用桌面版，避免超大文件缓冲进内存导致 OOM/卡死；媒体节点仍用 `MediaResolver` 按需从 blob store 取字节生成 Blob URL（不 base64 内嵌）。

---

## [1.59.27] - 2026-08-24

### 优化

- **侧边栏拖拽：自动展开 / 自动滚动**（P1-1）：拖动时停在某文件夹的 before/inside 区约 0.45s 自动展开它；拖到树容器顶部/底部时自动滚动；沿用粘性目标不闪断。

---

## [1.59.26] - 2026-08-24

### 优化

- **全文搜索（相关度排序）**（P0-3）：`search` 之前用 `LIKE` 匹配、按更新时间倒序，无相关度。改为 **token 化 + 相关度打分**：把查询拆成 ASCII 词 + CJK bigram/整串，对每页按「标题 TF（权重高）+ 正文 TF + 整词覆盖率 + 时间衰减」打分排序；并返回**围绕首个命中的片段**。同时把搜索限定在当前工作空间。`search` 对中英文都能按相关度命中。
- `scripts/smoke-web.mjs` 124→**126 项全绿**（新增：更高词频的页排前 / 片段锚定命中词）。

---

## [1.59.25] - 2026-08-24

### 优化

- **存储统计精确化**（P0-2）：`storage_stats` 之前 `db_bytes`/`attachment_bytes`/`trash_bytes`/`version_bytes` 全为 0，存储面板显示不准。修复：`db_bytes` 取实时快照长度；`attachment_bytes` 按附件行引用的 hash 累加 blob-store 实际字节（跨空间共享字节不重复计）；`trash_bytes`/`version_bytes` 按对应表的内容长度累加。
- `scripts/smoke-web.mjs` 123→**124 项全绿**（新增：storage_stats 真实 `db_bytes > 0`）。

---

## [1.59.24] - 2026-08-24

### 修复

- **附件移动/批量删除/恢复真正生效**（P0-1）：web 端 `move_attachment`/`remove_attachments`/`restore_attachment` 之前是空桩/占位，文件管理器里"移动 / 批量删除 / 从回收站恢复附件"点了没反应。修复：
  - `move_attachment`：校验目标容器存在 → `UPDATE attachments SET page_id`。
  - `remove_attachment`/`remove_attachments`：删行 + **仅当无其它行引用同一 hash 时**才删 blob 字节（内容寻址零引用规则，与桌面一致）。
  - `restore_attachment`：把历史版本克隆为新行（新 id、共享字节）放入目标容器。
  - `blobStore` 补 `delete`。
- `scripts/smoke-web.mjs` 117→**123 项全绿**（新增：移动归属 / 克隆恢复 / 批量删除计数与行删除 / 单个删除）。

---

## [1.59.23] - 2026-08-24

### 优化

- **侧边栏拖动体验大幅提升**：
  - **拖拽幽灵**：拖动时显示一个**跟随光标的浮层**（节点名 + 类型图标），清楚看到正在拖什么。
  - **源节点高亮**：被拖的行变暗 + 虚线框 + `grabbing` 光标，与目标行高亮区分开。
  - **落点不闪断**：指针移到行之间/空白处时**粘住上一个目标**（`lastOverRef`），不再高亮一闪一灭、也不至于松手丢到空白。
- `scripts/smoke-web.mjs` 仍 **117 项全绿**；`vite build` 通过。

---

## [1.59.22] - 2026-08-24

### 修复

- **桌面版侧边栏节点无法拖动**：Tauri v2 默认开启 `dragDropEnabled`，会**禁用 WebView 的 HTML5 拖拽**，所以可拖节点在浏览器能拖、在桌面 app 里拖不动。修复：把侧边栏树拖动改为**指针事件拖动**（mousedown → move 达阈值 → 命中目标行计算落点 → mouseup 执行 move），不依赖 HTML5 DataTransfer，桌面/浏览器一致，也不与 OS 文件拖放（dragDropEnabled）冲突。
  - 新增 `store/treeDrag.ts` 共享拖动状态；`PageTree` 统一协调 mousedown/mousemove/mouseup，命中行 `data-node-id` 计算 before/after/inside 三区；完成拖动后抑制紧跟的 click 以免误打开节点。
  - 提取 `computeReorder`（inside=子页面 / before/after=同级排序），与多选批量移动共用同一落点计算。
- `scripts/smoke-web.mjs` 仍 **117 项全绿**；`vite build` 通过。

---

## [1.59.21] - 2026-08-24

### 修复

- **桌面端全库恢复后空间名称不对**：桌面 `export_backup` 只快照空间 DB（`spaces/<id>.db`），**不含** meta.db；而前端空间名读自 `meta.workspaces`。所以恢复全库后 `meta.workspaces.name` 还是恢复前的旧名，侧边栏显示错误。修复：`import_backup` 在恢复数据库后，从**恢复的空间 DB 的 `workspaces` 行**读取空间名，并同步到 `meta.workspaces`（active 空间），侧边栏空间名随之正确。
- Rust 端：`backup.rs` 的 `import_backup` 增加 name 同步；`cargo check` 通过。

---

## [1.59.20] - 2026-08-24

### 修复

- **全库恢复后空间名称不对**：`import_backup`（覆盖全库）之前只 `restore` 数据库，但没有同步多空间 catalog——恢复后 `spaceStore` 仍保留恢复前的空间元数据与 active id，而 live 库里的 `workspaces` 行（来自备份）可能 id 不同，导致侧边栏空间名回到"我的工作空间"/"默认空间"，如备份里空间名不同则显示错误。修复：
  - 新增 `reconcileAfterRestore`：读取恢复后 live 库的 `workspaces` 行（按 `PRAGMA table_info` 动态列，兼容 web/桌面两种 schema），重建 `spaceStore` catalog、把 active id 设为恢复的行、并快照存档。
  - 侧边栏空间名改为**随 active 空间变化自动刷新**（`useEffect` 订阅 `activeSpaceId`），恢复/切换后不再陈旧。
  - BackupButton 恢复后刷新 `useSpaceStore.load()`。
- `scripts/smoke-web.mjs` 115→**117 项全绿**（新增：恢复后 `get_workspace_name` 返回备份的空间名 / `list_workspaces` 返回恢复后的空间列表）。

---

## [1.59.19] - 2026-08-24

### 优化

- **空间导出/导入进度条更可见**：之前进度条渲染在空间切换器弹层内，弹层在异步过程中可能关闭或不在视野内，导致"看不到流式进度"。增加**固定浮层进度条**（`.space-export-overlay`，固定于窗口底部，消息 + 百分比 + 进度条），无论弹层是否打开都始终可见，导出/导入完成后消失。
- 补充冒烟断言：`platform.event.listen("workspace-progress")`（UI 实际使用的订阅路径）在导出期间能收到进度事件。`scripts/smoke-web.mjs` 113→**115 项全绿**。

---

## [1.59.18] - 2026-08-24

### 优化

- **媒体不再内嵌 base64（省内存）**：之前插入图片/视频会在编辑器内容里存 base64 data-URL，大文件显著占用内存、DB 快照也膨胀。改为：
  - 图片/视频节点**改存稳定的内容 `hash`**，渲染时从 blob store（IndexedDB）现取字节 → 创建 **Blob URL**（`MediaResolver` 组件完成，卸载时 `revokeObjectURL`）。省内存且跨刷新存活（桌面端无 blob store 时回落到 `convertFileSrc(path)`）。
  - `save_image`/`import_attachment_files` 的返回 `path` 由 base64 data-URL 改为**惰性 blob URL**（`blobUrl` 助手），一次性预览用，不再展开 base64。
  - `scripts/smoke-web.mjs` 仍 **113 项全绿**（save_image/import 的显示地址断言改为接受 data:/blob:）。

---

## [1.59.17] - 2026-08-24

### 修复

- **web 版插入视频出错（插入后空白/无法播放）**：web 平台 `import_attachment_files` 之前**恒返回 `path: ""`**，所以插入图片/视频时 `convertFileSrc(metas[0].path)` 得到空字符串，视频节点 `src` 为空（上一版只加了占位符防止警告，但视频仍是坏的）。修复：web 端 `import_attachment_files` 返回**自包含的 data-URL 显示地址**（与 `save_image` 一致），插入的图片/视频现在有真实可播放的 `src`。DB 行内 `path` 仍为空以保持轻量，显示时由 `list_page_attachments` 从 blob store 回填。
- `scripts/smoke-web.mjs` 112→**113 项全绿**（新增：import 返回 data-URL 显示地址）。

---

## [1.59.16] - 2026-08-24

### 修复

- **控制台警告：An empty string ("") was passed to the src attribute**：部分图片/视频节点没有 `src` 时仍渲染 `<img src="">`/`<video src="">`，触发 React 警告并可能让浏览器重新拉取整页。修复：
  - `ImageNode`/`ImageRowNode`/`VideoNode`：`src` 为空时不渲染真实节点，改渲染一个 `.editor-image-empty` 占位块（不再产生空 `src`）。
  - 文件管理预览：`preview.path` 为空时不再给 `<img/video/audio/iframe>` 传空 src，改为显示"预览地址不可用"提示。
- `scripts/smoke-web.mjs` 仍 **112 项全绿**；`vite build` 通过。

---

## [1.59.15] - 2026-08-24

### 新增

- **web 版多工作空间并存**（方案 A：空间快照隔离）：
  - **每个空间一份独立 DB 快照**，存于独立 IndexedDB 库 `shuyonote-spaces`（catalog 存空间元数据 + active id，snapshots 存各空间 DB 字节）；切换空间 = 把当前 live 库快照存档、再 restore 目标空间快照。与桌面"每空间一个 DB 文件"模型一致。
  - **工作空间 CRUD 真正可用**：`list_workspaces` 返回全部空间；`create_workspace` 新建空空间并切到它（新建时先快照当前空间，避免丢改动）；`rename_workspace`/`set_workspace_settings` 按 id 更新；`delete_workspace` 清除该空间快照并（若删除的是 active）切到剩余第一个；`set_active_workspace_id` 负责快照/切换。
  - `import_workspace` 改为**新建空间**（不覆盖现有）；`import_backup` 仍是覆盖全库。
  - **隔离**：各空间页面/标签/数据库/附件互不可见（查询按 active 作用域；附件字节 blob store 全局去重共享，归属按空间过滤）。
- 前端空间切换器无需改动（已按 `spaces` 多列表渲染）；`space.ts`/`notes.ts` 由平台层过滤，无需改。
- `scripts/smoke-web.mjs` 101→**112 项全绿**（新增：创建空间并切换 / 空间隔离（新空间页首选项不串）/ 切换回后保留 / 重命名更新 catalog / 删除空间 / 快照切换后改动不丢）。IndexedDB shim 补 `getAll`/`delete` 以支撑 catalog。

---

## [1.59.14] - 2026-08-24

### 新增

- **导入/恢复流式进度条**：
  - **导入备份（覆盖全库）**：web 端 `import_backup` 现在在读取、恢复数据库、逐个恢复附件时都派发 **`backup-progress`** 事件（`phase: "import"`），备份按钮的进度条随附件逐条推进，不再干等。
  - **导入空间包**：`import_workspace` 之前是空桩，现在真正实现——读取 `space-export.zip`（`shuyonote.db` + `workspace.json` + `attachments/<hash>`），恢复数据库、按 `workspace.json` 应用空间名、逐条恢复附件，并派发 **`workspace-progress`**（`phase: "import"`）。
  - **导出备份**：`export_backup` 也改为流式压缩并派发 `backup-progress`（与大空间导出一致）。
  - 空间切换器里的导入按钮现在也有进度条。
- `scripts/smoke-web.mjs` 96→**101 项全绿**（新增：备份导入派发 `backup-progress` / 事件含 phase/done/total；空间导入返回元数据并应用 `workspace.json` 名称 / 派发 `workspace-progress`）。

---

## [1.59.13] - 2026-08-24

### 优化

- **空间导出改为流式压缩**：之前 web 版用 `zipSync` 一次性同步压完所有文件，附件多时末尾会整段卡住主线程。现在改用 fflate 的**流式 `Zip`**，逐文件压缩、文件间让出事件循环，压缩过程实时派发 `workspace-progress`（进度条随每个文件推进，而不只是打包前/后跳两次）。导出大空间时界面不再冻结。
- `scripts/smoke-web.mjs` 保持 **96 项全绿**（流式压缩产物仍能被 `unzipSync` 正确解压并含 db/workspace.json/attachments）。

---

## [1.59.12] - 2026-08-24

### 新增

- **空间导出进度条**：之前「导出当前空间」点击后没有任何反馈，直接等结果（大空间会卡住没提示）。现在：
  - web 端 `export_workspace` 在导出过程中**分阶段派发 `workspace-progress` 事件**（准备 → 打包数据库 → 逐个打包附件 → 写入下载）。
  - web 平台 `event.listen` 现在转发浏览器的 `CustomEvent`，所以**同一套前端监听代码**在 web 和桌面（Tauri 原生事件）都能收到进度。
  - 空间切换器里在「导出当前空间」下新增**进度条**（消息 + 百分比 + 填充条），导出完成后提示大小/附件数。
- `scripts/smoke-web.mjs` 94→**96 项全绿**（新增：导出期间派发 `workspace-progress` 事件 / 事件含 done/total/message）。

---

## [1.59.11] - 2026-08-24

### 修复

- **web 版侧边栏文件夹仍不显示文件名（上一版修复无效）**：问题不止于没读 `page_id` —— web 版 `import_attachment_files` 还做**按 hash 去重跳过插入**：若内容相同的行已存在（例如在补 `page_id` 之前上传过、留下 `page_id = NULL` 的孤儿行），再次上传会命中 `existing` 而**跳过插入**，新的 `page_id` 根本没写进去，文件依旧不出现在文件夹下。修复：**每次都插入新行**（与桌面后端、`save_image` 一致，每行自带 `page_id` 归属；字节仍内容寻址去重写入 blob store）。`scripts/smoke-web.mjs` 92→**94 项全绿**（新增：重复导入同内容仍归属文件夹）。

---

## [1.59.10] - 2026-08-24

### 修复

- **web 版侧边栏文件夹不显示文件名**：`import_attachment_files`（web 处理器）之前**忽略了传入的 `page_id`**，插入 `attachments` 行时没有写归属文件夹，导致 `list_page_attachments(folderId)` 按 `page_id` 过滤后返回空——上传到文件夹里的文件根本不出现在侧边栏/文件管理，看起来就是「文件名不显示」。修复：读取 `a.pageId ?? a.page_id` 并写入行的 `page_id`（与桌面后端一致）。`scripts/smoke-web.mjs` 88→**92 项全绿**（新增：导入保留文件名 / 文件归属文件夹 / 不在其它文件夹下）。

---

## [1.59.9] - 2026-08-24

### 修复

- **web 版空间导出不正确（导出为 0 字节）**：`export_workspace` 之前是个空桩，返回 `size: 0`，所以「空间导出」下载到的是一个空文件。修复：web 端真正打包出**自包含 zip**，与桌面格式一致——
  - `shuyonote.db`（SQLite 快照）+ `workspace.json`（空间元数据）+ `attachments/<hash>`（该空间页面引用的附件字节）。
  - 返回真实的 `size / pages / attachments` 计数，提示不再显示「大小 0.0 KB」。
  - `scripts/smoke-web.mjs` 82→**88 项全绿**（新增：空间导出非零大小 / 页面计数 / 附件计数 / zip 含 db+json+attachments）。

---

## [1.59.8] - 2026-08-24

### 优化

- **侧边栏拖拽排序手感**：拖动节点的落点分区更宽松、更直观——
  - **排序区扩大**：顶/底各约 1/3 为同级前/后插入（之前仅 25% 窄条），中间约 1/3 才作为子页面，重排更容易命中。
  - **更清晰的视觉提示**：before/after 显示**明显的强调色插入线**，inside 显示**外框+↳ 缩进提示**，一眼能看出是排序还是嵌套。
  - 分区阈值提为统一常量（`DROP_BEFORE_MAX` / `DROP_AFTER_MIN`），`onDragOver` 与落点处理共用一份，避免两处不一致。

---

## [1.59.7] - 2026-08-24

### 新增

- **页面拖到另一个页面 → 成为其子页面**：之前拖到普通页面/数据库上只做同级排序（上下半区前/后插）。现在拖到**任意节点**上：
  - **行中间（25%–75%）**：把拖动的页面**嵌套为目标节点的子页面**（文件夹、页面、数据库都行）。
  - **行顶/底窄条**：仍做同级**前/后插入**，不丢失原有的同级重排。
  - 三个落点都有视觉指示（中间高亮 / 顶部横线 / 底部横线）。
- 桌面端 `move_page` 早已有防循环保护（不能移到自身或后代），web 端上一版也已补齐，两端一致。

---

## [1.59.6] - 2026-08-24

### 新增

- **侧边栏节点多选（批量移动 / 批量删除）**：侧边栏原来只有单选（点击即打开）。现在支持 **Ctrl/⌘+点击** 增减选中节点（带 ✓ 标记与高亮），并在树底部弹出**批量操作条**：
  - **移动到…**：把选中的多个节点批量移入任一文件夹或工作空间根目录。
  - **移入回收站**：确认后批量删除选中节点及其子树。
  - **取消**：清除选择。
- **防循环保护**：web 端 `move_page` 现在会拒绝把节点移到其**自身或某个后代**之下（否则批量把文件夹拖进自己的子文件夹会弄坏树）。`scripts/smoke-web.mjs` 80→**82 项全绿**（新增：禁止移入自己后代 / 禁止移到自身）。

---

## [1.59.5] - 2026-08-24

### 修复

- **从模板中心创建页面，页名变成一大串 UUID**：web 端 `save_page` 之前用 `str(args.title ?? p.id)`——编辑器内容自动保存时**不传 `title`**，于是标题被回退成了页面自身的 UUID，模板新建的页面在侧栏显示一长串 ID。修复：改为**只在提供了非空标题时才覆盖标题**，否则保留当前标题（与桌面后端 `title = args.title.unwrap_or(cur_title)` 一致）。
- **模板页命名**：从模板中心创建时，把模板名作为页面标题传入（如「我的个人图书馆」），不再落到「未命名」。
- `scripts/smoke-web.mjs` 78→**80 项全绿**（新增：纯内容保存保留原标题 / 内容仍正常写入）。

---

## [1.59.4] - 2026-08-24

### 修复

- **上传失败：table attachments has no column named path**：web 端 `save_image`/`import_attachment_files`/`attachment_path` 之前用**固定列** `INSERT ... (id, page_id, name, hash, mime, size, path)` / `SELECT path, ...`。但导入桌面版 zip 后，`attachments` 表是**桌面 schema**（`created_at`，**无 `path` 列**），于是报"no column named path"。修复：抽出**schema 感知**的 `insertAttachmentRow`/`attachmentColumns`（读 `PRAGMA table_info(attachments)` 动态拼列）——`path` 存在才写、`created_at` 存在才补值（桌面表 `created_at NOT NULL`），`attachment_path` 改用 `SELECT *` 并在无 `path` 列时回落到 blob store。同库同时兼容 web 简化 schema 与桌面完整 schema。`scripts/smoke-web.mjs` 76→**78 项全绿**（新增：桌面 schema 无 `path` 插入 + web schema 有 `path` 插入）。

---

## [1.59.3] - 2026-08-24

### 修复

- **上传失败：NotFoundError: One of the specified object stores was not found**：`blobStore` 和 `sqliteStore` 都用了 `indexedDB.open("shuyonote", 1)`，但各自想要不同的 object store（`blobs` vs `db`）。先打开的那个完成 v1 升级后，后打开的 `onupgradeneeded` 不再触发，其 object store 从未创建——`blobStore.put` 对不存在的 store 做事务就抛 NotFoundError。修复：`blobStore` 改用**独立数据库名 `shuyonote-blobs`**，与 SQLite 库彻底隔离，避免升级顺序竞争。

---

## [1.59.2] - 2026-08-24

### 修复

- **删除文件夹时里面的页面和文件还在**：
  - **级联软删子内容**：web 版 `delete_page` 之前只软删当前节点。改为**递归收集所有未删后代**（子页面/子文件夹/数据库）逐一软删，`purge_page` 同理**级联物理删除**（含 page_tags/page_props/page_versions）。删除文件夹后，树里不再残留其子页面。
  - **附件归属（`attachments.page_id`）**：web 附件表补 `page_id` 列（含对旧库的 `ALTER TABLE ADD COLUMN` 迁移 + 索引）；`save_image`/`import_attachment_files` 记录归属，`list_page_attachments` 按 `page_id` 过滤——文件管理按文件夹展示附件、不串夹。
  - **`save_image` 始终插一行**：之前按内容 hash 去重跳过插入，导致同内容二次保存丢失 page_id 归属。改为 id-based 恒插入（字节仍内容寻址去重）。
  - 顺带修复 `save_image` 的 `{ args }` 解包 bug（之前读 `a.data` 是 undefined）。
  - `scripts/smoke-web.mjs` 73→**76 项全绿**（新增：delete 级联软删子页面 / 级联入回收站 / 附件按 page_id 过滤）。

---

## [1.59.1] - 2026-08-24

### 修复

- **空间导入失败：NOT NULL constraint failed: workspaces.created_at**：导入桌面版 zip（其 `workspaces` 表含 `created_at NOT NULL`）后，web 端任何命令都会触发 workspace 种子插入——但原插入语句不含 `created_at`，在桌面 schema 上报错。修复：`seedWorkspaceMeta` 改为**读 `PRAGMA table_info(workspaces)` 动态拼列**——`created_at`/`updated_at` 存在才一并插入，兼容 web 简化 schema 与桌面完整 schema。
- `scripts/smoke-web.mjs` 72→**73 项全绿**（新增：桌面 schema（created_at NOT NULL）下 workspace 种子正确包含 created_at）。

---

## [1.59.0] - 2026-08-24

### 新增（Web ↔ 桌面备份互认）

- **Web 版备份改为标准 zip**（与桌面 `export_backup` 结构一致），使 web 与桌面能**手动搬数据互认**：
  - 引入 `fflate`（纯 JS zip，~8KB）。`web.ts` 的 `export_backup` 用 `zipSync` 产出标准 zip：`shuyonote.db`（SQLite 快照）+ `attachments/<hash>`（内容寻址字节）。
  - `import_backup` 用 `unzipSync` 解析 zip：取 `shuyonote.db` 恢复库、`attachments/*` 回填 `blobStore`；并兼容旧的 web 自定义 JSON 容器（回退路径）。
  - 新增 `read_file_bytes` 命令（返回原始字节，供二进制资产读取/测试）。
  - `scripts/smoke-web.mjs` 71→**72 项全绿**（新增：export_backup 产出标准 zip 含 shuyonote.db + attachments/、import_backup 解析恢复）。
- ⚠️ **诚实边界**：web 数据仍存自己的 IndexedDB，与桌面的「**自动互通**」仍需自建 sync-server（此为长期项）。本步只做到「**备份手动互认**」——两边导出/导入同构 zip 即可搬数据。但因桌面库是完整多库 schema、web 是简化库，**跨端导入后表结构差异可能需数据清洗**，实际用桌面 zip 导入 web 前建议先确认。

---

## [1.58.5] - 2026-08-24

### 修复

- **文件管理不能一键多选**：表头「全选」checkbox 之前只作用于 `kind === "file"`（附件）行——因为可见行多为页面/文件夹，`allSelected` 误判为已全选（空数组 `.every()` = true），而 `toggleSelectAll` 又只选文件，所以点全选不生效、表头状态也是错的。修复：
  - `allSelected`/`toggleSelectAll` 作用于**所有可见行**（页面/文件夹/数据库/文件），全选/反选一致。
  - 批量删除(`batchRemove`) 现在同时删除**选中的页面/文件夹/数据库**(`deletePage`) + **文件**(`removeAttachments`)，按钮显示所选总数，确认文案与操作匹配。
  - 表头 title 由「全选/取消全选（文件）」改为「全选/取消全选」。

---

## [1.58.4] - 2026-08-24

### 修复

- **新建页面永远叫「未命名」**：Web 平台 `create_page`/`create_folder`/`create_database` 之前忽略传入的 `title`，固定用「未命名/新建文件夹/新建数据库」。修复：优先用 `args.title`（非空），否则按类型回退默认名——所以文件管理里新建的页面不再全是「未命名」。
- `scripts/smoke-web.mjs` 70→**71 项全绿**（新增：`create_page` 尊重显式标题）。

---

## [1.58.3] - 2026-08-24

### 修复

- **页面不能移动到文件夹**：
  - 前端 `PageTree.handleDrop`：拖到**文件夹**行上时，把页面 `parent_id` 设为该文件夹（移入），而非仅同级重排。
  - **Web 平台 `move_page`/`create_page`/`save_page`/`create_folder`/`create_database` 参数解包 bug**：前端 api 把这些命令的实参包在 `{ args }` 里，但 web handler 直接读 `a.xxx`（读到 undefined）——导致 Web 版移动/新建/保存时 `parent_id`/`title` 等全部失效（也解释了「移到文件夹」在 Web 版无效）。改为 `a.args ?? a` 统一解包。
  - `scripts/smoke-web.mjs` 66→**70 项全绿**（新增：`{ args }` 包裹的真实 api 调用——create_page/save_page/move_page 均正确读参数，move 进文件夹设置 parent_id）。

---

## [1.58.2] - 2026-08-24

### 修复

- **文件选择器 `removeChild` NotFoundError**：`pickBrowserFiles` 的 `cleanup()` 里 `input.remove()` 后又 `document.body.removeChild(input)`——控件已移除后再次 removeChild 抛错（选文件后会崩）。改为只调一次幂等的 `input.remove()`。
- **PWA meta 弃用告警**：`index.html` 补 `mobile-web-app-capable`（`apple-mobile-web-app-capable` 已弃用但仍保留以兼容 iOS）。

---

## [1.58.1] - 2026-08-24

### 修复（Web 平台保存失败）

- **修复「保存失败：Wrong API use : tried to bind a value of an unknown type (undefined)」**：sql.js 在绑定 `undefined` 参数时会抛"unknown type"错误。给 `SqliteStore.run`/`query` 加了**参数归一化**（`undefined → null`），防御所有调用点——凡是命令参数缺省/未传时不再崩。
- `scripts/smoke-web.mjs` 64→**66 项全绿**（新增：`save_page` 容忍 undefined 字段 / undefined 参数不再抛 raw sql 错误）。

---

## [1.58.0] - 2026-08-24

### 文档

- **跨平台方案里程碑落地状态更新**：`docs/roadmap.md` 的 M16 段、`docs/plans/2026-08-24-cross-platform-plan.md` 里程碑、`docs/README.md` 方案索引，从「规划中」如实更新为**实际已落地状态**——M16.0/M16.0b/M16.1a/M16.1b 已完成（浏览器 Web 平台 / 真实 SQLite / 属性数据库 / 版本历史 / 块引用反链 / 文件导入导出 / 整库备份 / 可离线 PWA，`smoke-web.mjs` 64 项全绿），并把 OPFS/wa-sqlite 增量、插件运行时标注为「需真实浏览器验证」或「根本性限制」的长期项。
- **桌面无回归确认**：在引入全部 platform-driver/Web 改动后重新运行桌面 Tauri dev，编译成功、进程运行正常——`index.ts` 按环境自动切 tauri/web，Rust 后端未触碰。

---

## [1.57.0] - 2026-08-24

### 新增（Web 平台备份导出/导入）

- **浏览器版能「整库备份 + 恢复」了**：把全部笔记数据（SQLite 库快照 + 附件字节）打成一个**自包含 JSON 容器**下载，可再导入恢复。
  - `blobStore.entries()`：枚举所有附件字节（hash + bytes，供打包）。
  - `SqliteStore.snapshot()`（`db.export()` 字节）+ `SqliteStore.restore(bytes)`（用备份字节重建数据库句柄并迁移）。
  - `web.ts` 的 **`export_backup`**：打包 `{format:"shuyonote-web-backup",version:1,exported_at,db:base64,attachments:{hash:base64}}`，浏览器里 Blob 下载，并注册进 `fileRegistry`（同会话可读回）；返回 `{path,size}`。**`import_backup`**：读容器 → 校验 format → `store.restore(db)` + 把附件字节回填 blobStore。
  - `scripts/smoke-web.mjs` 61→**64 项全绿**（新增：export_backup 返回 path+size(≈164KB)/构建可解析容器/import_backup 恢复页面数据）。

---

## [1.56.0] - 2026-08-24

### 新增（Web 平台块级引用 / 反链）

- **浏览器版支持「块级引用 + 反链面板」**（对齐桌面，`((id))` 块引用 / `{{id}}` 块嵌入 / `[[标题]]` 页面引用）：
  - `web.ts` 新增解析 `content_json` 的块级辅助（`parseJson`/`rootChildren`/`nodeText`/`collectBlockRefs`/`snippetForBlock`/`blockTextOf`），不用额外表——直接解析序列化 Lexical JSON。
  - 实现命令：
    - **`get_page_blocks`**：解析页面 `content_json` 里带 `blockId` 的顶层块 → `{block_id,text}`。
    - **`resolve_block`**：全局查块 → `BlockInfo`（block_id/page_id/page_title/snippet/content）。
    - **`get_backlinks`**：`[[标题]]` 页面引用 → 引用的来源页（`PageMeta[]`）。
    - **`list_block_backlinks`**：本页块被 `blockref`/`blockembed` 引用的来源块对（`BlockBacklink[]`，含 source/target snippet）。
    - **`search_blocks`**：按块内容搜索 → `SearchBlock[]`（含 block_id/page_id/page_title/snippet）。
  - `scripts/smoke-web.mjs` 56→**61 项全绿**（新增：get_page_blocks 提取块 / resolve_block 返回 BlockInfo / get_backlinks 引 `[[标题]]` / list_block_backlinks 找块引用 / search_blocks 按内容搜块）。

---

## [1.55.0] - 2026-08-24

### 新增（Web 平台文件读写 / 导入导出）

- **浏览器版能「把内容取出来 / 读进来」了**：文件读写、附件导入导出不再空值降级：
  - `web.ts` 新增浏览器文件桥：`fileRegistry`（会话注册表，按文件名映射字节）+ `pickBrowserFiles`（隐藏 `<input type=file>` 选文件，读入内存）+ `downloadBytes`/`downloadText`（Blob 下载，让内容真正离开浏览器）。
  - **`dialog.open`**：浏览器里用文件选择器（支持多选、filters 映射到 `accept`），返回所选文件名作路径；`directory: true` 无浏览器映射 → 返回 null。**`dialog.save`**：返回 `defaultPath` 作为写入目标（浏览器外返回 null）。
  - **`write_text_file`**：把文本按目标文件名 **Blob 下载**出来（内容真正落到用户下载目录），并注册进 `fileRegistry` 供同会话 `read_text_file` 往返。**`read_text_file`**：从注册表按文件名返回内容。
  - **`import_attachment_files`**：把 dialog.open 选中的 File 字节存 `blobStore`（内容寻址）+ 插附件元数据行；**`copy_attachment`**：把附件字节按文件名下载出来。
  - 非浏览器（Node 测试）安全降级：dialog.open/save 返回 null、write_text_file 不触发下载但仍注册、import/read 走注册表不崩。
  - `scripts/smoke-web.mjs` **56 项保持全绿**（dialog 在 Node 安全降级不崩）。

---

## [1.54.0] - 2026-08-24

### 新增（Web 平台版本历史）

- **浏览器版支持「版本历史」**（对齐桌面，恢复误改内容的能力）：
  - `sqliteStore` 加 `page_versions` 表（id/page_id/title/content_json/content_text/created_at + 索引）。
  - `save_page` 在覆盖前调用 `snapshotBeforeSave`——**快照当前内容到版本历史**，**去重连续相同快照** + **每页保留最近 50 版**（对齐 Rust `MAX_VERSIONS_PER_PAGE`）。
  - 实现 `list_versions`（按 page_id 倒序列出，限 100）、`restore_version`（把版本内容写回页面并返回 `PageDetail`，供前端 `updateCurrent`+重开页面）。
  - `cleanup_old_versions(maxKeep)`：删除每页「超过 maxKeep 的旧版本」，返回释放数量；`storage_stats` 的 `version_count` 改为真实 `page_versions` 计数。
  - `scripts/smoke-web.mjs` 50→**56 项全绿**（新增：list_versions 返回快照 / save_page 触发快照 / restore_version 返回 PageDetail / cleanup_old_versions 释放计数 / 上限回收 / storage_stats 版本计数）。

---

## [1.53.0] - 2026-08-24

### 新增（Web 平台属性 / 数据库透镜）

- **浏览器版支持「数据库=透镜」**：把 Web 平台从「只有 pages/tags/搜索」补全到**属性 + 数据库视图**：
  - 新增支撑表：`attr_defs`（id/name/type/options）、`page_props`（page_id/attr_id/value，可多值）、`database_columns`（db 页 × 属性列）、`db_views`；`pages` 表加 `db_rule` 列（含对旧库的 `ALTER TABLE ADD COLUMN` 安全迁移）。
  - `web.ts` 实现命令：
    - **属性**：`list_attr_defs`/`create_attr`（重名校验 + select 选项）/`update_attr`/`delete_attr`（级联清 page_props/database_columns）/`get_page_props`（含 tag 类型视图）/`set_page_prop`（upsert）/`remove_page_prop`。
    - **数据库**：`get_db_columns`/`add_db_column`/`remove_db_column`/`query_database`（收集页 + 属性列值 + tag 列视图 + **db_rule 会员规则过滤**）/`list_db_views`/`save_db_view`/`delete_db_view`/`set_db_rule`（JSON 校验）/`get_db_rule`。
    - **看板 / 引用**：`board_data`（按标签分组）/`board_by_attr`（select 选项分组 + 「未设置」列）/`move_card`（清页面旧标签 + 赋目标标签）/`resolve_refs`（`p:<id>` → `⇄ 标题`）。
  - 删除了 search 块里遗留的空 `resolve_refs`（与新实现冲突）。
  - `scripts/smoke-web.mjs` 37→**50 项全绿**（新增：create_attr/设属性/属性列表/建库/加列/query_database 行含值 + 规则过滤/看板分组/保存与列出视图/get+set_db_rule/ref 解析/move_card 换标签）。

---

## [1.52.0] - 2026-08-24

### 新增（Web 平台 PWA / 离线安装）

- **可安装离线 PWA**：把浏览器版变成可安装、可离线的本地 app：
  - `public/manifest.webmanifest`：`name`/`short_name`/`start_url`/`scope`/`display:standalone`/`orientation`/`theme_color`/`background_color`/`categories` + SVG 图标（普通 + maskable）。
  - `public/icons/icon.svg`：单色圆角方块 + 白页 + 内容线条的图标（与 anti-slop 一致）。
  - `public/sw.js`：Service Worker——install 预缓存应用壳（`/`、manifest、icon）、activate 清理旧缓存、fetch 策略：导航 = 网络优先回退缓存壳、静态资源 = 缓存优先 + 网络回填、跨域透传。
  - `index.html`：注入 `manifest` link、`theme-color`、apple-touch icon、`apple-mobile-web-app-*` meta、`lang="zh-CN"`、标题 `ShuyoNote`。
  - `main.tsx`：**仅 production**（`import.meta.env.PROD`）注册 `navigator.serviceWorker.register("/sw.js")`（dev 下跳过，避免与 Vite dev/HMR 缓存冲突）。
  - 关键点：笔记数据在 IndexedDB（SQLite via sql.js），不在 HTTP 缓存，与 SW 缓存不冲突——离线打开仍能读/写本机数据。
  - 已验证：`dist/` 正确产出 manifest/sw/icon；dev server 以正确 content-type（`application/manifest+json` / `text/javascript` / `image/svg+xml`）serve；manifest 是合法 JSON（name/display:standalone/start_url/icons/theme 均正确）；SW `node --check` 通过；`dist/index.html` manifest/theme-color/apple-touch 注入正确。

---

## [1.51.0] - 2026-08-24

### 新增（Web 平台数据安全）

- **持久化存储（`navigator.storage.persist()`）**：请求浏览器把本 Origin 标记为持久化，避免磁盘紧张时自动清理数据库导致笔记丢失（对治 IndexedDB best-effort 淘汰风险）：
  - `web.ts` 新增 `request_persistent_storage` 命令：调用 `storage.persisted()` → `persist()` → `estimate()`，返回 `{ persisted, persistedBefore, quota, usage, supported }`；模块加载时自动请求一次（fire-and-forget）。
  - `api.requestPersistentStorage()` 暴露给前端；`StoragePanel`（▦ 存储面板）新增**持久化状态行**——「已启用/未启用 + 用量/配额」，并提供「启用持久化」按钮（按钮点击 = 用户手势，满足 Chrome 等要求 persist() 需用户交互的限制；自动请求可能被拒，按钮可补上）。
  - `scripts/smoke-web.mjs` 36→**37 项全绿**（新增 persist 返回安全对象的断言；Node 无 navigator → `supported:false` 安全降级）。

---

## [1.50.0] - 2026-08-24

### 优化（Web 平台存储结构修正）

- **图片字节不再造入库（M16.1 结构修正）**：把 Web 平台的附件字节从「base64 塞进 SQLite」改为**独立二进制 blob 存储**，库只存元数据 + 内容寻址 hash：
  - 新增 `src/lib/platform/blobStore.ts`：IndexedDB 按 `hash`（**内容寻址**）存图片/视频/音频原始字节，附 SHA-256 摘要（不可用时 FNV-1a 回退）；同内容去重。
  - `web.ts` 的 `save_image`：字节存 `blobStore`（hash = `contentHash(bytes)`，不再是随机 uid），SQLite `attachments` 只插 `id/name/hash/mime/size`（`path` 留空）；返回 `AttachmentMeta.path` = **data URL**（供 `<img>` 立即且跨重载显示）。
  - `attachment_path(hash)` / `list_page_attachments`：从 `blobStore` 读字节 → 还原可显示 data URL。
  - **效果**：SQLite 库体积不再随图片增长；每次写入不再重导大量 base64。字节存 IndexedDB blob（真实浏览器），与桌面「字节落盘、库只引用」模型对齐。
  - `scripts/smoke-web.mjs` 32→**36 项全绿**（新增 `save_image` 返回内容 hash / `path` 为 data URL / `attachment_path` 从 blob 还原 / `list_page_attachments` 含显示 path，附件用 IndexedDB shim）。

---

## [1.49.0] - 2026-08-24

### 重构（M16.1 第一步）

- **Web 平台改用真实 SQLite（WASM）**：把浏览器版从「localStorage JSON mock」升级为**真正的 SQLite 数据库**，核心笔记 CRUD 跑真实 SQL：
  - 新增 `src/lib/platform/sqliteStore.ts`：基于 `sql.js`（WASM SQLite）的异步存储封装——`SqliteStore`（`run`/`query`），浏览器用 **IndexedDB** 持久化整库（`db.export()`），并带 `setWasmUrl`/`setWasmBytesProvider`/`setDefaultAdapter` 可注入点（供测试用 fs/内存适配器）。**首次加载后即开即用**，schema 含 workspaces/pages/tags/page_tags/attachments。
  - 新增 `src/lib/platform/sqljs-types.ts`：为 sql.js（无类型）补最小类型声明。
  - `web.ts` 的 `executor.invoke` 核心命令改为操作真实 SQL：pages CRUD、软删/回收站/恢复、tags 关联、按标签过滤、搜索（`LIKE`）、工作空间设置、关系图节点、图片附件；其余命令仍安全降级空值（同步/加密/插件/数据库透镜等 Tauri 专属能力）。
  - 种子：欢迎页 + 快速上手 + 「入门」标签（首次打开即演示）。
  - **wasm 加载修正**：sql.js 浏览器构建默认的 `locateFile`/`fetch` 在 Vite 模块图里会拿到 HTML，改为**自行 fetch wasm 字节并以 `wasmBinary` 传入**（含 `\0asm` 魔数校验），生产构建正确产出 `sql-wasm-browser-*.js`。
  - IndexedDB 增加**超时回退**（受限/无痕环境优雅降级为内存库，绝不阻塞）。
  - `scripts/smoke-web.mjs` 在 Node 下用 `createWebPlatform()` + fs 适配器跑真实 SQLite，**32 项断言全绿**（新增软删→回收站→恢复、跨实例持久化；sql.js 在 Node 一并验证）。

---

## [1.48.0] - 2026-08-24

### 优化（Web 平台体验完整化）

- **浏览器 Web 平台核心能力补齐**：`src/lib/platform/web.ts` 的 mock 后端从「空值降级」升级为「核心交互真实可用」：
  - **标签系统**：`add_tag`/`remove_tag`/`page_tags`/`pages_by_tag` 真实关联——标签栏显示、按标签过滤、标签页计数、删除标签级联清关联。
  - **搜索**：`search`/`search_blocks` 按标题+正文命中，返回真实页面结果（FTS-lite）。
  - **工作空间设置**：`rename_workspace`/`set_workspace_settings`（主题/图标）持久化到 localStorage。
  - **内置模板**：`list_templates` 返回「会议纪要 / 读书笔记」两个演示模板，模板中心不再空白。
  - **关系图 / 左列数据**：`get_graph` 返回真实页面节点；`list_workspaces` 返回主题/图标/排序。
- 种子数据增强（欢迎页 + 快速上手 + 「入门」标签），首次打开即可看到完整演示。
- `scripts/smoke-web.mjs` 断言从 22 项扩展到 **30 项**（新增标签关联/按标签过滤/搜索/工作空间设置/模板/图中节点等）；全部通过。
- 已在 Edge 无头浏览器验证：app 渲染出两个种子页 + 编辑器 contenteditable。

---

## [1.47.0] - 2026-08-24

### 新增

- **浏览器 Web 平台（M16.0b）**：`pnpm dev:web` 让 ShuyoNote 在**纯浏览器**（无需 Tauri/Rust 后端）跑起来：
  - 新增 `src/lib/platform/web.ts`（`createWebPlatform`）：`executor.invoke` 用 **localStorage 持久化的 mock 后端**——核心笔记 CRUD（list/create/get/save/delete/move/page、workspaces、tags、search、templates、graph、attachments、sync/encryption）真实可用，其余命令**返回安全空值、绝不抛错**（UI 优雅降级）；dialog/opener/event/asset/webview 用浏览器原生驱动（`openUrl`→`window.open`、`convertFileSrc`→透传、event→EventTarget、drag-drop→no-op）。
  - `src/lib/platform/index.ts` 按环境**自动选择** `tauriPlatform`/`webPlatform`（探测 `window.__TAURI_INTERNALS__`），现有 Tauri 桌面行为不变。
  - 新增 `dev:web` 脚本（`vite --config vite.web.config.ts`，独立 5173 端口）。
  - **已在 Edge 无头浏览器验证**：app 真实挂载、渲染出种子页「欢迎页」并进入 Lexical 编辑器；`scripts/smoke-web.mjs` 22 项断言通过。

---

## [1.46.0] - 2026-08-24

### 重构

- **M16.0 存储/能力 driver 抽象（零行为变化）**：把全部 `@tauri-apps/*` 原生调用收敛到一个平台层，为「Web/ArkWeb/安卓/iOS 换壳」打地基（见[跨平台适配方案](docs/plans/2026-08-24-cross-platform-plan.md)）：
  - 新增 `src/lib/platform/`：`types.ts`（`Executor`/`DialogDriver`/`OpenerDriver`/`EventDriver`/`AssetDriver`/`WebviewDriver` 接口）、`tauri.ts`（**唯一**保留 `@tauri-apps/*` import 的模块）、`index.ts`（`platform` 聚合 + `setPlatform` 换壳入口）。
  - `api.ts` 的 ~60 个 `invoke` 命令改走 `platform.executor`，对外公开 API 不变。
  - 12+ 组件的内联 `@tauri-apps/*` 调用（dialog/open·save、opener/openPath·openUrl·revealItemInDir、event/listen、asset/convertFileSrc、webview/onDragDropEvent）改为消费 `platform` 驱动。
  - `tsc` 无错 + Vite 生产构建通过；现有桌面功能行为不变。

---

## [1.45.0] - 2026-08-22

### 优化

- **网址书签卡片编辑与交互完善**：
  - 卡片内嵌「✎ 编辑」按钮改为**悬停显示**（`opacity: 0 → 1`，`focus-within` 也显示），不再常驻遮挡，视觉更干净
  - 点击「✎」改用**全局 `inputDialog`** 输入新网址——避开 Lexical 装饰器组件重渲染导致按钮点击失效的问题，一次点击即可打开编辑框
  - 编辑框支持回车提交 / Esc 取消 / 自动聚焦
  - 修复「闪动」：元数据（标题/摘要/站点/预览图）直接**写入节点持久化**，重载不再重复抓取闪跳
  - 修复「不能打开」：改由 Tauri `openUrl` 打开外部链接（WebView 内禁 `window.open`）
  - 修复 `Cannot assign to read only property '__title'`：改用 `node.replace($createWebBookmarkNode(...))` 整体替换，不再写冻结字段
  - 卡片根节点与编辑按钮加 `onMouseDown` 阻止默认行为，避免 Lexical 抢走点击
- **直接输入网址后回车转换**：光标停在「只含一个 URL 的文本块」时按回车，自动转换成网址书签卡片（与粘贴转换一致）；气泡里也支持回车=转换 / Esc=关闭

### 变更

- `BookmarkPastePlugin` 新增 `KEY_DOWN_COMMAND` 处理：检测单个纯 URL 块并回车书签化
- 后端 25 项单测通过

---

## [1.44.0] - 2026-08-22

### 新增

- **文件管理视图一键多选 + 批量删除**：
  - 表头 checkbox 一键全选/取消全选（文件行）
  - 勾选多个文件后，工具栏「删除所选 (n)」按钮批量移除
  - 删除前有二次确认，并明确提示「移除后不再被任何页面/文件夹引用的文件，其磁盘存储也会被清除」
  - 单个「×」移除文件同样加了二次确认
- 新增后端 `remove_attachments(ids)` 批量命令（复用零引用清理逻辑）

### 变更

- `remove_attachment` 重构为内部复用的 `remove_attachment_inner`，批量命令逐个复用同一「仅当 hash 零引用才删除磁盘字节」规则
- 后端 25 项单测通过

---

## [1.43.0] - 2026-08-22

### 新增

- **网址书签卡片**：把 URL 插入为一张可打开的书签卡片（标题 / 摘要 / 站点名 / 预览图），抓取 Open Graph 元数据
  - `/wzsq`（或 `/bookmark`）斜杠菜单输入网址即插入书签；卡片异步抓取标题/摘要/预览图，点击打开链接
  - **粘贴 URL 转换**：粘贴纯网址时弹出气泡「转换为网址书签 / 保持链接形式」
  - 预览图**复用全局内容寻址附件库**（sha256 去重，可同步/备份），无新增存储
  - 抓取失败优雅降级：仅显示域名标题，不阻塞输入
- 新增后端 `fetch_bookmark_metadata` 命令（reqwest 抓 OG / title / description / site_name / og:image，超时 + 大小限制 + 非 2xx 降级）

### 变更

- 后端测试由 20 增至 **25 项**（新增 bookmark 元数据解析 / 实体解码 / hex / 图片 URL 解析 5 项）
- 新增 `WebBookmarkNode`（DecoratorNode）、`BookmarkPastePlugin`（PASTE_COMMAND 拦截 URL）

### 体验优化

- **数据库视图工具栏**：7 个视图按钮改用统一矢量图标 + 紧凑文字，右侧动作（PDF/视图/规则）视觉分组、右对齐；窄宽度可换行不溢出
- **侧边栏美化**：视图切换改分段控件；搜索框内嵌放大镜 + 胶囊「本空间/全空间」；树行图标统一 SVG（页面灰/文件夹橙/数据库紫）配彩色圆角块
- **视图/规则弹出菜单**：点击背景即可关闭（此前仅 add-col/options/board-group/sort 支持）
- **备份 vs 单空间迁移**文案区分：备份按钮明示「全库/覆盖全库」，空间切换器单独「单空间迁移」分组
- **新建菜单**文件夹描述改为「归类嵌套页面 · 也可存放文件」

---

## [1.42.0] - 2026-08-22

### 变更

- **依赖全面升级**（Rust / 前端均升至 crates.io / npm 最新，并适配破坏性变更）：
  - **后端**：
    - `rusqlite` 0.32 → **0.40.2**（bundled SQLite 升级；`Backup`/`Connection` 适配编译通过）
    - `zip` 2 → **8.6.0**（导出/备份/空间包读写适配）
    - `reqwest` 0.12 → **0.13.4**（`RequestBuilder::query` 移除，改为 URL 内联 query 串）
    - `sha2` 0.10 → **0.11.0**（`Output` 不再实现 `LowerHex`，改用自建 `hex_of` 编码）
    - `uuid` 1.24 → 1.25.0；tauri 2.11.5 / boa_engine 0.21.1 / chacha20poly1305 0.11.0 / argon2 0.5.3 / base64 0.23.1 已是最新
    - **注**：`rand_core` 保持 0.6——crypto 树（chacha20poly1305 0.11 / argon2 0.5）已是最新且锁定 `rand_core 0.6`，单独升 0.10 会引发 `OsRng`/`RngCore` 双版本冲突，故按依赖树正确锁定（非落后）。
  - **前端**：`@tauri-apps/api` 2.11.1 / `@tauri-apps/cli` 2.11.4 / `plugin-opener` 2.5.4 / `react`+`react-dom` 19.2.8 / `zustand` 5.0.15 / `@types/react` 19.2.18 等升至最新。
- 后端 20 项单测、`tsc` 无错、前端构建（156 模块）均通过；应用以新依赖正常启动（meta/default 空间数据完整）。

---

## [1.41.0] - 2026-08-22

### 新增

- **每工作空间独立存储（物理隔离，M15.3–M15.5，里程碑达成）**：
  - **单空间备份/导出（M15.3）**：`export_workspace` 把**当前空间**打包成自包含 zip（空间库快照 + 该空间引用的附件字节 + `workspace.json` 元数据）；`import_workspace` 导入为**新空间**（永不覆盖现有空间），抽取空间库到 `spaces/<id>.db`、附件字节复制进全局内容寻址库、注册 meta.workspaces
  - **跨空间适配（M15.4）**：
    - **全空间搜索跨库合并**：`search(all_spaces)` 遍历各空间库聚合结果（空间名在结果中标注）
    - **跨空间复制跨库**：`copy_page_to_workspace` 打开目标空间库插行（重映射父级 + 复制属性/标签/附件行 + 重建 FTS/块图 + 记录同步 upsert）；附件字节全局共享不重复
    - **空间清理按各自空间**：`purge_deleted_workspaces` 物理删除各软删空间库文件 + 释放跨空间孤儿附件
  - **验收 + 清理（M15.5）**：全功能回归（后端 20 项单测 + `tsc` 无错 + Vite 生产构建 + 应用运行验证）；**归档原单库 `shuyonote.db`** 为 `.archived`（可回滚恢复）
- 后端由 15 项单测增至 **20 项**（新增：空间包解析、跨空间引用哈希、`open_space_conn` 独立读非活动空间、第二空间创建 E2E）；编译 + 测试 + 前端构建通过

### 变更

- `db.rs`：新增 `open_space_conn(space_id)` —— 打开任意空间的独立连接（含 ATTACH meta），供跨空间搜索/复制/清理使用；`migrate(space_id)` 播种各空间自己的 `workspaces` 行
- `storage.rs`：`storage_stats` 的 `db_bytes` 改为统计 `spaces/*.db` 之和（原 `shuyonote.db` 已归档）；`deleted_workspace_count` 改读 `meta.workspaces`；`purge_deleted_workspaces` 重写为物理删除软删空间库
- `workspaces.rs`：`copy_page_to_workspace` 支持**跨空间**（此前仅同空间可用）；去重/清理跨空间复用 `open_space_conn`

### 说明

- **评估未做（可选/环境受限，已在路线图标注）**：M11.3 UI 型插件、M11.4 插件市场/签名（L2/L3 高阶，收益/风险与规模受限）；M6 移动端（缺 iOS/Android 工具链，环境受限）
- **取舍**：附件字节保持**全局内容寻址**（跨空间去重），以「空间级附件子集导出」实现单空间可搬移；E2EE 密钥与同步游标保持每空间

---

## [1.40.0] - 2026-08-22

### 变更

- **每工作空间独立存储（物理隔离，M15.2 命令层改造）**：物理隔离全面落地到命令层
  - **内容命令去掉 `workspace_id` 过滤**（每空间库单空间）：`list_pages` / `query_database` / `get_graph` / `get_backlinks` / `list_tags` / `pages_by_tag` / `board_data` / `list_deleted` / `search` 不再按 workspace 过滤，直接读当前空间库
  - **应用级状态归拢到 `meta`**：`device_id` / `server_url` / `token` 迁移到 `meta.sync_state`（跨空间共享，修复「每空间各自一个 device_id」的同步 bug）；插件启停 `plugin_enabled::{id}` 迁移到 `meta.plugin_state`；`templates` 全面落到 `meta.templates`
  - **同步游标 / E2EE 密钥保持每空间**：`last_pushed_seq` / `last_pulled_seq`、加密密钥（`encryption_*`）仍存于各空间库的 `sync_state`（每库单游标、每空间一钥，符合规划的每空间同步线/加密隔离）
  - **修复 `create_workspace` 的长期 FK bug**：`migrate()` 现在接收 `space_id`，为新建空间库播种**该空间自己的** `workspaces` 行；此前只播种 `'default'`，导致新建空间插入首页页时触发 `pages.workspace_id` 外键错误
  - **修复跨空间复制的静默写错库**：物理隔离期跨空间复制需要跨库 DML（M15.4 实现），现目标空间 ≠ 当前空间时明确报错「将在后续版本支持」，避免把页面写进当前库
- 后端由 15 项单测增至 **17 项**（新增：第二空间创建 + 首页插入 E2E、空间库接受自有 workspace_id 页面）；编译通过

### 说明

- **已知待办**：跨空间搜索聚合 / 跨空间复制（跨库 + 附件拷贝）/ 单空间导出、每空间清理，均为 **M15.3/M15.4**；「全空间搜索」的 `all_spaces` 标志暂按当前空间生效

---

## [1.39.0] - 2026-08-22

### 新增

- **每工作空间独立存储（物理隔离，M15.0 底座）**：把多空间从「单库 + 全局附件（逻辑隔离）」升级为「**每空间独立 SQLite 库**（物理隔离）+ 附件字节保持**全局内容寻址**」的结构
  - `meta.db`（应用级：workspaces / sync_state / templates / plugin_state）+ `spaces/<ws_id>/shuyonote.db`（每空间内容）+ 全局 `attachments/`（附件字节按内容寻址去重；「每空间附件目录」为原始提议，见 [per-workspace-storage-plan](docs/plans/2026-08-22-per-workspace-storage-plan.md) 实现落地说明）
  - `Db.0` 连**当前空间库**，`meta.db` 以 `ATTACH ... AS meta` 挂载——内容命令几乎不变，只把「空间/应用级」查询切到 `meta.*`
  - `active_workspace_id` / `create_workspace` / `set_active_workspace_id` / `delete_workspace` / `list_workspaces` / `rename` / `set_settings` / `get_workspace_name` 全部改为读写 `meta.*`；空间切换/创建/删除时**重开主连接**到目标空间库（`reopen_space`）
  - 旧库按用户要求**清理，不做迁移**：首启新建 `meta.db` + 默认空间库，旧 `shuyonote.db` 不再使用
- 后端 15 项单测、编译通过

### 变更

- `db.rs`：`meta_migrate` + `reopen_space` + `APP_DATA_DIR` 全局 + `init` 建立 meta/每空间库并 ATTACH
- `workspaces.rs`：空间命令切 `meta.*`
- **说明（待 M15.2+）**：内容命令仍保留 `workspace_id` 过滤（每空间库单空间，冗余但可用）；跨空间搜索/复制/单空间导出、`templates`/`sync_state`/`plugin_state` 全面落到 meta、去掉 `workspace_id` 列为后续阶段

---

## [1.38.6] - 2026-08-22

### 变更

- **删除工作空间成功后给 toast 提示**：`已删除工作空间「<名称>」`（删除后立刻反馈，避免误以为没反应）
- 纯前端；tsc + vite build 通过

---

## [1.38.5] - 2026-08-22

### 优化

- **删除/新增/切换/重命名/改设置工作空间不再卡 UI**：把 `list_workspaces` / `get_active_workspace_id` / `set_active_workspace_id` / `delete_workspace` / `create_workspace` / `rename_workspace` / `set_workspace_settings` / `get_workspace_name` 全部改为 **`async` 命令**（跑在 tokio 运行时，离开主线程）
  - 与之前备份「卡死」同类：同步命令在 Tauri 主线程执行，会让 UI 短暂冻结；转 async 后主线程永不阻塞
  - `delete_workspace` 内部改为用同一连接的同步 `active_workspace_id`，避免 async await 与已持有锁的死锁
- 后端 15 项单测、编译通过

---

## [1.38.4] - 2026-08-22

### 优化

- **删除/切换工作空间不再卡 UI**：此前每个页面行都渲染一个 `CopyPageAction` 并**订阅** `spaces/activeId/load`——删除或切换空间时 `spaces` 变化会触发**整棵页面树所有行**同步重渲染，页面越多越卡（大库甚至「卡死」）
  - 修复：`CopyPageAction` 改为**惰性获取**——仅在菜单打开时 `load()` + `listWorkspaces`/`getActiveWorkspaceId`，不再订阅全局空间状态；空间变化不再触发逐行重渲染
- 纯前端；tsc + vite build 通过

---

## [1.38.3] - 2026-08-22

### 变更

- **备份文件名嵌入空间名**：导出备份默认文件名由 `shuyonote-backup-<时间>.zip` 改为 `shuyonote-<空间名>-<时间>.zip`（对空间名做文件名字符清洗 / 空格转连字符 / 截断，含中文），便于按空间区分备份
- 纯前端；`api.getWorkspaceName()` 取当前空间名；tsc + vite build 通过

---

## [1.38.2] - 2026-08-22

### 修复

- **清空回收站仍失败的剩余外键**：除了 `pages.parent_id`，`database_columns.db_page_id` 也引用 `pages(id)`——删除回收站里的**数据库页**时，其列仍引用它 → FK 错误
  - 修复：级联删除新增 `DELETE FROM database_columns WHERE db_page_id = ?1`（`clear_trash` 与 `purge_deleted_workspaces` 均补）
  - 用真实库副本验证：83 个回收站页完整级联删除成功（剩余为在用空间页面）；后端 15 项测试全过（回归测试覆盖「数据库页 + database_columns」场景）

### 变更

- `storage.rs`：两处级联补 `database_columns` 清理
- **文档**：无 roadmap 变化（M14 已达成，bugfix）

---

## [1.38.1] - 2026-08-22

### 修复

- **清空回收站 / 清理软删工作空间的外键错误**：`pages.parent_id` 外键**无 ON DELETE CASCADE**，且应用开了 `foreign_keys=ON`——清空回收站按任意顺序删除页树时，删除父页会因其**仍被回收站内的子页引用**而触发外键约束错误（`清空回收站失败`）
  - 修复：删除前先在事务内**断开页树父子外键链接**（把回收站相关页的 `parent_id` 置 `NULL`），再删除，任意顺序都安全
  - 新增回归测试 `clear_trash_breaks_parent_fk_before_delete`（在开 FK 的库上软删父+子页→断链→删除成功；后端 15 项测试全过）

### 变更

- `storage.rs`：`clear_trash` / `purge_deleted_workspaces` 事务内先断父链再删除
- **文档**：无 roadmap 变化（M14 已达成，bugfix）

---

## [1.38.0] - 2026-08-22

### 新增

- **清理软删工作空间（M14.4 补全）**：「▦ 存储 / 空间管理」面板新增「清理软删工作空间（N）」——`purge_deleted_workspaces` 永久删除所有「已软删工作空间」及其**整棵页面树**
  - 事务内级联删除页面属性/标签/版本/反链/块/附件/FTS 行 + 工作空间行
  - 释放**零引用**附件字节（内容寻址差集）+ 返回「删除 N 个工作空间 / 释放 X」
  - 二次确认（提示先导出/备份）；仅对软删空间生效，不影响在用空间

### 变更

- 后端 `purge_deleted_workspaces`（返回 `{freed, workspaces}`）；前端面板新增对应按钮
- 后端 14 项单测、tsc、vite build 通过
- **文档**：路线图 M14.4 补记「软删工作空间物理清理」已实现

---

## [1.37.0] - 2026-08-22

### 新增

- **空间清理 / 存储管理（M14）**：侧边栏「备份」旁新增「▦ 存储 / 空间管理」面板——展示各分项占用 + 安全清理，遵循「只清真孤儿、零引用才删、可恢复性优先」
  - **M14.1 空间统计**：`storage_stats` → 数据库 / 附件（个数+大小）/ 回收站 / 版本历史 / 软删空间 / 临时文件 各分项（长任务 `spawn_blocking`，UI 不卡）
  - **M14.2 清空回收站**：`clear_trash` 物理删除软删页面树 + 级联属性/标签/版本/反链/块/附件，并释放零引用字节（事务内级联 + 二次确认 + 释放量提示）
  - **M14.3 清理孤立附件**：`cleanup_orphan_attachments` 删除「hash 无任何引用」的磁盘字节（内容寻址差集）
  - **M14.4 清理版本/临时**：`cleanup_old_versions`（每页保留最近 50 份，`ROW_NUMBER` 窗口函数）+ `cleanup_temp_files`（备份/恢复临时目录 + `.part` 上传残留）
  - 所有清理均二次确认 + 返回「释放 X」；前端忙碌态禁用按钮

### 变更

- 新增 `src-tauri/src/storage.rs`（`storage_stats`/`clear_trash`/`cleanup_orphan_attachments`/`cleanup_old_versions`/`cleanup_temp_files`）+ `src/components/StoragePanel.tsx` 面板
- 后端 14 项单测、tsc、vite build 通过
- **文档**：路线图 M14 标记已实现（14.1–14.4）

---

## [1.36.0] - 2026-08-22

### 新增

- **每空间主题色可自定义（M10.3b 收尾）**：空间切换器里每个空间项新增**颜色按钮**（当前色小圆点）——点击展开 8 色调色板，选色即改该空间主题色（`set_workspace_settings`），侧边栏顶部与切换器色点/首字同步更新；当前色高亮、选中态描边。
- 颜色按钮遵循反 AI 味（用色点而非 emoji 图标）；选中色有 `--accent-soft` 描边反馈。

### 变更

- 纯前端；复用上一版 `set_workspace_settings`；tsc + vite build 通过
- **文档**：路线图 M10.3b 补记「每空间颜色可自定义」已完成

---

## [1.35.0] - 2026-08-22

### 新增

- **工作空间增删改补全（M10.2b / M10.3b）**：
  - **种子默认首页**：新建工作空间时自动生成一棵「开始」首页（不再是纯空白），并设为活动空间。
  - **空间主题色**：每个空间分配一个主题色（自动从 8 色调色板按创建顺序取）；侧边栏顶部空间名与切换器里的空间项均以该色高亮（色点 + 首字）。
  - **按 id 重命名**：空间切换器里每个空间项新增「✎ 重命名」→ 行内输入改名（`rename_workspace(id, name)`）；支持改非当前空间；顶部双击空间名仍是重命名当前空间。
  - **删除前导出提醒**：删除工作空间确认弹窗提示「建议先导出/备份」。
  - **空间级设置命令**：`set_workspace_settings(id, theme/icon/sort_order)`；`WorkspaceMeta` 暴露 `theme/icon/sort_order`；空间按 `sort_order` 排序。
  - 后端新增 `set_workspace_settings` 命令；`rename_workspace` 改为按 id；`create_workspace` 种子首页 + 主题 + 排序。

### 变更

- 切到某空间后若改/删非当前空间，不影响当前；`WorkspaceMeta` 与切换器反映主题/排序/重命名。
- 后端 13 项单测通过；tsc + vite build 通过。
- **文档**：路线图 M10.2b/M10.3b 标记已实现主体；CHANGELOG 记录。

---

## [1.34.0] - 2026-08-22

### 优化

- **备份导出 / 恢复不再卡死**：导出与恢复此前是**同步命令**，在 Tauri 主线程上执行，附件越多/越大界面越像冻结；现改为 `async` + `spawn_blocking`，主线程与 UI 保持响应
- **流式文件读写**：附件不再整块 `std::fs::read` 进内存，改用 `std::io::copy` 边读边压缩/解包——大文件不撑爆内存、速度更快
- **实时进度反馈**：后端在导出/导入期间发出 `backup-progress` 事件（阶段/文件数/字节），前端以底部进度条展示（含百分比与阶段提示、无限进度动画），期间按钮置忙、无法重复触发
- 临时快照/解包目录仍做清理；数据库快照与恢复经 rusqlite 在线备份 API（WAL 下保持一致）

### 变更

- `backup.rs`：`export_backup`/`import_backup` 改为 `async`；新增 `BackupProgress` 与 `backup-progress` 事件；`add_dir_to_zip`/`extract_backup` 流式化
- `BackupButton.tsx`：监听进度事件 + 进度条 + 忙碌态
- 后端 13 项单测通过；tsc + vite build 通过
- **文档**：README 不做改动，体验优化见 CHANGELOG

---

## [1.33.1] - 2026-08-22

### 修复

- **数据库查询按工作空间隔离（M10 红线）**：`query_database` 的基础页面查询此前**不带工作空间过滤**，多空间下会串空间——数据库页会显示其他空间的页面。现改为按**数据库页所属工作空间**收窄作用域（`AND workspace_id = ?`），与 `list_pages`/标签/回收站/搜索/关系图/反链 的 M10.3 隔离策略对齐
  - 修复后：只呈现「同工作空间」的页面；规则匹配（`db_rule`）与属性/标签命中均在此基础上进一步过滤，跨空间 id 被自然排除
  - 无前端改动，后端 13 项单测通过

### 变更

- **文档**：路线图 M10.3 补记数据库查询按空间过滤已完成（此前遗漏项）

---

## [1.33.0] - 2026-08-22

### 新增

- **文件历史版本（M12.3b）**：文件管理器对**同名文件**分组——重新上传同名（不同内容）文件时，旧内容按内容寻址保留，作为「历史版本」；文件行新增 「↻ 版本」按钮打开版本弹层
  - 后端 `restore_attachment(target_page_id, source_id)`：把某个历史版本**克隆为最新当前文件**（`INSERT` 新行，同 hash，内容寻址字节共享，不复制字节），并刷新列表
  - 前端 `FileManagerView`：按文件名分组（最新为当前，其余为版本）+ 版本弹层，逐版本显示大小 / hash（`#xxxx`）+「恢复」按钮；当前版本高亮
  - 也适用于页面附件库（附件模型统一）

### 变更

- `api.restoreAttachment`；文件表格改为同名单行 + 版本指示
- 说明：复用的是内容寻址去重（旧 hash 永不因引用而删除），无需新表即得版本能力
- **文档**：路线图 M12.3b 文件版本标记已实现

---

## [1.32.0] - 2026-08-22

### 新增

- **插件可往页面插入内容（M11 L1 增强）**：为受限插件运行时新增 `__insert(text)` 白名单 API——插件在 `run()` 里调用即可把文本插入当前页面
  - 后端 `run_plugin_command` 返回 `{message, insert}`（`PluginRunResult`）；`RunState` 记录 `insert_text`
  - 前端命令面板：运行磁盘插件命令后，若返回 `insert`，在光标处（或页面末尾）插入该文本段落，并聚焦
  - 内置示例插件新增「插入文本」命令演示；新增 Rust 单测 `collect_insert_request_from_plugin`（共 13 项通过）
  - 安全面不变：插件仅能经 `__insert` 生成文本，不经此 API 无法触碰编辑器/写入任意内容

### 变更

- `api.runPluginCommand` 返回对象；`CommandPalette` 接入 `insert`（`$createParagraphNode` + `$createTextNode`）
- **文档**：路线图 M11 补记「插件可插入内容（`__insert`）」已实现

---

## [1.31.0] - 2026-08-22

### 新增

- **导出工作空间为 Markdown（数据可移植性强化）**：命令面板（Ctrl+K）新增「导出工作空间为 Markdown」——选择目录后，把当前工作空间的**所有页面**批量导出为 `.md` 文件（每页一文件，文件名取标题、非法字符清洗、去重）
  - 用 offscreen `createEditor` + `$convertToMarkdownString`（`SHUYONOTE_TRANSFORMERS`）复用与单页一致的 Markdown 保留往返，无需打开页面
  - 文件头部写入注释元信息（title / id），导出后天然可 git / 任意编辑器可读——兑现「数据主权 / 可移植」价值主张（本地优先的最终保障：你的内容永远能离开）

### 变更

- 命令面板「导出」插件新增命令；新增 `src/lib/exportMarkdown.ts`（headless 转换 + 写文件）
- 说明：文件引用卡片等富文本节点在 Markdown 中以纯文本（文件名）兜底；附件字节不随 Markdown 导出（如需完整备份可用整库备份）
- **文档**：路线图补记「Markdown 批量导出（M1 可移植性增强）」已实现

---

## [1.30.0] - 2026-08-22

### 新增

- **数据库页 PDF 导出（M5 后续项）**：数据库页头部新增「⤓ PDF」按钮——把**当前（已筛选/已排序）视图**渲染为 HTML 表格并触发系统打印（另存为 PDF），补齐「数据库页 PDF 为后续项」
  - 抽取 `src/lib/print.ts`（`printHTML` / `printDoc` / `docHtml`）供页面与数据库共用；`EditorToolbar` 改为复用
  - 导出表格含「页面」+ 各列，公式 / 统计（rollup）列按前端计算值展示，ref 列显示目标标题
  - 遵循「视图 = 配置，不是数据」：导出的是视图的当前呈现，不影响底层属性

### 变更

- 数据库（表格视图）适配：导出内容为当前 `rows`（尊重筛选/规则/排序）
- **文档**：路线图 M5 补记「数据库页 PDF」已实现

---

## [1.29.0] - 2026-08-22

### 新增

- **跨空间复制页面（M10.4b）**：把某个页面（及其子页面树）复制到**另一个工作空间**——侧边栏页面行新增「复制到其他工作空间」按钮，弹出目标空间选择器
  - 后端 `copy_page_to_workspace(page_id, target_workspace_id, new_parent_id)`：递归复制子树为**全新页面 id**，重设目标空间与父级；复制页面属性（`page_props`，全局 `attr_defs`）、标签（`page_tags`）、附件行（内容寻址字节共享，去重不复制字节）
  - **块图保持空间内**：保留 blockId，子树内部块引用/嵌入仍解析；引用子树外块的引用在目标空间不解析（符合「块图不跨空间」红线，文档明示）
  - 复制后为新页重建 FTS 索引 + 块图/反链，并记录同步 upsert 以便服务端收敛
  - 前端 `api.copyPageToWorkspace` + 侧边栏「⇄ 复制到…」下拉（自动排除当前空间）

### 变更

- 说明：跨空间复制当前落到目标空间**根目录**（`new_parent_id=null`）；插入指定父级为后续项
- **文档**：路线图 M10.4b 跨空间复制页面标记已实现

---

## [1.28.0] - 2026-08-22

### 新增

- **文件引用到页面（M12.3a）**：页面可通过斜杠菜单 `/文件引用` 插入一个**文件引用卡片**——在正文中直接呈现某个文件（名称 / 大小 / 类型图标），点击即可用系统默认应用打开
  - 「文件是一等公民」：文件既是文件夹/网盘的资产，也可作为可见卡片被页面引用（引用 = 共享同一条附件记录 + 内容寻址，不复制字节）
  - 新增 `AttachmentRefNode`（块级装饰器卡片，serialize 存元数据快照，渲染同步无异步 fetch；monoline SVG 文件图标，不用 emoji）
  - 后端 `get_attachment(id)` 命令解析附件元信息与本地路径；前端 `api.getAttachment`
  - 头部附件库与网盘文件统一走 `import_attachment_files`，内容寻址去重不变

### 变更

- Editor 节点注册、斜杠菜单「媒体」组新增「文件引用」；App.css 增加文件卡片样式
- 说明：文件卡片为富文本节点，Markdown 往返时以纯文本（文件名）兜底
- **文档**：路线图 M12.3 文件引用到页面标记已实现

---

## [1.27.0] - 2026-08-22

### 新增

- **全空间搜索（M10.4a）**：搜索框新增「本空间 / 全空间」切换——跨所有工作空间全文搜索（FTS / LIKE / `prop:` 过滤均适用）
  - 后端 `search` 增加 `all_spaces` 参数：传 `true` 时忽略活动空间过滤，结果按 `workspace_id` 关联显示所属空间名（`SearchResult.space`）
  - 前端 `SearchPanel` 增加空间切换按钮与结果空间徽章；`api.search` 增加 `allSpaces` 参数
  - 默认仍限定当前空间，切换「全空间」后一次检索全部工作空间（多空间隔离仍保留）

### 变更

- `SearchArgs` 增加 `all_spaces`；`SearchResult` 增加可选 `space` 字段（跨空间模式填充）
- 搜索 SQL 按 `all_spaces` 动态拼接：有工作空间过滤时绑定 `(ws, query, limit)`，否则 `(query, limit)`，并用 `params_from_iter` 传递可变长度参数
- **文档**：路线图 M10.4 全空间搜索标记已实现

---

## [1.26.0] - 2026-08-22

### 新增

- **端到端加密 UI + 会话锁定解锁（M2 后续项）**：把 M2 的加密原语从「仅有后端命令」补全为**设置面板可操作**的端到端加密
  - 主题设置弹层新增「端到端加密」区块：开启（输入口令，>8 位）/ 关闭 / 状态徽章（未开启 / 已加密-同步加密 / 已加密-会话已锁定）
  - **口令解锁/锁定**：`lock_encryption` / `unlock_encryption` 命令——锁定后同步被拒（`sync_gate`），须输入口令重新解锁才能继续加密同步；口令经盐值 Argon2id 派生，用校验密文（sentinel）验证，密钥仅存本机，不落盘
  - 同步 `push`/`pull` 在「已加密但会话锁定」时拒绝发送/接收明文（不静默降级）

### 变更

- `encryption_status` 增加 `locked` 字段；`set_encryption` 写入校验密文（`encryption_verify`）
- 新增 Rust 单测：口令校验（verify sentinel）往返 + 锁定门控密钥与同步（12 项全部通过）
- **文档**：路线图 M2 补记「设置面板 UI 与口令解锁/锁定」已实现

---

## [1.25.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.5 跨库统计 rollup 列）**：新增「统计」列类型——数据库表格可**引用另一数据库的行并聚合**
  - 加列时选「统计」并输入 JSON 配置：`{"ref":"专题","db":"项目库","col":"工时","fn":"sum"}`（`ref`=本库指向目标库的引用列名，`db`=目标数据库标题，`col`=目标库被聚合的数字列名，`fn`=count / sum / avg）
  - 目标库中，凡是引用列匹配当前行（`ref` 值包含本行页面 id）的行，按 `fn` 聚合其 `col` 数值，只读展示

### 变更

- 加列对话框支持统计类型与 JSON 配置输入；数据库表格渲染统计列（跨库实时取数）
- 前端只读聚合，不引入 eval；计数 fallback 显示行数，无匹配显 `—`
- **文档**：路线图 M13.5 标记已实现

---

## [1.24.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.4 公式列）**：新增「公式」列类型——数据库表格可添加**计算列**
  - 加列时选「公式」并输入表达式（如 `数量*单价` 或 `总分/人数`），表达式引用同行的其他数字列（按列名）
  - 前端用**受限算术解析器**（`+ - * / ( )` 与数字，不用 `eval`）计算每行值，只读展示；跨行汇总（M4 汇总条）沿用

### 变更

- 加列对话框支持公式类型与公式输入；数据库表格渲染公式列
- **文档**：路线图 M13.4 标记已实现；**M13 数据库=透镜里程碑达成**

---

## [1.23.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.3b ref ↔ 关系图贯通）**：`ref` 类型的属性值（`p:<页面id>`）现在也是**关系图的一条边**——`get_graph` 把 ref 属性值并入页面级边（kind=`ref`），数据库引用与图谱打通

### 变更

- `get_graph` 页面级边纳入 ref 属性引用（去重：已有边时按优先级取 `ref`）
- **文档**：路线图 M13.3 补充「ref→图边」已实现

---

## [1.22.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.3 ref 关联属性）**：`ref` 作为数据库列类型（引用「引用」列）
  - 后端 `resolve_refs`：把 `p:<page_id>` 解析为目标页面标题
  - 数据库表格中 `ref` 列以**可点击链接**展示（显示目标标题，点击跳转打开页面）；失效引用显示「已失效引用」

### 变更

- DatabaseView 支持 `ref` 列类型 + 点击跳转；属性列类型新增「引用」
- **文档**：路线图 M13.3 标记已实现；注：ref 作为**关系图/反链的一条边**（图谱贯通）为后续小项

---

## [1.21.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.2 查询型数据库）**：数据库页可设「成员规则」——按属性值（select/multi/tag 列）自动收页
  - 后端：`pages.db_rule` 列 + `set_db_rule`/`get_db_rule`；`query_database` 应用规则（`{prop:{name,value}` / `tag` 条件，AND 交集），未设规则则视为全部页面（与现状一致）
  - 前端：工具栏「规则 ∿」→ 选属性列 + 匹配值 → 应用/清除；数据库列表按规则过滤

### 变更

- 数据库从「全部页面」支持「按规则自动收页」（查询型/派生数据库）；未设规则行为不变
- **文档**：路线图 M13.2 标记已实现

---

## [1.20.0] - 2026-08-22

### 新增

- **数据库 = 透镜（M13.1 多保存视图）**：数据库页工具栏新增「视图 ▾」——列出已保存视图、点击应用、删除、并可「保存当前视图」
  - 每个保存视图记录 `{view_type, filter, sort, board_group_attr}` 配置（JSON），存于 `db_views` 表
  - 后端 `save_db_view` / `list_db_views` / `delete_db_view`；数据库模板建库后可保存多套视图
- 新增 `db_views` 表 + `DbViewMeta` 模型

### 变更

- DatabaseView 支持多视图保存/切换/删除；视图配置随库持久化
- **文档**：路线图 M13（数据库贯通）新增，M13.1 标记已实现

---

## [1.19.0] - 2026-08-22

### 新增

- **文件夹 = 网盘（M12.2 拖拽 + 移动）**
  - **拖拽上传**：拖 OS 文件进打开的文件夹 → 直接上传（Tauri `onDragDropEvent`，复用流式进度；拖入时显示「松开上传」提示层）
  - **文件跨夹移动**：文件行「↔ 移动到」→ 弹出文件夹列表，选目标夹即移动（后端 `move_attachment` 更新 `attachments.page_id`，目标夹必须存在）
- 后端新增 `move_attachment`；文件行操作扩为「移动/预览/下载/显示/移除」

### 变更

- FileManagerView 复用 `importPaths` 处理对话框上传与拖拽上传；新增拖拽提示层与移动弹层
- **文档**：路线图 M12.2 标记已实现

---

## [1.18.0] - 2026-08-22

### 新增

- **文件夹 = 网盘（M12.1 核心网盘 UX）**
  - **文件搜索**：文件管理工具栏加搜索框，按文件名过滤
  - **每夹统计**：「N 个文件 · 共 X · M 项」实时统计
  - **在线预览**：文件行「👁 预览」→ 弹窗按类型内嵌（图片/视频/音频/PDF，复用 `convertFileSrc` 本地路径；超大文件不整块进内存）；不支持的类型提示用系统打开
  - **下载**：文件行「⬇ 下载」→ 选择保存位置，后端 `copy_attachment` 复制文件
- 后端新增 `copy_attachment`（按 hash 复制到目标路径）

### 变更

- FileManagerView 文件行操作扩展为「预览 / 下载 / 显示 / 移除」
- **文档**：路线图 M12（文件夹=网盘）新增，M12.1 标记已实现

---

## [1.17.0] - 2026-08-22

### 新增

- **端到端加密同步（M2.2，默认关闭）**：把 M2.1 加密原语接入同步——
  - 新增 `security.rs`：`set_encryption`（口令+盐派生密钥，落 `sync_state`）、`encryption_status`、`disable_encryption`；密钥/盐经 base64 存于本机（服务端永远拿不到密钥）
  - **同步加密钩子**：`push` 前把页面变更 `payload` 加密（`base64(nonce||密文)`），`pull` 后解密再解析——服务端存密文、不可读
  - 默认关闭：未启用时纯透传（零行为变化）；启用后每变更载荷认证加密
- 引入 `base64` 依赖
- 前端 `api`：`setEncryption` / `encryptionStatus` / `disableEncryption`
- 验证：`cargo test` 全量 **10 通过**（含 `payload_roundtrip_when_enabled` / `payload_passthrough_when_disabled`）

### 说明

- 加密为应用级开关（每工作空间可用 `set_encryption` 启用）；设置面板开关 UI 与「口令解锁/锁定」为后续项；自建 sync-server 的端到端往返未在本环境跑（无服务器），加密/解密路径经单测验证。

---

## [1.16.0] - 2026-08-22

### 新增

- **端到端加密地基（M2.1）**：新增 `src-tauri/src/crypto.rs`——
  - **密钥派生**：Argon2id 从口令 + 盐派生 256-bit 密钥
  - **认证加密**：XChaCha20-Poly1305（24 字节 nonce 独立随机），密文格式 `nonce(24) || ciphertext`
  - 3 个 Rust 单元测试通过（加解密往返、同盐确定性、错误密钥拒绝）
- 引入 `chacha20poly1305` / `argon2` / `rand_core` 依赖

### 说明

- M2.1 为加密原语地基；**M2.2** 将把加密接入同步（outbox 上传前加密、拉取后解密、每工作空间独立密钥），尚未完成。

---

## [1.15.0] - 2026-08-22

### 新增

- **插件管理面板（M11.2）**：命令面板「管理插件」打开插件管理——列出本地插件（名称/版本/描述/命令数），**启用/禁用**、**卸载**、**从文件夹安装**（复制插件目录进插件库）、**打开插件目录**
- 后端命令：`uninstall_plugin`（卸载）、`install_plugin`（从目录安装 + manifest 校验 + 递归复制）、`open_plugin_dir`（在文件管理器打开插件目录）
- 命令面板新建`插件`内置插件，含「管理插件」命令

### 变更

- `usePlugins` 扩展：`uninstall`/`install`/`openDir`/`managerOpen`；插件管理系统化
- **文档**：路线图 M11.2（管理生命周期）标记已实现

### 说明

- `activate/deactivate` 语义由「启用/禁用」承担；UI 型插件（L2，M11.3）与市场（L3，M11.4）仍为可选项。

---

## [1.14.0] - 2026-08-22

### 新增

- **插件系统底座（M11.1）**：从本地插件目录加载**命令插件**——
  - 插件目录：`<appdata>/plugins/<id>/`，含 `manifest.json`（校验 `id==目录名`、`main` 必须同级文件名）+ `main.js`
  - **受限 JS 运行时**（`bona_engine`，纯 Rust 沙盒）：插件在主程序里以受限 `register()`/`__get_current_page()`/`__pages()`/`__toast()` 白名单 API 执行，无任意 `fs`/DOM/网络
  - 命令插件注册的命令进入**命令面板**（分组「插件」），点击执行并返回结果；支持启用/禁用
  - **启用状态持久化**：插件启停落库（`sync_state`，修复此前内存态重启即失）
  - 内置**示例插件**（首次运行 seed 到插件目录）；`list_plugins` / `set_plugin_enabled` / `run_plugin_command` 命令
- **验证**：新增 2 个 Rust 单元测试跑通 boa 执行管道（`runs_a_command_and_reads_page_count` / `reports_missing_command`）

### 变更

- 引入 `boa_engine` 依赖（纯 Rust JS 引擎）；`CommandPalette` 合并磁盘插件命令
- **文档**：路线图 M11.1（插件底座）标记已实现；插件管理面板（M11.2）仍待做

### 说明

- 插件的 `toast` 暂经 stderr 输出，UI toast 桥接归入后续；`__get_current_page` 已填充当前页 JSON。

---

## [1.13.0] - 2026-08-22

### 新增

- **数据库模板**：模板新增 `kind='database'` 类型，内置「内容管理库」「观影清单」两个**数据库模板**——从模板**一键创建数据库页并预设列**（文本 / 单选 / 数字 / 日期，含下拉选项）
- 从数据库模板建库时逐列 `create_attr` + `add_db_column` 预设结构（复用现有属性与 `database_columns` 存储，无新增依赖）

### 变更

- 模板中心支持数据库模板：点击卡片按 `kind` 建普通页面或数据库；卡片以「数据库模板」区分
- **文档**：路线图 M9.2b（数据库模板）标记已实现；**M9 模板里程碑达成**

---

## [1.12.0] - 2026-08-22

### 新增

- **模板变量**：从模板建页时把 `{{date}}` 占位符替换为当天日期（`YYYY-MM-DD`）（如「每日小记」模板自动填入日期）
- **模板导入**：模板中心头部「⬆ 导入」——选择 `.shuyo-template.json` 文件解析并加入「我的模板」
- **模板导出**：用户模板卡片悬停出现「⬇ 导出」——保存为 `.shuyo-template.json`，便于分享/备份

### 变更

- 模板中心头部新增「导入」按钮；用户模板卡片增加导出/删除两个操作
- **文档**：路线图 M9.3（共享打磨）标记已实现；`preprocessMarkdownImport` 等不受影响

### 说明

- 模板「图标/封面去 emoji」暂未单独处理；M9.2b（数据库模板 `database_json`）仍待做。

---

## [1.11.0] - 2026-08-22

### 新增

- **多工作空间隔离收尾（M10.3）**：把内容查询全部改为**按活动空间过滤**，切换空间后各视图不再混入其他空间的内容——
  - **回收站**：`list_deleted` 只显示当前空间的已删除页面（每空间独立回收站）
  - **标签**：`list_tags` 的「使用页数」、`pages_by_tag`、`board_data` 看板只统计/展示当前空间页面
  - **全文搜索**：`search`（FTS/LIKE/无过滤）只返回当前空间页面
  - **关系图**：`get_graph` 的页面节点与标签仅限当前空间
  - **反链**：`get_backlinks` 只返回当前空间的来源页面
- **共享活动空间助手**：`workspaces::active_workspace_id(&conn)` 提取为统一的 `&Connection` 助手，供各查询模块复用（消除重复逻辑）

### 变更

- `commands.rs` 改用共享的活动空间助手；各内容查询模块 `WHERE workspace_id = 活动空间`
- **文档**：路线图 M10（多工作空间）M10.1/M10.2/M10.3 全部标记已实现；多工作空间里程碑达成

### 说明

- M10 里程碑至此完成（隔离 + 切换 + 生命周期 + 每空间内容过滤）。

---

## [1.10.0] - 2026-08-22

### 新增

- **删除工作空间（生命周期）**：空间切换器中非当前空间可**删除**（悬停出现删除按钮）——二次确认后**软删除**（`workspaces.deleted_at`），内容保留可恢复
- **活动空间自动回退**：若删除的是当前活动空间，`get_active_workspace_id` 自动回退到最早的未删除空间，应用切换过去而不是停留在失效空间
- **软删除列迁移**：`workspaces` 表新增 `deleted_at`（幂等 `ALTER TABLE`），兼容既有数据库

### 变更

- `list_workspaces` 过滤已删除空间；`get_active_workspace_id` 校验持久化活动空间未被删除，失效则回退并重写
- **文档**：路线图 M10.2 标记已实现（软删 + 确认 + 自动回退）；`export_workspace`、`rename_workspace(id)` 为 M10.2 后续项（M10.2b）

### 说明

- `export_workspace`（按空间导出备份）与 `rename_workspace`（显式指定空间）归入 M10.2b，暂未实现。

---

## [1.9.0] - 2026-08-22

### 新增

- **多工作空间（M10.1 隔离底座）**：应用从单空间升级为**多空间**——侧边栏新增「工作空间切换器」（空间名右侧 ▾），可列出全部空间、新建工作空间、一键切换
- **工作空间命令**：后端新增 `list_workspaces` / `create_workspace` / `get_active_workspace_id` / `set_active_workspace_id`；`workspaces` 表本已存在，本次接入活动空间状态（持久化于 `sync_state`）
- **页面按空间隔离**：`list_pages` 改为**按活动空间过滤**（修复此前不按 `workspace_id` 过滤、加入第二空间会混内容的隐患）；`create_page` / `create_node` 写入活动空间
- **空间切换动作**：切换空间后自动重载页面树；若当前页不在新空间中则自动清空选中（侧栏/自动打开回落到新空间首页）

### 变更

- `get_workspace_name` / `rename_workspace` 从「操作第一个空间」改为**操作当前活动空间**
- 模板中心的「我的模板」按空间归属（`templates.space_id`），切换空间后只显示本空间模板
- **文档**：路线图 M10（多工作空间）进入 M10.1；说明 tags/回收站/搜索/关系图的按空间过滤归入 M10.3

### 说明

- M10.1 当前完成「页面树 + 新建 + 切换」的空间隔离；tags / 回收站 / 全文搜索 / 关系图的按空间过滤归入 M10.3（每空间隔离收尾）。

---

## [1.8.0] - 2026-08-22

### 新增

- **保存为模板（"我的模板"）**：命令面板新增「保存当前页为模板」——把当前页面结构（`content_json`/`content_text`）保存到「我的模板」，存入数据库
- **模板持久化**：新增 `templates` 表（Rust 端），`list_templates` / `save_as_template` / `delete_template` 命令；用户模板落库、可跨会话保留，可删除
- **模板中心整合"我的模板"**：模板中心把内置模板与用户的「我的模板」合并展示；「我的模板」页签下可删除自建模板（卡片悬停出现删除按钮）
- **模板分类标注**：用户模板在卡片上标注「我的模板」，与内置「ShuyoNote · 模板」区分

### 变更

- 模板中心卡片从 `<button>` 改为可容纳删除按钮的容器，删除按钮使用主题危险色
- **文档**：路线图 M9.2（保存为模板 + 我的模板 CRUD）标记为已实现；`templates` 表 / `create_page_from_template` 落地为 DB `templates` 表 + 命令

### 说明

- 数据库模板（`database_json` 预设列/视图）为 M9.2 后续项，暂未实现。

---

## [1.7.0] - 2026-08-22

### 新增

- **模板建页填内容**：模板中心中的内置模板（个人/工作/教育/健康）现在携带真实的 Lexical 内容（`content_json` / `content_text`），点击模板卡片即可**新建一个带真实内容的页面**（标题/段落/列表/引用/分隔线），不再是空白页
- **模板入口打通**：新页面引导层「从模板中心创建」由占位 toast 改为**打开模板中心**；模板中心分类页签补齐「全部 / 健康」，消除「健康」类模板被过滤隐藏的问题
- **建页内容注入**：后端 `create_page` 支持可选 `content_json`（语义化注入块内容）与 `content_text`（用于 FTS 全文检索），模板建页后内容可被搜索

### 变更

- 模板数据从「纯 UI 骨架」升级为「结构性内容模板」：内置模板在 `src/templates/index.ts` 中以标准 Lexical 节点构建（标题/段落/无序列表/引用/分隔线），保证内容合法可渲染
- **文档**：路线图 M9「模板」的 M9.1（建页填内容）标记为已实现；路线图新增「模板 / 多工作空间 / 插件」三条线路，对应方案文档见 `docs/plans/`

---

## [1.6.0] - 2026-08-22

### 新增

- **鼠标框选多块**：在正文拖出矩形框即可选中框内全部顶层块（支持任意方向/起点拖拽），选中块以主题色柔和底高亮；`⋮⋮` 手柄 / `Shift` 连续选择 / `Delete` / `Esc` 保留
- **块多选右键上下文菜单**：框选或点多选后，右键任意所选块弹出「已选 N 块 / ⧉ 复制 / 🗑 删除 / 取消」；右键不放宽不误清选区，点背景关闭整个菜单
- **应用内确认弹窗**：删除 / 彻底删除 / 恢复版本 / 导入备份 / 删除标签等二次确认改为窗口居中的 `ConfirmDialog`（替换原生 `confirm()`），主题卡片样式，危险操作以红色 `!` 徽标提示、确定按钮用主题强调色，与主题暗合
- **模板中心 UI 骨架**：侧边栏底部「模板中心」入口 + 模板画廊网格（MockPreview 缩略图 / 分类页签 / 右上搜索），点击卡片创建新页
- **分隔线原地插入**：斜杠菜单「/分隔线」与 Markdown `---` 均**原地替换**当前块为分隔线，并在其后补一个可继续输入的空块（不再多出一块）；`--- + 回车`或`--- + 空格`均可触发
- **模板图标重绘**：侧边栏模板中心与新页面「从模板中心创建」改用干净的布局线图标（替换原 emoji），与回收站图标风格统一

### 修复

- 斜杠菜单插入分隔线多出一块：由 `INSERT_HORIZONTAL_RULE_COMMAND` 默认行为改为原地替换（替换当前块 + 补空块），并清理 `/fg` 触发文本残留
- Markdown `---` 回车不转换：给 `HORIZONTAL_RULE` 补 `triggerOnEnter`，回车 / 空格均能触发分隔线
- 块多选右键调不出菜单：右键 `mousedown` 不再清空选区，命中判断改宽到编辑器区域（不依赖高亮类时序）

### 变更

- **主题配色暗合**：确认弹窗「确定」按钮统一使用主题强调色（不再单独红色），红色 `!` 徽标表意危险；弹窗卡片底色 / 遮罩 / 图标徽标贴合主题
- **文档**：路线图「现状」补充块框选多选、应用内确认弹窗、模板中心骨架、分隔线原地插入等；文档体系索引中的变更记录链接指向 `v1.6.0`

---

## [1.5.0] - 2026-08-22

### 新增

- **文件管理视图**：新增全局「文件」视图，从侧边栏点文件夹进入——标题+图标、面包屑、文件表格（文件名/类型/大小/上次修改/创建时间）、批量选中，右侧「新建文件夹 / 新建页面 / 上传文件」
- **文件夹文件上传**：文件夹内批量上传超大文件（内容寻址流式存取，进度条），以文件列表行展示并支持打开/定位/移除；上传后侧边栏同步刷新
- **侧边栏文件**：文件夹下上传的文件在侧边栏树中随文件夹显示（图标+文件名，点击打开）
- **标签管理**：侧边栏「标签管理」入口——全局标签库（列出全部标签+使用页数、新建、重命名（同名自动合并）、全局删除）；标签筛选自动同步
- **块多选与批量删除**：点击块 `⋮⋮` 手柄选中（Shift 选连续范围），右上批量操作条（复制/删除），`Delete`/`Esc` 快捷键，选中块高亮
- **Markdown 导入增强**：导入前 HTML→Markdown 预处理（README 等源码不再泄漏）、保留图片 `width/height`、超大图片限宽限高+居中+断图占位
- **导入保存可靠性**：`parseEditorState` 放宽以保留有块内容；待保存改动在切页/关闭时落盘不再丢弃；保存失败弹「保存失败」提示
- **属性面板 Notion 风格统一**：标签作为属性行呈现（`TagRow` 芯片 + 单标签移除）；属性面板底部「＋ 添加标签 / ＋ 添加属性」同款双按钮；属性值行内编辑，面板按非标签属性计数
- **HTML+Markdown 混排导入**：新增 `mdToHtml` 转换器 + 直接 HTML→Lexical 导入（`htmlToLexical`），GitHub README 这类「HTML+Markdown 混排」内容保留结构——`align="center"` 居中、徽章成排、`<br>`、行内 `<img>` 尺寸；新增 `ImageRowNode`（flex 行节点）解决 Lexical 内联图片不横排导致的徽章竖排问题

### 修复

- 导入含 HTML 的 Markdown 显示源码（转化为 Markdown 后再解析）
- 导入的页面重载后内容丢失（放宽节点校验，内容有块即保留）
- 属性编辑/删除不保存：按属性串行写入（写队列），删除成功后从 DB 重同步；消除面板里 tag 类型合成行（与 `TagRow` 重复、删不掉）——统一由标签行管理
- 标签管理菜单：删除标签后列表不刷新（`TagAddButton` 的 `allTags` 现跟随全局标签 revision 重新加载）
- 「该节点不是页面」持久红字：`openPage` 成功后清空 `error`（此前失败的错误一直挂着）；自动打开跳过文件夹（只开 page/database）；面包屑点击文件夹改为进入文件管理视图

### 变更

- **品牌化**：窗口标题显示「ShuyoNote · 数友笔记 · v版本号」（运行时版本）；侧边栏显示可重命名的空间名（非应用名）
- **主题**：强调色 hover 深色随所选主题色联动（`--accent-strong`）
- **布局**：标签栏由页面底部移至页面顶部（标题→属性→标签→正文）；文件管理、侧边栏 UI 打磨
- **排版**：文档左右内边距（`--doc-pad`）加大至 52px，页面内容更内收；属性行 12px 左缩进
- **文档**：新增 `docs/README.md` 文档体系总索引（按 定位/方案/对比/设计交付/变更记录 组织），README「📚 文档体系」指向该索引

---

## [1.4.0] - 2026-08-22

### 新增

- **数据库视图扩展**：数据库页视图切换扩为 7 种（表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录）；日历按月翻页按 `date` 属性落格、时间轴按 `date` 排序、目录按页面层级树状展示
- **新页面引导层**：空「新页面」首屏提供「页面 / 数据库 / 从模板库 / 导入 Markdown / AI（预留）」入口，输入后自动隐藏
- **主题自定义**：侧边栏 🎨 主题设置——基础主题（系统/亮/暗）+ 6 色强调色（CSS 变量覆盖，亮暗各配柔和色）
- **插件启用/禁用**：命令面板插件可启用/禁用（`registry` 增加 enabled 状态，面板按启用状态过滤）
- **PDF 导出**：工具栏「🖨 导出 PDF」——复用 HTML 导出 + 隐藏 iframe 触发系统打印（另存为 PDF）
- **竞品聚焦演进**：对标 Wolai / FlowUs 补充多数据库视图与冷启动引导

### 已知剩余（路线图）

- M2 端到端加密 · M6 移动端

---

## [1.3.0] - 2026-08-22

### 新增

- **块级引用与反链升级**：每个顶层块拥有稳定 UUID（`blockId`）；`((blockId))` 块引用（`/引用块` 选择器插入、点击跳转、悬停预览）；`{{blockId}}` 块嵌入（`/嵌入块` 只读镜像、跳转原块、手动/自动刷新）
- **块级反链**：反链面板分「块级引用 / 页面引用」两组，块级反链带来源块与被引用块内容片段，双向定位
- **关系图视图**：侧边栏新增「关系图」（`Ctrl+E` 三视图循环、命令面板「打开关系图」），页面节点力导向布局、可拖拽、点击打开页面、按引用类型着色（页面引用 / 块引用 / 块嵌入）
- **关系图块级图层**：关系图可切换「块级」图层，展示块节点（所属边 + 块级引用边），点击块节点跳转定位；局部图谱 / 缩放平移 / 聚焦高亮 / 出入链着色
- **块引用/嵌入目标缓存**：保存后自动刷新 `((blockId))` 展示文案与 `{{blockId}}` 镜像内容
- **属性系统**：页面可挂带类型的自定义属性（文本 / 数字 / 日期 / 布尔 / 单选 / 多选 / 标签 / 引用），页面标题下方可折叠「属性」面板键值编辑
- **数据库视图**：新建数据库页面（`kind=database`），表格 / 画廊 / 看板 三种视图；列=属性、单元格内联编辑、排序、筛选、列管理、select/multi 选项管理
- **看板泛化**：看板分组字段可选任意 `select` 属性（不再仅限标签）
- **标签属性互通**：`tag` 属性类型读写真实标签系统（`page_tags`），与标签面板/侧栏筛选/关系图一致
- **搜索属性语法**：`prop:属性=值` 过滤（多条件交集）
- **关系图属性维度**：关系图可按标签或任意 select 属性过滤与着色
- **Markdown 无损往返**：自定义转换器覆盖图片 `![]()`、视频 `!video()`、块嵌入 `{{id}}`、块引用 `((id))`、分隔线、待办、Callout、Markdown 表格（补齐 Lexical 默认转换器缺口）
- **属性驱动仪表盘聚合**：数据库页顶部汇总条——select 列按值着色计数、number 列合计/均值
- **竞品与定位文档**：新增三方对比（Obsidian/思源/ShuyoNote）、四方对比（FlowUs/Wolai/Notion/ShuyoNote）、产品定位、演进路线图

### 修复

- 打开/新建页面或数据库时自动切回笔记视图（此前在看板/关系图视图下「点了没反应」）
- 直接命令参数改用 camelCase（修复 `get_page_props` 等「missing required key」报错）

### 变更

- 依赖升级：vite 8、TypeScript 7、@vitejs/plugin-react 6；`cargo update` 升级 Rust 依赖

---

## [1.2.0] - 2026-08-16

### 新增

- **表格交互（Wolai 风格）**：光标进入单元格时，表格上方浮现悬浮工具栏，支持上方/下方插入行、左侧/右侧插入列、表头行·列切换、左/中/右对齐、背景色（9 色调色板）与删除行列
- **列宽拖拽调整**：拖动列边界实时改变列宽（`TableNode.setColWidths`，总宽恒定、跟随指针 1:1），最小列宽 60px
- **单元格选区高亮**：选中行/列/单元格时以品牌色底 + 描边高亮
- **分隔线优化**：正文分隔线改为 Wolai 风格细分隔线（1px、垂直居中），悬停可显示块手柄并拖动排序

### 修复

- 表格块手柄：单元格是 Lexical shadow root，之前会在每个单元格内容左侧各自弹出 `⋮⋮` 手柄；改为用 `$findTableNode` 识别，悬停表格任意位置只在表格整体显示一个手柄

---

## [1.1.0] - 2026-08-16

### 新增

- **块拖拽排序**：悬停块左侧出现 `⋮⋮` 手柄，拖拽实时显示插入指示线，松手重排
- **编辑器内查找**：`Ctrl+F` 高亮全部命中并逐个导航（CSS Custom Highlight，不污染编辑器状态）
- **侧边栏折叠/展开**：状态持久化
- **空状态引导 + 树节点双击行内重命名**
- **UI/UX 设计系统 v2**：品牌蓝 `#3370FF` + 中性面 + 8 色分类 token，参考 FlowUs / Wolai
- **Toast 反馈系统**：保存 / 同步 / 备份 / 删除 / 恢复等操作底部提示，替代 `alert` 弹窗
- **标签 / 看板分类色**：标签名稳定哈希映射到 8 色
- **命令面板增强**：分组展示（页面 / 命令）、`↑/↓` 键盘导航、底部快捷键提示
- **骨架屏**：侧栏加载态
- **无障碍**：全局焦点环、`prefers-reduced-motion` 支持
- **通用文件附件**：页面附件面板（多选导入 / 列表 / 打开 / 定位 / 移除），超大文件流式存取
- **附件同步流式化**：上传/下载分块传输，避免超大文件整块进内存
- **附件导入进度条**：后端 event 回传流式进度
- **块菜单**：点击 `⋮⋮` 手柄弹出「复制块 / 删除块」菜单
- **顶部工具栏**：页面顶部图标工具栏（查找 / 导入 / 导出 Markdown / 导出 HTML / 版本历史）
- **空间名称**：侧栏显示空间名称，双击可重命名
- **图片块 / 视频块**：斜杠菜单插入本地图片/视频（流式导入 + 内容寻址），视频带播放控件

### 修复

- 拖拽手柄「显示但无法拖拽」：悬停检测从编辑器根元素改为 `document`、手柄命中区紧贴正文消除空隙；目标块定位改为顶层块几何比对，避免 `setEditable(false)` 后 reconcile 导致插入线失效
- 代码块插入/显示：补注册 `CodeHighlightNode`、斜杠菜单空块改用 `CodeHighlightNode`、代码块样式补 `display:block` + `white-space:pre`
- 切页内容错乱：编辑器初始内容改为直接读取 `current.content_json`，消除 `useEffect` 滞后导致的旧内容初始化
- `dialog.confirm` 权限：`window.confirm` 改为 Tauri 对话框插件 `confirm()`
- 附件导入进度条不消失：事件竞态（迟到进度事件覆盖 null），用 ref 守卫忽略导入结束后的事件
- 侧边栏弹窗被裁切：改为 `position: fixed` + JS 定位，并支持点击外部关闭
- 应用标识变更：`com.cnzen.shuyonote` → `cn.shuyo.shuyonote`（数据目录随之迁移）

### 文档

- 新增 `design/` 设计体系（设计系统 / UX 流程 / 高保真原型 / 实现计划）
- 重写 README 为专业化文档

---

## [1.0.0] - 2026-08-16

首个正式版本。

### 新增

**编辑**

- Lexical 块编辑器（标题 / 引用 / Callout / 代码块 / 列表 / 待办 / 表格 / 分隔线等 12 种块类型）
- 斜杠菜单（`/`）、Markdown 快捷输入
- 图片粘贴（SHA-256 内容寻址去重存储）
- Markdown 一键导入 / 导出、HTML 导出

**知识组织**

- 页面树（无限层级嵌套、页面 / 文件夹 `kind`、拖拽精确排序）
- 标签系统（页面打标签、侧栏筛选）
- 反向链接（`[[双链]]` 语法自动聚合）
- 看板视图（按标签分列、卡片拖拽跨列）
- 全文搜索（SQLite FTS5 + trigram，中文子串检索、命中高亮与定位）

**数据安全**

- 自动保存（防抖写入，无「保存」按钮）
- 版本历史（每页 50 份快照、自动去重、一键回滚）
- 回收站（软删除 + 恢复 + 彻底删除）
- 整库备份（zip：数据库一致性快照 + 附件目录）

**多设备同步**

- Outbox 变更日志 + 页面级 LWW 合并 + 墓碑
- 附件内容寻址双向增量同步
- 独立 sync-server（Axum + SQLite）
- 启动同步 + 每 5 分钟周期同步

**体验**

- 暗色 / 亮色 / 跟随系统三态主题
- 命令面板（`Ctrl+K`，插件命令扩展点）
- 多窗口（页面弹出独立窗口编辑）
