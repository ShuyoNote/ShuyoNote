# ShuyoNote 项目状态摘要（会话接续种子）

> 本文件由「dsh 会话」在 2026-08-27 生成，作为**新会话接续的种子上下文**——新会话开始时先读本文件，即可精确了解项目当前进度、已做取舍与下一步候选，无需依赖模糊回忆。
> 项目根：`C:\Users\cnzen\zhai\ShuyoNote`

## 1. 项目概况

- **产品**：ShuyoNote 数友笔记 —— 本地优先 · 类 Notion 的知识管理应用
- **技术栈**：Tauri 2（桌面）+ React 18.3.1 + **Lexical 0.49**（编辑器）+ SQLite（本地优先）
- **平台**：桌面（Tauri）+ 浏览器 Web（平台无关 core + 可插拔 driver，见 docs/plans/2026-08-24-cross-platform-plan.md）
- **版本**：**v1.59.183**（最新发布；package.json / src-tauri/Cargo.toml / tauri.conf.json / Cargo.lock 一致；安装包在 src-tauri/target/release/bundle/）
- **许可**：**AGPL-3.0**（GNU Affero GPL v3，仓库根 `LICENSE`；v1.59.173 由 MIT 切换而来，因附带的 sync-server 需在网络托管形态下同样开源）。
- **git**：HEAD `f260685`（工作树干净；v1.59.183 发布提交，v1.59.182 发布提交为 `9fe2084`）。

## 2. 已完成的核心能力（本会话近期落地）

### 分栏（飞书式 Columns Block）—— 路线 B（每列独立子编辑器）已完成
- 节点：`ColumnsBlockNode`（DecoratorNode，每列存一份独立 EditorState JSON）→ `ColumnsBlockView`/`ColumnEditor` 渲染为 N 个独立嵌套编辑器。
- 共享配置抽到 `src/editor/config.ts`（`EDITOR_NODES`/`editorTheme`/`ALLOWED_NODE_TYPES`），供主编辑器与列编辑器复用；`ColumnsBlockNode` 用 `lazy()` 动态导入视图（打破与 config.ts 的循环依赖）。
- 列内 `/` 可插：标题/正文/引用/**Callout**/列表/**表格**（`TablePlugin`）/代码块/分隔线；列内 `Ctrl+Alt` 快捷键。
- 列内独立撤销（`HistoryPlugin`）、跨列独立输入；列增删（＋/×，1–4 列）、列宽拖拽（flex-grow 权重）。
- **本会话分栏系列打磨（v1.59.172）**：
  - 列宽拖拽**跟手/不卡**：按像素直设宽度 + 同步应用 + pointer capture；拖拽中由 React `dragWidths` state 驱动（唯一数据源）、零 React 重渲染；列占比 pct 徽章实时用最大余数法（恒 100%）。
  - **只改拖拽中相邻两列**；按 content-box 反推权重防止松手后列宽漂移。
  - 列内「+」插入块：移除「输入 / 选择块…」占位；悬停分栏空行显内联「+」（复用 `BlockInsertPlugin`）；加入 220ms 驻留延迟防闪现；`getTopLevelKey` 按 `clientY` 垂直兜底 + 只解析当前编辑器根元素，支持整列高度且不跨列误捕；统一放在各列内容左缘（首字符位置），不压调宽手柄。
  - **删除/新增分栏内容不错位**：`ColumnEditor` 仅在父级改动的 `column` 与自身最后发出的 JSON 不同时才重载（避免索引平移出现陈旧内容）。
  - 分栏卡片背景/描边：光标悬停/聚焦该分栏才显示背景，用与页面背景构成对比的卡片色（`--hover-strong`）让「分栏间空隙以页面背景色」清晰；任何时候不画边框。
  - 分栏文本颜色与普通块一致：覆盖 `RichTextPlugin` ErrorBoundary 默认的 `.editor-error` 红色 `--danger` 为 `--text`。
  - 分栏块/绘图块对齐页面边界（去掉 `.editor-error` 多余内边距 / 负 margin 抵消段落 padding）。
- 关键修复：空列 JSON 补 `indent/format/direction`（否则 `ListItemNode.setIndent` 遇非数字 → Lexical #117）、`.editor-column-body` 解耦避免 `.editor-column` 自嵌套、`createDOM` 返回 `.editor-columns-host` 避免 `.editor-columns` 自嵌套、列用 flex-grow 避免百分比+gap 溢出。
- 关键文件：
  - `src/editor/nodes/ColumnsBlockNode.tsx`、`ColumnNode.tsx`、`ColumnsNode.tsx`（旧轻量版，仍注册用于读旧文档）
  - `src/components/ColumnsBlockView.tsx`、`ColumnEditor.tsx`
  - `src/editor/config.ts`、`src/lib/columnsText.ts`（列文本并入 content_text）
  - 方案文档：`docs/plans/2026-08-26-columns-plan.md`（含 6.5 演示截图，docs/media/columns-demo/）

### 绘图块（Excalidraw）—— 已完善
- `/绘图` 插入、全屏 Excalidraw 编辑、JSON(.excalidraw)+PNG 缩略图落内容寻址附件、文字抽取进 content_text。
- 近期修复/增强：
  - 缩放后内容居中（`zoomTo` 修正 scene↔viewport 换算）。
  - 全屏保存不再卡「保存中…」（内容先存、PNG 缩略图后台异步）。
  - 全屏编辑保存后内嵌块**自动适配整幅图**（清空视图记忆）。
  - **图片说明 caption**（`DrawingNode.__caption`，可编辑、随块保存、可搜索；默认隐藏/悬停居中）。
  - 内嵌块**贴合内容高度**（读实际 fit zoom）；**可拖拽调整尺寸且不被自动贴合覆盖**（`node.__height` 已设则不再自动改）。
- 关键文件：`src/editor/nodes/DrawingNode.tsx`、`src/components/InlineDrawing.tsx`、`src/components/DrawingEditorModal.tsx`、`src/lib/drawingText.ts`。
  - 方案文档：`docs/plans/2026-08-24-drawing-solution-design.md`（已补 caption 能力 4.5 节）。

### 其他近期
- Markdown 导出保留分栏列文本（`src/lib/exportMarkdown.ts` 注册 ColumnsBlockNode + 展开列文本）。
- 移除「+」菜单的"流程图/思维导图"与"AI 绘图"项（SlashMenuPlugin makeOptions）。
- **v1.59.173**：分栏最大列数 4→5（`MAX_COLS`）；绘图块控制条移入块内部顶端、左上角、透明描边；`body.content-full` 下标题/属性区左对齐；绘图块 fit 加大边距（`pad=0.8`+`12px inset`）；许可由 MIT 切换为 AGPL-3.0（新增 `LICENSE`）。
- **v1.59.174**：真实向量 embedding 语义检索（`src/lib/semanticEmbed.ts`：`cosineSim`/`vectorRank`/`embedText`/`readEmbedConfig` + AI 设置「语义检索模型」字段；`search` 在 TF+char-bigram 上可选叠加向量重排）+ `page_embeddings` 页嵌入缓存持久化（内容哈希自动失效、惰性重嵌，反复搜索只发 1 次 query 嵌入）；README 版本徽章对齐。
- **v1.59.175**：桌面端接入向量语义检索（能力对齐）——`api.search` 附 `readEmbedConfig()` 传 Rust；`search.rs` 增 `page_embeddings` 表 + `embed_text`/`cosine_sim`/`embed_hash`/`keyword_score` + `search_semantic_async`（宽候选集 + 余弦加分 + 哈希缓存），连接 I/O 作用域同步块保证 future `Send`；**跨空间 `all_spaces` 仍 FTS**，嵌入端点不可达回退关键词。
- **v1.59.176**：跨空间（`all_spaces`）检索接入向量语义——每个空间连接包成 `Db` 复用 `search_semantic_async`；至此向量语义在 Web / 桌面活动空间 / 桌面跨空间均对齐。附 mock 嵌入端点的运行时验证（`embed_text` 往返 + 无关键词重叠的语义排序单测）。
- **v1.59.177**：帮助系统（M25 P0/P1：快捷键面板 `Ctrl+/`/`?` + 内置「使用指南」页 `/帮助` + 命令面板入口）；页面题头图（内置封面图库：12 渐变 + 山峦/科技/星空/海浪/城市题材图片 + 上传图片 + 裁剪编辑 + 可拖拽调整高度，铺满整页宽无圆角）；页面图标（emoji，标题前 + 侧边栏节点同步）；bugfix（新建页 FK、绘图块保存为空/居中偏移、分栏待办光标、自适应占位符、宽度按钮 SVG 图标）。
- **v1.59.178**：**PDF 批注（M24 阶段 1 完整）**——`pdfRender`/`pdfAnnotation` 纯函数（归一化/Schema/CRUD/摘录成块/文本层降级/`pdfRef`）+ `pdf_annotations` 持久化 + `pdfjs-dist@4` 渲染引擎（`pdfjsEngine`，WebView2 兼容，`copy-pdfjs-assets` 供 CJK）+ `PdfReader`/`PdfAnnotationCanvas`（高亮/画笔/便签 + 摘录成块含可点击 `pdf://` 回链 + 文本层精确划词 + OCR 兜底 tesseract.js）+ 全局批注检索（`list_all_pdf_annotations` + 「打开最近批注的 PDF」）；**自动升级**（阶段 1 `updates.ts` + 阶段 2 接线 `tauri-plugin-updater`/`createUpdaterArtifacts` + 发布管线 `release.mjs`）；**M25 P2**（About 四外链 + 隐私开关 + 帮助站导出 `helpSite.ts`）；页面题头图缺省（start 页秋山封面 + 图标 + 空行）；Callout 图标并排；目录 Notion 风格；新手清单一键上手。
- **v1.59.179**：**桌面 native PDF 渲染引擎（M24）**——桌面端用 **MuPDF（经 `mupdf-sys`）** 本地光栅化 PDF 页面替代 pdf.js WASM 路径（Web 仍回退 pdf.js；页元数据/文本层仍走 `pdfjsEngine`）。`render_pdf_page` 命令 + `src/pdf_native.rs`（对 `mupdf-sys` 便捷 C API 的薄安全封装，MuPDF 源码编译、自包含）；`Platform.pdfRender` 双引擎驱动（桌面 true / Web false）。**崩溃修复**：base context 包装全局静态 `CRITICAL_SECTION` 锁，此前每次渲染 new/drop 反复初始化/删除全局锁属未定义行为 → `0xc0000005`；改为 **base context 全局只建一次、进程复用、永不 drop**（`shared_context()`+`OnceLock`），渲染对象仍按 RAII 释放。**依赖取舍**：高层 `mupdf` crate 在 MSVC 无法编译（bindgen 不输出 `max_align_t`），故用编译通过的 `mupdf-sys`。新增落地文档 `docs/plans/2026-08-28-pdf-render-engine-mupdfjs-vs-pdfjs.md`（MuPDF.js vs pdf.js 决策/接口/坐标/AGPL/回退/迁移/验收）。

- **v1.59.180**：**PDF 阅读/批注界面重构（思源式）**——入口全面易达（文件管理器 PDF 行直达「标注」/正文 PDF 附件点击直达＋「标注」徽章/预览弹窗醒目按钮/命令面板「打开 PDF」）；思源式阅读器（默认近全屏＋可最大化/左侧目录树 `PdfOutline`/右侧批注侧栏 `PdfSidebar`/键盘导航/适配页宽）；批注工具栏图标化＋选区操作常驻＋无文本层状态条＋便签/摘录改内联气泡。**修复**：目录点击不能跳转（pdf.js `dest[0]` 是 `Ref` 而非数字，改用 `getDestination`/`getPageIndex` 解析）；**跳转/翻页卡顿**（native 整页 PNG 编码大页 >1s 占 85% → 改返回 RGBA8 原始字节＋`tauri::ipc::InvokeResponseBody::Raw` 二进制通道＋前端 `<canvas>` 绘制＋渲染并行化＋页面缓存 objectURL），移除了 `png` crate 依赖。实测翻页 ~1.3s → ~0.12s。
- **v1.59.181**：**AI 帮读（M24 阶段 3）**——划选 PDF 中的一段文字 → AI 总结要点 → 生成**带 `pdf://` 回链的笔记块**（可点击回跳）。复用 AI 薄 Agent 管线（`runInlineDraft`/`useAiStore`），不新增后端命令。批注工具栏「选中一条标注后」新增 **「AI 帮读」** 按钮（✨）＋流式生成预览面；便签正文优先作为 AI 输入，高亮/区域标注则用新增的 `textInBox` 从 pdf.js 文本层抽取与该标注框相交的文字。结果插入当前页（摘录块的 pdfref 引用语义）或无当前页则新建「AI 帮读 · 第 N 页」页。纯函数 `textInBox`（`pdfTextLayer.ts`），smoke 296→**298**。
- **v1.59.182**：**对整篇 PDF 提问（M24 阶段 3 延伸，方案 B 相关页检索）**——阅读器顶部「对这篇 PDF 提问」按钮→底部提问栏：提问时段提取整篇文本（`getPageText`，仅字符串）＋ **char-bigram Jaccard 相关页检索**（`rankRelevantPages`，离线/无向量端点）只挑最相关 ≤5 页喂模型，流式回答＋「依据 N、M 页」，可一键存成带 `pdf://` 回链的笔记块。纯函数 `rankRelevantPages`（`searchSemantic.ts`）+ 引擎可选 `getPageText` + 新组件 `PdfAskBar.tsx`；落地文档 `docs/plans/2026-08-29-pdf-ask-document.md`。**修复**：桌面端 AI 流式 `ai_complete_stream` 缺 `runId`（Tauri 顶层参数 camelCase，`api.ts` 误传 `run_id`）——AI 帮读/对 PDF 提问在桌面端即可流式返回；清理 `fitWidth` 临时调试日志。smoke 298→**300**。
- **v1.59.183**：**M9 / M20 打磨**——M9 模板 `{{selected}}` 接入编辑器真实选区（用模板建页时把编辑器当前选中文本填入 `{{selected}}`，此前恒为空）；M20 语义检索搜索结果相关度提示（`SearchResult` 新增 `score` 字段，Web + Rust 都传递，搜索面板显示「相关 NN%」徽章）。

## 3. 关键设计取舍 / 边界（诚实标注，重开会话请勿轻易推翻）

- **分栏旧数据不做自动迁移**：`columns`/`column`（ElementNode 轻量版）**保留注册**，旧文档仍可读兼容；新插入走路线 B。自动改写线上 `content_json` 风险高、收益低，**明确不做**。
- **列内块级拖拽 / 跨列复制移动不做**：`BlockDragPlugin` 基于顶层块 `getTopLevelElement()` 设计，列内拖块需全新跨编辑器机制（成本高风险大）；现状「分栏整体可拖/重排」满足主要诉求。
- **列内 AI 草稿、`{{blockId}}` 块引用对列内块不适用**（诚实标注）。
- **M20.2 向量语义检索的平台边界**：语义/向量重排已接入 **Web**（`web.ts` + `semanticEmbed.ts`）与**桌面搜索**（Rust `search.rs`：v1.59.175 活动空间、v1.59.176 跨空间 `all_spaces` 逐空间向量重排；前端把 embedding 配置随 `search` 参数传入 Rust + `page_embeddings` 表 + `search_semantic_async` 余弦加分）；嵌入端点不可达时优雅回退关键词排序。
- 版本号约定：**验证性/修复轮不升版本、不重打桌面**；只有版本号 bump + 发布才重打 MSI/exe（`pnpm tauri build`）。当前 **v1.59.183**。

## 4. 环境/工具备注

- **前端 Web 版**：`pnpm dev:web`（Vite web dev，默认 http://localhost:5173；若 5173 被占则 Vite 自动顺延到 5174……，热更新；SQLite 前端 mock）+ `pnpm preview`（dist 产物，http://127.0.0.1:5173）。
- **桌面版**：`pnpm tauri dev`（1420，需 Rust/SQLite host）或跑 `src-tauri/target/release/shuyonote.exe`。
- **Rust**：MSRV **1.94**（`src-tauri/Cargo.toml` 的 `rust-version`，与 README 徽章 `1.94+` 一致），本机 `rustc 1.94.0` stable；**不锁工具链**（无 `rust-toolchain.toml`），跟随 stable。
- **验证**：`npx tsc --noEmit`、`pnpm build`、`node scripts/smoke-web.mjs`（**296 全绿**，2026-08-28 更新）；`cargo test --lib`（**33**，含 `render_min_pdf_roundtrip`）；无头 Edge CDP 实测交互（Edge 在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，Node 内置 WebSocket，临时脚本放 tmp/）。
- **git 代理**：全局配置了 `http://127.0.0.1:7897` 但**当前端口不通**；push/pull 需 `git -c http.proxy= -c https.proxy=` 临时直连（或清掉全局代理）。

## 5. 下一步候选（未做，按需选一项继续）

1. **PDF 批注立项（M24）**——见 `docs/plans/2026-08-27-pdf-annotation-plan.md`：先按阶段 1 MVP 切，做 `pdfRender` 双引擎接口 + `pdfjsEngine` 纯函数 + smoke 断言（不碰 UI 即可验证核心）；暂排 M20 之后。
2. **列内拖拽 / 跨列复制移动**——需跨编辑器机制，工作量大（此前评估为"暂不做"，若产品必需立项）。
3. **旧分栏（ElementNode）→ 路线 B 的状态补齐**（若确有用户需要，可做"显式、备份式"的手动转换入口，而非自动迁移）。
4. **绘图块更多能力**：如列内 AI 附表、绘图块引用/块级 `{{...}}`、及大图/多图性能。
5. **分栏其它打磨**：分栏块间距/背景配色再调（浅色 `--hover-strong` 与页面背景的对比度是否足够明显）、分栏列宽拖拽到极窄值时的边界表现。
6. 其它 roadmap（见 docs/roadmap.md）待排期项。

---

> 若需回溯更早对话细节，全新会话可调用 dsh 会话检索（`session-query-sqlite`）定位到本会话（`session-719a2997-af6a-4624-8a57-4b04806247d9`，cwd=ShuyoNote）。
