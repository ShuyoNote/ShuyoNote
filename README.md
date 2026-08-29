<p align="center">
  <img src="design/logo/app-icon.png" alt="ShuyoNote Logo" width="128" height="128" />
</p>

<h1 align="center">ShuyoNote 数友笔记</h1>

<p align="center">
  <strong>本地优先 · 类 Notion 的知识管理桌面应用</strong><br>
  基于 Tauri 2 + Lexical + SQLite，数据完全存储在本机，离线可用，支持多设备同步与全平台（浏览器 / 桌面）运行。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.59.180-blue" alt="version">
  <img src="https://img.shields.io/badge/Tauri-2.x-24c8db" alt="tauri">
  <img src="https://img.shields.io/badge/Lexical-0.49-3370ff" alt="lexical">
  <img src="https://img.shields.io/badge/Rust-1.94+-orange" alt="rust">
  <img src="https://img.shields.io/badge/React-18-61dafb" alt="react">
  <img src="https://img.shields.io/badge/Vite-8-646cff" alt="vite">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-orange" alt="license">
</p>

---

## 📖 简介

ShuyoNote 是一款 **本地优先（local-first）** 的知识管理应用。它借鉴 Notion 的块编辑器体验，但将全部数据保存在本机 SQLite 数据库中——无需注册、无云端依赖、离线即可使用。需要多设备协作时，可自建轻量同步服务，通过变更日志实现增量同步与冲突合并。

- **本地优先**：数据即文件，存储在本机，离线可用。
- **内容寻址去重**：附件按 SHA-256 哈希存储，跨文件夹 / 空间去重，省空间。
- **可自建同步**：无云锁定，可选自建 sync-server（outbox + LWW + 附件增量）。
- **可扩展**：磁盘加载命令插件（受限白名单 API）、主题 / 外观自定义。

## 📑 目录

- **特性** —— 编辑体验 / AI 助手 / 知识组织 / 数据安全 / 多设备同步 / 体验优化
- **架构** —— 前端 / Rust 后端 / SQLite / 同步服务端分层；以及可插拔平台 driver（桌面 Tauri / Web 浏览器）
- **技术栈** —— 各层技术一览
- **开发环境要求** —— Node / Rust / 平台
- **快速开始** —— 安装与启动（桌面 + Web）
- **构建发布** —— 产物
- **多设备同步** —— sync-server + 配置
- **项目结构** —— 目录说明
- **文档体系** —— 文档索引
- **路线图** —— 里程碑
- **License**

## ✨ 特性

### 编辑体验
- **块编辑器**：基于 Lexical，支持标题、引用、Callout、代码块、列表、待办、表格、分隔线等 12 种块类型。
- **「+」插入块（飞书式）**：光标悬停在**空块**时，该块左侧出现内联「+」，点开即弹出**飞书式分组插入面板**（基础 / 列表 / 媒体 / 嵌入 / 引用，图标 + 名称 + 顶部可搜索），点某项即在该空块处插入对应块；面板右上置顶「AI 帮我写」入口。非空块显示 `⋮⋮` 拖拽手柄（空块显示 `+`、非空块显示 `⋮⋮`，两者同位、中心对齐）。已取代旧版顶栏「+」按钮。
- **分栏（飞书式）**：N 列并排（2–4 栏，`/分栏` 或「+」菜单的分栏项插入，选栏数 2/3/4）；每列是**独立子编辑器**——独立输入与独立撤销（`HistoryPlugin`），互不影响；列内 `/` 可插标题/正文/引用/Callout/列表/表格/代码块/分隔线；列右上角 ＋/× 增删列（`insertColumnAt` 末尾追加），列间手柄拖拽调整列宽并实时显示各列占宽百分比（最大余数法恒 100%）；列内空行悬停「+」插入块（220ms 驻留防闪现）；支持深色模式、随主题变色、列内容并入全文搜索与 Markdown 导出。
- **斜杠菜单**：输入 `/` 快速插入任意块（含 `/引用块`、`/嵌入块`）。
- **块拖拽排序**：悬停块左侧出现 `⋮⋮` 手柄，拖拽实时显示插入指示线，松手重排。
- **块多选**：点击 `⋮⋮` 手柄选中块（Shift 选连续范围），批量操作条「复制 / 删除」，`Delete`/`Esc` 快捷键，选中块高亮。
- **表格交互**：悬浮工具栏（增删行列 / 表头行列切换 / 对齐 / 背景色）+ 列宽拖拽调整 + 单元格选区高亮。
- **图片粘贴**：截图 / 复制图片直接粘贴，内容寻址（SHA-256）去重存储。
- **网址书签**：`/wzsq` 或 `/bookmark` 插入 URL 为书签卡片（自动抓取 Open Graph 标题 / 摘要 / 预览图）；粘贴纯网址可一键「转换为网址书签」；预览图复用附件内容寻址存储。
- **文件附件**：通用文件附件（多选导入、超大文件流式存取、打开 / 定位 / 移除）。
- **Markdown**：快捷键输入、一键导入 / 导出、导出 HTML。

### 知识组织
- **页面树**：无限层级嵌套，页面与文件夹（`kind`）区分，拖拽精确排序。
- **文件管理 / 网盘**：从侧边栏点文件夹进入文件管理页——文件 / 文件夹、文件列表（类型、大小、时间），文件夹内批量上传超大文件（流式）、侧边栏同步展示；文件引用到页面（文件卡片 + 系统打开）；同名文件历史版本（保留 / 恢复）。
- **标签系统**：页面打标签，侧边栏按标签筛选；标签管理（全局标签库，重命名合并 / 删除 / 使用页数）。
- **双向链接**：`[[标题]]` 页面双链 + `((块ID))` 块引用 + `{{块ID}}` 块嵌入。
- **块级反链**：页面底部反链面板分「页面引用 / 块级引用」两组，精确到「谁引用了本页哪一块」。
- **关系图**：力导向关系图，页面 / 块节点、按引用类型着色、块级图层开关、拖拽与点击跳转。
- **数据库视图**：表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录 七种视图；查询型数据库（规则收页）、保存视图 + `ref` 关联属性 + 公式列 + 跨库 rollup 聚合。
- **看板视图**：按标签分列，卡片拖拽跨列切换。
- **全文搜索**：SQLite FTS5 + trigram 分词，支持中文子串检索、命中高亮与定位；Web 平台提供相关度排序版本。
- **多工作空间（物理隔离）**：每空间独立 SQLite 库（`meta.db` 管理空间清单，`spaces/<ws_id>/` 每空间库）；空间切换器（新建 / 重命名 / 主题色 / 排序 / 删除）；全空间搜索跨库合并；跨空间复制页面；单空间导出 / 导入（自包含 zip）。

### 数据安全
- **自动保存**：防抖写入 SQLite，无「保存」按钮。
- **版本历史**：每次保存前自动快照，可一键回滚（每页保留 50 份，自动去重）。
- **回收站**：软删除 + 恢复 + 彻底删除。
- **端到端加密**：Argon2id 密钥派生 + XChaCha20-Poly1305；同步加密 + 设置 UI + 口令解锁 / 锁定，每空间独立密钥。
- **整库备份**：导出 / 导入 zip（数据库一致性快照 + 附件目录；流式 + 进度条）。
- **单空间备份导出**：`export_workspace` 把当前空间打成自包含 zip（空间库 + 该空间引用附件 + 元数据）；`import_workspace` 导入为新空间。
- **空间清理 / 存储管理**：占用统计（数据库 / 附件 / 回收站 / 版本 / 临时）、清空回收站 / 清理孤立附件 / 清理版本历史 / 清理临时文件 / 清理软删工作空间。

### 多设备同步
- **Outbox 变更日志**：本地每次写入记录变更，离线排队。
- **LWW 冲突合并**：页面级 last-write-wins + 墓碑。
- **附件同步**：内容寻址去重，双向增量。
- **自动定时同步**：启动即同步，之后每 5 分钟周期同步。

### 体验优化
- **设计系统 v2**：品牌蓝 + 中性面 + 多彩分类色的统一 token 体系。
- **暗色模式**：亮色 / 暗色 / 跟随系统三种。
- **命令面板**：`Ctrl+K` 搜索页面与命令，分组展示、键盘导航。
- **顶部工具栏**：页面顶部图标工具栏（查找 / 导入 / 导出 Markdown / 导出 HTML / 版本历史 / PDF）。
- **模板中心**：结构预设建页（页面 / 数据库）+ 保存为模板 + 共享打磨。
- **Toast 反馈**：保存 / 同步 / 备份 / 删除 / 恢复等操作底部提示，替代系统弹窗。
- **编辑器查找**：`Ctrl+F` 高亮全部命中并逐个导航。
- **多窗口**：页面可弹出到独立窗口编辑。

### AI 助手（薄 Agent + 内联起草）
- **可选、本地优先、安全**：AI 默认关闭，仅调用你配置的模型端点（本地 Ollama / OpenAI 兼容云）；白名单语义工具（搜索 / 读页 / 读块 / 建页 / 追加块 / 反链），无 shell / 任意文件 / 联网；写操作需确认（详见 [薄 Agent 方案](docs/plans/2026-08-24-thin-agent-interface-plan.md)）。
- **侧边栏 AI 助手**：右侧 ✦ 面板，全局问答 / 总结 / 跨页检索 / 建页（草稿确认后落库），多轮上下文（支持"再详细点"）。
- **内联 AI 起草**：空行按**空格**打开**跟随光标**的起草浮层；「用 AI 写作」下拉**按当前页上下文自适应**（有内容 → 续写 / 总结 / 翻译 / 润色 / 纠错；空页 → 创作类·小红书等）；选中即填入提示词、光标定位到省略号后；**流式创作** + 高亮待定草案 +「完成」插入到你按空格所在的块 /「关闭」丢弃 /「重新生成」；点击背景或 **Esc** 取消。
- **思考过程实时流式**：推理型模型的 `reasoning_content` 边想边显示；R 重新生成 / Esc 停止。

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+N` | 新建页面 |
| `Ctrl+Shift+F` | 聚焦搜索 |
| `Ctrl+E` | 循环笔记 / 看板 / 关系图视图 |
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+F` | 编辑器内查找（`Enter` / `Shift+Enter` 导航） |
| `Esc` | 关闭查找栏 / 命令面板 / 弹层 |
| `/` | 打开斜杠菜单 |

## 🏗️ 架构

> 详细架构见 [docs/architecture.md](docs/architecture.md)。

```
┌────────────────────────────────────────────────────────────┐
│                       前端 (React)                          │
│  Lexical(编辑器) · Zustand(notes/theme/…) · 各视图组件       │
└──────────────────────────┬─────────────────────────────────┘
                           │ Tauri IPC / 平台 driver
┌──────────────────────────┴─────────────────────────────────┐
│                  Rust 后端 (src-tauri)                      │
│  commands · search · sync · attachments · backlinks · blocks│
│  graph · tags · trash · versions · backup · workspace_io    │
│  storage · security · plugins · workspaces · templates       │
│  crypto · database · properties                             │
└──────────────┬───────────────────────────┬─────────────────┘
               │                           │
   SQLite (WAL + FTS5)            附件目录 (SHA-256)
   meta.db(应用级) + spaces/<id>.db(每空间)
               │
┌──────────────┴───────────────────────────┐
│       同步服务端 (sync-server, 独立二进制)  │
│     Axum + SQLite（变更日志 / 附件元数据）   │
└──────────────────────────────────────────┘
```

**平台 driver 抽象（M16）**：`src/lib/platform/` 定义 `Executor` / `DialogDriver` / `OpenerDriver` / `EventDriver` / `AssetDriver` / `WebviewDriver` 接口；`tauri.ts` 为桌面唯一宿主（调用 `@tauri-apps/*`），`web.ts` 为浏览器实现（`sql.js` WASM SQLite + IndexedDB + blobStore 内容寻址附件），`index.ts` 按环境（是否 `__TAURI_INTERNALS__`）自动切换。**同一套前端可跑桌面与浏览器**（`pnpm dev:web`）。

**数据模型**：一页 = 一份 Lexical 文档。块映射为 Lexical 根级节点（每个顶层块带稳定 `blockId`），页面层级用 `parent_id` 树表达；`blocks` 表维护「块 → 页」反向索引，`backlinks` 表记录页面级 + 块级引用关系。

**物理隔离**：每个工作空间一个独立 SQLite 库（`spaces/<ws_id>/`），应用级共享状态（workspaces / 模板 / 插件状态 / 同步配置）放 `meta.db`；附件字节全局内容寻址（跨空间去重），单空间可搬移经空间级附件子集导出实现。

## 🧰 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2.x（Rust 后端 + 系统 WebView）；Web 壳 = `web.ts` + sql.js WASM |
| 编辑器 | Lexical 0.49（`@lexical/react`） |
| 前端 | React 18.3.1 · TypeScript · Vite 8（`pnpm dev:web`：`vite.web.config.ts`） |
| 状态管理 | Zustand |
| 本地存储 | SQLite（桌面 rusqlite 0.40 bundled / Web sql.js WASM）· FTS5 / trigram 全文检索 |
| 加密 | Argon2id + XChaCha20-Poly1305（RustCrypto） |
| 同步 | outbox 变更日志 + LWW · reqwest · 自建 Axum 服务端 |
| 备份 / 导出 | rusqlite 在线 backup API + zip（Web 用 fflate + 流式 `Zip`） |
| 插件 | boa_engine（受限 JS 运行时）+ 白名单 API |
| 附件 | 内容寻址（SHA-256 去重）；Web 侧存 IndexedDB `blobStore` |

## 🛠️ 开发环境要求

- **Node.js** ≥ 20 + **pnpm**
- **Rust** stable（1.94+，MSRV 见 `src-tauri/Cargo.toml` 的 `rust-version`）与 cargo
- Windows / macOS / Linux

## 🚀 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2a. 桌面（Tauri）
pnpm tauri dev

# 2b. 浏览器（Web 平台，独立 5173）
pnpm dev:web
```

> **Windows 提示**：若 cargo 使用镜像源且遇到 SSL 撤销错误（如 USTC），先执行 `$env:CARGO_HTTP_CHECK_REVOKE="false"` 再运行。

首次启动会在系统应用数据目录（Windows：`%APPDATA%\cn.shuyo.shuyonote\`）创建数据（WAL 模式）：`meta.db`（应用级：空间 / 同步 / 模板 / 插件状态）+ `spaces/<ws_id>/`（每空间独立 SQLite 库）+ `attachments/`（全局内容寻址附件）。Web 版则在浏览器 IndexedDB 中持久化（`shuyonote` 存 SQLite 快照、`shuyonote-blobs` 存附件字节、`shuyonote-spaces` 存多空间 catalog + 快照）。

## 📦 构建发布

```bash
pnpm tauri build
```

产物位于 `src-tauri/target/release/`。

## 🔄 多设备同步

### 1. 启动同步服务端

```bash
cd sync-server
cargo run -- --port 8787 --db <数据目录>/shuyonote-sync.db
```

参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | 监听端口 | `8787` |
| `--db` | SQLite 数据库路径 | 系统临时目录 |

### 2. 在应用中配置

1. 侧边栏点击「同步」。
2. 填写服务地址（如 `http://localhost:8787`，跨设备填局域网 IP 或公网地址）。
3. 可选填写访问令牌。
4. 点击「立即同步」。

**同步机制**：本地每次写操作在 `changes` 表记录 outbox 变更；同步时先 push 本地增量，再 pull 服务端增量，按页面级 `updated_at` 做 last-write-wins 合并。删除走墓碑，附件按内容寻址去重传输。若开启端到端加密，push 前加密、pull 后解密（服务端仅存密文），锁定会话时同步被拒绝。

## 📁 项目结构

```
ShuyoNote/
├── src/                      # 前端（React + Lexical）
│   ├── editor/               # 编辑器、自定义节点（Callout/Image/BlockRef/BlockEmbed/ColumnsBlockNode/分栏）、Markdown 转换
│   ├── components/           # 侧边栏、页面树、搜索、看板、关系图、各面板 + 分栏（ColumnsBlockView/ColumnEditor）（18+ 组件）
│   ├── store/                # Zustand（notes / theme / sidebar / toast / view / space / blockCache / treeDrag / treeSelection / …）
│   ├── hooks/                # 自动同步 / 全局快捷键 / Popover
│   ├── plugins/              # 插件命令注册表（命令面板扩展点）
│   ├── lib/                  # Tauri IPC 封装 / 标签分类表 / Markdown 导出 / PDF 打印 / treeReorder(拖拽重排纯函数)
│   │   ├── platform/         # 平台 driver 抽象：types(接口) / tauri.ts / web.ts / sqliteStore.ts / blobStore.ts / spaceStore.ts
│   │   └── ai/               # 薄 Agent 核心：llm(传输) / host(受限循环) / transport / apply / tools / inlineDraft / lexical(文本辅助)
│   ├── App.tsx               # 根组件
│   ├── App.css               # 设计系统 token 与全局样式
│   └── types.ts              # 共享类型
├── src-tauri/                # Tauri 后端（Rust）
│   └── src/
│       ├── db.rs             # SQLite 连接/迁移；meta.db + spaces/<id>.db 每空间库
│       ├── commands.rs       # 页面 CRUD
│       ├── search.rs         # FTS5 检索（含全空间跨库合并）
│       ├── sync.rs           # outbox / LWW / push-pull / 附件同步
│       ├── attachments.rs    # 图片 / 附件（内容寻址）
│       ├── backlinks.rs      # 反向链接
│       ├── blocks.rs         # 块索引 / 块级引用 / 块级反链
│       ├── graph.rs          # 关系图数据
│       ├── tags.rs           # 标签 / 看板
│       ├── trash.rs          # 回收站
│       ├── versions.rs       # 版本历史
│       ├── backup.rs         # 整库备份导出 / 导入
│       ├── workspace_io.rs   # 单空间导出 / 导入（自包含 zip）
│       ├── storage.rs        # 存储统计 / 清理（回收站/孤立附件/版本/临时/软删空间）
│       ├── workspaces.rs     # 工作空间命令 + 跨空间复制
│       ├── templates.rs      # 模板（meta.templates）
│       ├── plugins.rs        # 插件加载（boa 运行时 + 白名单 API）
│       ├── security.rs       # 端到端加密（口令加解密 / 同步门）
│       ├── crypto.rs         # Argon2id + XChaCha20-Poly1305 原语
│       ├── database.rs       # 数据库视图 / 查询型 / 公式
│       ├── properties.rs     # 属性系统
│       └── windows.rs        # 多窗口
├── sync-server/              # 同步服务端（独立 Rust 二进制，Axum + SQLite）
├── design/                   # UI/UX 设计体系（设计系统 / UX 流程 / 原型 / 实现计划）
├── docs/                     # 产品 / 方案 / 对比文档（见 docs/README.md 索引；架构见 docs/architecture.md）
└── CHANGELOG.md              # 版本变更日志
```

## 📚 文档体系

> 全量文档统一入口：[docs/README.md](docs/README.md)（按主题组织的索引）。

| 文档 | 内容 |
|------|------|
| [docs/README.md](docs/README.md) | **文档体系总索引**：定位 / 架构 / 方案 / 对比 / 设计交付 / 变更记录 |
| [docs/architecture.md](docs/architecture.md) | **系统架构**：前端 / 平台 driver / Rust 后端 / SQLite / 同步服务端分层；数据模型与存储布局 |
| [docs/design-philosophy.md](docs/design-philosophy.md) | **设计哲学**：page 本源 / 属性语义 / 数据库=透镜 / 文件夹=容器 / 空间=隔离容器 |
| [docs/roadmap.md](docs/roadmap.md) | 演进路线图与里程碑规划（M1–M15 + M16 跨平台/Web + **M17 薄 Agent AI 已达成**；**M18 内联起草 / M19 织网 / M20 模板变量+语义检索 / M21 wiki 导出** 规划中；M6 移动端 / M11.3 / M11.4 已评估未做） |
| [docs/development.md](docs/development.md) | **开发指南**：运行 / 测试与验证权威循环（`scripts/smoke-web.mjs` + `tsc` + `vite build` + `cargo check`）/ **版本号提升规则** / 约定 / 常见坑 |
| [docs/positioning.md](docs/positioning.md) | 产品定位陈述、目标用户与差异化 |
| [docs/compare-obsidian-siyuan-shuyonote.md](docs/compare-obsidian-siyuan-shuyonote.md) | Obsidian / 思源笔记 / ShuyoNote 三方对比与定位 |
| [docs/compare-flowus-wolai-notion-shuyonote.md](docs/compare-flowus-wolai-notion-shuyonote.md) | FlowUs / Wolai / Notion / ShuyoNote 四方对比与定位 |
| [docs/plans/*](docs/plans/) | 各功能方案：块引用 / 属性数据库 / 多空间 / 模板 / 插件 / 网盘 / 数据库透镜 / 存储清理 / 工作空间 CRUD / 物理隔离 / 跨平台 / Web 打磨 / **薄 Agent AI / 内联 AI 起草（含嵌入式 vs 侧边栏职责划分）** |
| [design/README.md](design/README.md) | UI/UX 设计交付索引（设计系统 / UX 流程 / 高保真原型 / 实现计划） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更日志 |

## 🗺️ 路线图

- [x] MVP：页面树 + 富文本 + 自动保存
- [x] 块系统：斜杠菜单 / 待办 / 表格 / Callout
- [x] **「+」插入块（飞书式）**：空块悬停出「+」→ 飞书式分组插入面板（基础/列表/媒体/嵌入/引用 + 搜索 + AI 帮我写）；取代旧顶栏「+」按钮；空块「+」与非空块 `⋮⋮` 同位
- [x] **分栏（飞书式）**：2–4 列并排 / 每列独立子编辑器独立输入与撤销 / 列内 `/` 插块 / 列增删与列宽拖拽、实时占宽百分比 / 列内空行「+」插入块（见 [分栏方案](docs/plans/2026-08-26-columns-plan.md)）
- [x] 全文检索：FTS5 + trigram 中文搜索
- [x] 多设备同步：outbox + LWW + 附件同步
- [x] 标签 / 反链 / 文件库 / 看板
- [x] 回收站 / 版本历史 / 整库备份
- [x] 暗色模式 / 命令面板 / 多窗口
- [x] 块拖拽排序 / 编辑器查找
- [x] UI/UX 设计系统 v2（token / Toast / 分类色 / 命令面板增强 / 骨架屏）
- [x] 表格交互（悬浮工具栏 / 列宽拖拽 / 选区高亮）
- [x] 块级引用 / 块嵌入 / 块级反链
- [x] 关系图（页面 / 块级图层）
- [x] 属性系统 + 数据库视图（表格 / 画廊 / 看板）
- [x] 属性 Notion 风格统一（标签属性行 + 底部「＋ 添加标签 / ＋ 添加属性」双按钮）
- [x] 文件管理视图（文件夹 / 批量超大文件上传 / 侧边栏文件）
- [x] 文件引用到页面（正文插入文件卡片 / 系统默认打开）
- [x] 文件历史版本（同名文件保留 / 恢复）
- [x] 全局标签管理（新建 / 重命名合并 / 删除 / 使用页数）
- [x] 跨空间复制页面（把页面树复制到其他工作空间）
- [x] 工作空间管理（新建种子首页 / 按 id 重命名 / 空间主题色与排序）
- [x] 全空间搜索（本空间 / 全空间切换，跨工作空间全文检索）
- [x] 块多选 + 批量删除
- [x] HTML / Markdown 混排导入（保留 `align` 居中 / 徽章成排 / 图片尺寸）
- [x] Markdown 无损往返
- [x] 导出工作空间为 Markdown（批量 `.md`，可 git / 可移植）
- [x] 属性驱动仪表盘聚合
- [x] 端到端加密（Argon2id 派生 + XChaCha20-Poly1305；同步加密 + 设置 UI + 口令解锁/锁定，每空间独立密钥）
- [x] 主题自定义 + 插件启停
- [x] 插件（磁盘加载命令 + 受限白名单 API，可插入内容）
- [x] 数据库视图扩展（列表 / 日历 / 时间轴 / 目录）
- [x] 跨库统计（rollup：数据库列引用另一库的行并聚合 count / sum / avg）
- [x] 新页面引导层（页面 / 数据库 / 模板 / 导入 / AI 入口）
- [x] 导出 PDF（页面 + 数据库视图）
- [x] 每工作空间独立存储（物理隔离：`meta.db` + `spaces/<ws_id>/` 每空间库；全空间搜索跨库合并 / 跨空间复制 / 单空间导出导入）
- [x] **Web 全平台**（M16：`src/lib/platform/` driver 抽象 → 浏览器可跑 → sql.js 真实 SQLite → 属性/数据库/版本/块引用/备份/PWA；web 能力补齐与体验优化 + 数据安全，见 [M16 里程碑](docs/roadmap.md)）
- [x] **AI 增强（薄 Agent）**（M17：语义工具 + 受限宿主 + 草稿确认 + 隐私开关，默认关，见 [方案](docs/plans/2026-08-24-thin-agent-interface-plan.md)）
- [ ] **内联 AI 起草**（M18：空行空格唤起随光标浮层 + 上下文自适应下拉 + 流式创作 + 完成/关闭，见 [方案](docs/plans/2026-08-24-inline-ai-draft-plan.md)）
- [ ] 移动端适配（环境受限：缺 iOS/Android 工具链，已评估）

> 详细演进路线与里程碑，见 [docs/roadmap.md](docs/roadmap.md)。

## 📄 License

本项目采用 [GNU Affero General Public License v3.0](LICENSE)（**AGPL-3.0**），全文见仓库根 `LICENSE` 文件。

**为什么是 AGPL-3.0 而不是 MIT**：

- ShuyoNote 是**本地优先**应用，但附带一个可自建、可被第三方托管的 `sync-server`（Axum + SQLite）同步服务。若仍用 MIT，他人可以把它打包成托管服务（SaaS）分发，却无需把服务端源码开放。
- **AGPL-3.0** 在网络交互（网络服务 / 托管运行）时同样触发放大条款——**无论以何种方式分发（本地、网络、托管），只要基于本项目的代码对外提供，都必须以 AGPL-3.0 开放对应源码**。这正好匹配「本地优先 + 可自建同步」的双形态。
- **LGPL** 面向「库」，不适合作为整体应用（含前端 + Rust 后端 + sync-server 多可执行文件）的许可证；**GPL-3.0** 不具备 AGPL 的网络服务条款，无法覆盖"被托管成 SaaS"这一场景。故选择约束力最强的 **AGPL-3.0**。

> 简述：你可以自由使用、修改、分发 ShuyoNote，或将其作为服务运行；但若向他人提供修改版/网络服务，你必须以相同许可（AGPL-3.0）开放该修改与对应源码。详见 [LICENSE](LICENSE) 全文。
