# 「MD 应用内预览」实现记录

> 给「文件夹 = 网盘」的 `.md` 文件加**应用内只读预览**：点侧边栏或文件夹内的 `.md` 文件名，直接在 app 里打开渲染好的内容（不再跳外部应用），并可一键「转为笔记」。属于 [文件夹 = 网盘](2026-08-22-folder-netdisk-plan.md) 的在线预览子项。**已实现**（叠加于 v1.63.0）。
> 关联：[md-in-app-open 利弊分析](2026-08-30-md-in-app-open-plan.md)。

## 1. 目标

- 点 `.md` 文件名 → **应用内只读预览**，铺满**主内容区**（不遮挡左侧侧边栏）。
- 预览里可「**转为笔记**」——把 md 转成可检索/双链/编辑的页面。
- 预览中 ```` ```mermaid ```` 代码块**渲染为图**（复用项目已有 mermaid），随主题（明/暗）自适应，切换主题即时刷新。
- 弹窗（主题设置 / 空间管理 / 确认框等）始终浮于预览之上，不被遮挡；打开任一页面自动关闭预览。

## 2. 现状（代码已核实）

- 此前 `.md`（mime `text/markdown`）在文件管理器预览里走 `startsWith("text/")` 分支，只提示「请在文件夹中打开查看」→ 跳外部应用。
- 已有材料：`api.readTextFile(path)` 读 md 文本；`parseMarkdown`/`$convertFromMarkdownString` + `SHUYONOTE_TRANSFORMERS` + `mdToHtml` 解析；`import("mermaid")` 渲染；PDF 已有「应用内打开」先例（`fm-preview-read` → `usePdfReader.openPdf`）。

## 3. 实现

### 3.1 共享预览 store — `src/store/filePreview.ts`
- 状态：`target: AttachmentMeta | null`（null=关闭）、`mdHtml`、`mdLoading`、`mdImporting`。
- `open(a)`：设 target；mime 为 markdown 时 `readTextFile` → `mdToHtml` → `mdHtml`。
- `close()`：清空 target/html/loading/importing。
- `importAsPage(parentId)`：读 md → `markdownToPageContent` → `useNotes.createPage(parentId, …)` 建页，成功后关闭并 toast。

### 3.2 App 级预览弹窗 — `src/components/FilePreviewDialog.tsx`
- 用 **`createPortal(…, document.body)`** 渲染，避免成为 `.app` 的 flex 子项（后者会挤乱布局、挡住侧边栏点击——曾踩坑，已改回 portal）。
- 按 mime 分流：图片/视频/音频/PDF/md（md 走 `.fm-md-preview` `dangerouslySetInnerHTML`）。
- md 头部：文件名 + 「转为笔记」按钮；PDF 头部：「阅读并批注」。
- 挂载在 `App.tsx`（standalone 与主界面分支）。

### 3.3 offscreen md → 页面 JSON — `src/lib/mdPreview.ts`
- `markdownToPageContent(text)`：`createEditor({nodes: NODES})` + `$convertFromMarkdownString`（纯 md 无损）/ `$importHtml(mdToHtml(text))`（含块 HTML 保结构）→ 返回 `{content_json, content_text}`，供 `createPage` 用，与 `MarkdownImportDialog` 路由一致。

### 3.4 只读渲染 — `src/editor/mdToHtml.ts`
- fenced 块语言为 `mermaid` 时，输出 `<div class="fm-md-mermaid"><pre class="fm-md-mermaid-src">源码</pre><div class="fm-md-mermaid-svg"></div></div>`：源码与 SVG 宿主分离，**源码永不丢失**（否则主题切换重渲染时读不到源码——曾踩坑）。
- 其余代码块仍 `<pre><code>`。

### 3.5 mermaid 渲染 + 主题响应式 — `src/lib/mdMermaid.ts`
- `hydrateMermaidBlocks(root, theme)`：懒加载 `import("mermaid")`，从 `.fm-md-mermaid-src` 的 `textContent` 读源码 → `mermaid.render` → 写入 `.fm-md-mermaid-svg`；失败回退显示源码 + 错误。
- 用 `data-done` 记录**渲染时的主题** + `data-ok` 标记成功；传入主题与已渲染主题不同则**重渲染**（实现"切换主题即时刷新"）。
- `MermaidNode.tsx` 同样用 `useResolvedTheme()` 使编辑器内 mermaid 块也随主题刷新（`mermaidTheme` 依赖 + 模块级 `mermaidThemeRef`）。

### 3.6 请求端接入
- `FileManagerView.tsx`：`.md` 文件名点击 → `useFilePreview.getState().open(row.file!)`（替代 `openFile`），并**移除** `👁` 预览按钮（原本地 preview/md 状态与弹窗清零，改由共享对话框接管）。
- `PageTree.tsx`：侧边栏 `.md` 文件节点点击 → `useFilePreview.open(f)`；PDF 仍走阅读器。

### 3.7 层级与关闭
- `App.css`：`.fm-preview-overlay` `position: fixed; left: var(--sidebar-w, 264px); z-index: 50`——铺满**主内容区**（避开侧边栏）、z-index 50 让**所有弹窗**（`space-switcher`/`theme-settings`/`backup-dropdown` 等提升至 1000，Confirm/command/PDF/公式更高）浮于预览之上。`--sidebar-w` 定在 `:root`（body portal 可继承）。
- `notes.ts`：`openPage` 开头 `useFilePreview.getState().close()`——打开任一页面自动关闭 md 预览。

## 4. 关键坑（本次踩过）

- **预览别渲染成 `.app` flex 子项**：`FilePreviewDialog` 若不放 body portal，会参与 `.app` 的 flex 布局，挤掉侧边栏/主内容、导致"点侧边栏切换不了、弹窗遮挡"。必须 `createPortal(document.body)`。
- **mermaid 源码别放 HTML 属性**：`data-mermaid` 属性经 React `dangerouslySetInnerHTML` 注入后 `getAttribute` 读回会残留 `&gt;`（`-->` 变 `--&gt;`）→ Mermaid Parse error。改用 `<pre>` + `textContent` 读取，天然反转义。
- **mermaid 主题切换要保留源码**：渲染时若用 `el.innerHTML = svg` 替换整块，会丢失 `.fm-md-mermaid-src` 源码 → 切主题重渲染读不到源码。改为源码/SVG 分成两个子元素，只写 SVG 宿主。
- **弹窗层级**：md 预览 z-index（50）高于内容层但低于所有弹窗——弹窗永不遮挡；侧边栏弹窗 z-index 提升至 1000 以浮于预览上。

## 5. 验收

- 侧边栏 / 文件夹内 `.md` 文件名 → 应用内只读预览铺满主内容区，侧边栏仍可见可点。
- 预览内「转为笔记」→ 当前文件夹下新建页面，可编辑/检索。
- ```` ```mermaid ```` 渲染为图；明/暗主题自适应；切换主题图即时刷新。
- 打开预览时点主题设置 / 空间管理 → 弹窗浮于预览上。
- 打开任一页面 → 预览自动关闭。
- 门禁：`tsc --noEmit` 通过；`pnpm build` 通过；`scripts/smoke-web.mjs` 347 passed。

## 6. 边界 / 未做

- 「转为笔记」落点为当前文件夹下的**新页面**；可编辑（转页面后是笔记，而非编辑源 `.md` 文件——不动源文件）。
- 仅 `.md`（mime `text/markdown`）走应用内预览；其他 `text/*` 仍提示外部打开。
- `--sidebar-w` 固定为 264px（侧边栏当前固定宽，未做可折叠——折叠功能启用时需同步该变量）。
