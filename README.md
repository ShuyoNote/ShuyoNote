<p align="center">
  <img src="design/logo/app-icon.png" alt="ShuyoNote Logo" width="128" height="128" />
</p>

<h1 align="center">ShuyoNote 数友笔记</h1>

<p align="center">
  <strong>本地优先 · 类 Notion 的知识管理桌面应用</strong><br>
  基于 Tauri 2 + Lexical + SQLite，数据完全存储在本机，离线可用，支持多设备同步。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.34.0-blue" alt="version">
  <img src="https://img.shields.io/badge/Tauri-2.x-24c8db" alt="tauri">
  <img src="https://img.shields.io/badge/Lexical-0.49-3370ff" alt="lexical">
  <img src="https://img.shields.io/badge/Rust-1.94+-orange" alt="rust">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="react">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

---

## 📖 简介

ShuyoNote 是一款**本地优先（local-first）**的知识管理应用。它借鉴了 Notion 的块编辑器体验，但将全部数据保存在本地 SQLite 数据库中——无需注册、无云端依赖、离线即可使用。需要多设备协作时，可自建轻量同步服务，通过变更日志实现增量同步与冲突合并。

## ✨ 特性

### 编辑体验
- **块编辑器**：基于 Lexical，支持标题、引用、Callout、代码块、列表、待办、表格、分隔线等 12 种块类型
- **斜杠菜单**：输入 `/` 快速插入任意块（含 `/引用块`、`/嵌入块`）
- **块拖拽排序**：悬停块左侧出现 `⋮⋮` 手柄，拖拽实时显示插入指示线，松手重排
- **块多选**：点击 `⋮⋮` 手柄选中块（Shift 选连续范围），批量操作条「复制 / 删除」，`Delete`/`Esc` 快捷键，选中块高亮
- **表格交互**：Wolai 式悬浮工具栏（增删行列 / 表头行·列切换 / 对齐 / 背景色）+ 列宽拖拽调整 + 单元格选区高亮
- **分隔线**：Wolai 风格细分隔线，垂直居中，悬停显示块手柄
- **图片粘贴**：截图/复制图片直接粘贴，内容寻址（SHA-256）去重存储
- **文件附件**：通用文件附件（多选导入、超大文件流式存取、打开 / 定位 / 移除）
- **Markdown**：快捷键输入、一键导入/导出、导出 HTML

### 知识组织
- **页面树**：无限层级嵌套，页面与文件夹（`kind`）区分，拖拽精确排序
- **文件管理**：从侧边栏点文件夹进入文件管理页——文件/文件夹/文件列表（类型、大小、时间），文件夹内批量上传超大文件（流式）、侧边栏同步展示
- **标签系统**：页面打标签，侧边栏按标签筛选；标签管理（全局标签库，重命名/合并/删除）
- **双向链接**：`[[标题]]` 页面双链 + `((块ID))` 块引用 + `{{块ID}}` 块嵌入
- **块级反链**：页面底部反链面板分「页面引用 / 块级引用」两组，精确到「谁引用了本页哪一块」
- **关系图**：力导向关系图，页面/块节点、按引用类型着色、块级图层开关、拖拽与点击跳转
- **看板视图**：按标签分列，卡片拖拽跨列切换
- **全文搜索**：SQLite FTS5 + trigram 分词，支持中文子串检索、命中高亮与定位

### 数据安全
- **自动保存**：防抖写入 SQLite，无「保存」按钮
- **版本历史**：每次保存前自动快照，可一键回滚（每页保留 50 份，自动去重）
- **回收站**：软删除 + 恢复 + 彻底删除
- **整库备份**：导出/导入 zip（数据库一致性快照 + 附件目录）

### 多设备同步
- **Outbox 变更日志**：本地每次写入记录变更，离线排队
- **LWW 冲突合并**：页面级 last-write-wins + 墓碑
- **附件同步**：内容寻址去重，双向增量
- **自动定时同步**：启动即同步，之后每 5 分钟周期同步

### 体验优化
- **设计系统 v2**：品牌蓝 + 中性面 + 多彩分类色的统一 token 体系，参考 FlowUs / Wolai
- **暗色模式**：亮色 / 暗色 / 跟随系统三态
- **命令面板**：`Ctrl+K` 搜索页面与命令，分组展示、键盘导航
- **顶部工具栏**：页面顶部图标工具栏（查找 / 导入 / 导出 Markdown / 导出 HTML / 版本历史）
- **空间名称**：侧栏显示空间名称，双击可重命名
- **Toast 反馈**：保存 / 同步 / 备份 / 删除 / 恢复等操作底部提示，替代系统弹窗
- **编辑器查找**：`Ctrl+F` 高亮全部命中并逐个导航
- **多窗口**：页面可弹出到独立窗口编辑

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

```
┌─────────────────────────────────────────────────────┐
│                    前端 (React)                       │
│  ┌───────────────┐  ┌────────────────────────────┐  │
│  │   Lexical     │  │  Zustand (notes / theme)    │  │
│  │   编辑器       │  │  侧边栏 / 看板 / 各面板       │  │
│  └──────┬────────┘  └─────────────┬──────────────┘  │
│         │           Tauri IPC      │                  │
└─────────┼──────────────────────────┼──────────────────┘
          ▼                          ▼
┌─────────────────────────────────────────────────────┐
│                  Rust 后端 (src-tauri)                │
│  commands · search · sync · attachments · backlinks  │
│  blocks · graph · tags · trash · versions · backup   │
│  windows                                              │
│                    │                                 │
│     ┌──────────────┴──────────────┐                  │
│     ▼                             ▼                  │
│  SQLite (WAL + FTS5)        附件目录 (SHA-256)       │
└─────────────────────────────────────────────────────┘
          ▲
          │ HTTP (push / pull)
┌─────────┴───────────────────────────────────────────┐
│        同步服务端 (sync-server, 独立二进制)           │
│        Axum + SQLite（变更日志 / 附件元数据）         │
└─────────────────────────────────────────────────────┘
```

**数据模型**：一页 = 一个 Lexical 文档。块映射为 Lexical 根级节点（每个顶层块带稳定 `blockId`），页面层级用 `parent_id` 树表达；`blocks` 表维护「块 → 页」反向索引，`backlinks` 表记录页面级 + 块级引用关系。

## 🧰 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2.x（Rust 后端 + 系统 WebView） |
| 编辑器 | Lexical 0.49（`@lexical/react`） |
| 前端 | React 19 · TypeScript · Vite 7 |
| 状态管理 | Zustand |
| 本地存储 | SQLite（rusqlite, bundled）· FTS5 全文检索 |
| 同步 | outbox 变更日志 + LWW · reqwest · 自建 Axum 服务端 |
| 备份 | rusqlite 在线 backup API + zip |

## 🛠️ 开发环境要求

- **Node.js** ≥ 20 与 **pnpm**
- **Rust** stable（1.94+）与 cargo
- Windows / macOS / Linux

## 🚀 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动开发模式
pnpm tauri dev
```

> **Windows 提示**：若 cargo 使用镜像源且遇到 SSL 撤销错误（如 USTC），先执行
> `$env:CARGO_HTTP_CHECK_REVOKE="false"` 再运行。

首次启动会在系统应用数据目录（Windows：`%APPDATA%\cn.shuyo.shuyonote\`）创建 SQLite 数据库（WAL 模式）。

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

1. 侧边栏点击「同步」
2. 填写服务地址（如 `http://localhost:8787`，跨设备填局域网 IP 或公网地址）
3. 可选填写访问令牌
4. 点击「立即同步」

**同步机制**：本地每次写操作在 `changes` 表记录 outbox 变更；同步时先 push 本地增量，再 pull 服务端增量，按页面级 `updated_at` 做 last-write-wins 合并。删除走墓碑，附件按内容寻址去重传输。

## 📁 项目结构

```
ShuyoNote/
├── src/                      # 前端（React + Lexical）
│   ├── editor/               # 编辑器、自定义节点（Callout/Image/BlockRef/BlockEmbed）、插件
│   ├── components/           # 侧边栏、页面树、搜索、看板、关系图、各面板
│   ├── store/                # Zustand（notes / theme / sidebar / toast / view / blockCache）
│   ├── hooks/                # 自动同步 / 全局快捷键
│   ├── plugins/              # 插件注册表（命令面板扩展点）
│   └── lib/                  # Tauri IPC 封装 / 标签分类色
├── src-tauri/                # Tauri 后端（Rust）
│   └── src/
│       ├── db.rs             # SQLite 连接 / 迁移
│       ├── commands.rs       # 页面 CRUD
│       ├── search.rs         # FTS5 检索
│       ├── sync.rs           # outbox / LWW / push-pull
│       ├── attachments.rs    # 图片 / 附件
│       ├── backlinks.rs      # 反向链接
│       ├── blocks.rs         # 块索引 / 块级引用 / 块级反链
│       ├── graph.rs          # 关系图数据
│       ├── tags.rs           # 标签 / 看板
│       ├── trash.rs          # 回收站
│       ├── versions.rs       # 版本历史
│       ├── backup.rs         # 备份导出 / 导入
│       └── windows.rs        # 多窗口
├── sync-server/              # 同步服务端（独立 Rust 二进制）
├── design/                   # UI/UX 设计体系（设计系统 / UX 流程 / 原型 / 实现计划 / Logo）
├── docs/plans/               # 架构与开发方案文档
└── CHANGELOG.md              # 版本变更日志
```

## 📚 文档体系

> 全量文档统一入口见 [docs/README.md](docs/README.md)（按主题组织的索引）。

| 文档 | 内容 |
|------|------|
| [docs/README.md](docs/README.md) | **文档体系总索引**：定位 / 方案 / 对比 / 设计交付 / 变更记录 |
| [docs/plans/2026-08-15-local-first-note-app-plan.md](docs/plans/2026-08-15-local-first-note-app-plan.md) | 需求分析、数据模型、ADR、同步协议与路线图 |
| [docs/plans/2026-08-20-block-reference-plan.md](docs/plans/2026-08-20-block-reference-plan.md) | 块级引用 + 反链升级 + 关系图方案（M1–M5 已实现） |
| [docs/plans/2026-08-21-properties-database-plan.md](docs/plans/2026-08-21-properties-database-plan.md) | 属性系统 + 数据库视图统一方案（合并思源数据库 + Obsidian Properties） |
| [docs/compare-obsidian-siyuan-shuyonote.md](docs/compare-obsidian-siyuan-shuyonote.md) | Obsidian / 思源笔记 / ShuyoNote 三方对比与定位 |
| [docs/compare-flowus-wolai-notion-shuyonote.md](docs/compare-flowus-wolai-notion-shuyonote.md) | FlowUs / Wolai / Notion / ShuyoNote 四方对比与定位 |
| [docs/roadmap.md](docs/roadmap.md) | 下一阶段演进路线图与里程碑规划 |
| [docs/positioning.md](docs/positioning.md) | 产品定位陈述、目标用户与差异化 |
| [design/README.md](design/README.md) | UI/UX 设计交付索引（设计系统 / UX 流程 / 高保真原型 / 实现计划） |
| [design/logo/README.md](design/logo/README.md) | 应用 Logo（应用图标 / 单色图形 / 字标 / 主图） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更日志 |

## 🗺️ 路线图

- [x] MVP：页面树 + 富文本 + 自动保存
- [x] 块系统：斜杠菜单 / 待办 / 表格 / Callout
- [x] 全文检索：FTS5 + trigram 中文搜索
- [x] 多设备同步：outbox + LWW + 附件同步
- [x] 标签 / 反链 / 文件夹 / 看板
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
- [x] 文件历史版本（同名文件保留/恢复）
- [x] 全局标签管理（新建 / 重命名合并 / 删除 / 使用页数）
- [x] 跨空间复制页面（把页面樹复制到其他工作空间）
- [x] 全空间搜索（本空间 / 全空间切换，跨工作空间全文检索）
- [x] 块多选 + 批量删除
- [x] HTML/Markdown 混排导入（保留 `align` 居中 / 徽章成排 / 图片尺寸）
- [x] Markdown 无损往返
- [x] 导出工作空间为 Markdown（批量 .md，可 git / 可移植）
- [x] 属性驱动仪表盘聚合
- [ ] 端到端加密
- [x] 主题自定义 + 插件启停
- [x] 插件（磁盘加载命令 + 受限白名单 API，可插入内容）
- [x] 数据库视图扩展（列表 / 日历 / 时间轴 / 目录）
- [x] 跨库统计（rollup：数据库列引用另一库的行并聚合 count / sum / avg）
- [x] 新页面引导层（页面 / 数据库 / 模板 / 导入 / AI 入口）
- [x] 导出 PDF（页面 + 数据库视图）
- [ ] 移动端适配

> 详细演进路线与里程碑见 [docs/roadmap.md](docs/roadmap.md)。

## 📄 License

MIT
