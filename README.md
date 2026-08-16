# ShuyoNote

本地优先（local-first）的类 Notion 笔记应用。基于 **Tauri 2 + Lexical + SQLite** 构建，数据全部存储在本机，离线可用，支持多设备同步。

## 功能

- **富文本编辑**：标题、段落、粗体/斜体/删除线、链接、引用、代码块、列表
- **块系统**：斜杠菜单（`/`）插入 11 种块 —— 标题 1/2/3、正文、引用、Callout、代码块、待办、无序/有序列表、分隔线
- **页面树**：页面可无限嵌套、拖拽移动、递归删除
- **自动保存**：输入即持久化，防抖写入 SQLite，无「保存」按钮
- **全文搜索**：FTS5 + trigram 分词，支持中文子串检索、结果高亮
- **Markdown**：快捷键输入、一键导入/导出
- **多设备同步**：outbox 变更日志 + 页面级 LWW，自建同步服务端

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2.x（Rust 后端 + 系统 WebView） |
| 编辑器 | Lexical（`@lexical/react`） |
| 前端 | React 19 + TypeScript + Vite |
| 状态管理 | Zustand |
| 本地数据库 | SQLite（rusqlite，bundled）+ FTS5 |
| 同步 | outbox 变更日志 + LWW + 自建 Rust Axum 服务端 |

## 开发环境要求

- Node.js ≥ 20、pnpm
- Rust stable（1.94+）、cargo
- Windows / macOS / Linux

## 本地开发

```powershell
pnpm install

# 若 cargo 使用镜像源且遇 SSL 撤销错误（如 USTC），临时关闭撤销检查：
$env:CARGO_HTTP_CHECK_REVOKE="false"

pnpm tauri dev
```

首次启动会在系统应用数据目录（Windows 为 `%APPDATA%\com.cnzen.shuyonote\`）创建 `shuyonote.db`（SQLite，WAL 模式）。

## 构建发布

```powershell
pnpm tauri build
```

## 多设备同步

### 1. 启动同步服务端

```powershell
cd sync-server
cargo run -- --port 8787 --db <数据目录>/shuyonote-sync.db
# 或直接运行编译产物：
# .\target\debug\shuyonote-sync-server.exe --port 8787 --db <path>
```

### 2. 在应用中配置并同步

1. 侧边栏点「同步」
2. 填写服务器地址（如 `http://localhost:8787`，跨设备填局域网 IP 或公网地址）
3. （可选）填写令牌
4. 点「立即同步」

**同步机制**：本地每次写操作都会在 `changes` 表记录一条 outbox 变更；`同步` 时先 push 本地增量，再 pull 服务端增量，按页面级 `updated_at` 做 last-write-wins 合并。删除走墓碑，物理清理留待后续。

## 项目结构

```
ShuyoNote/
├── src/                      # 前端（React + Lexical）
│   ├── editor/               # 编辑器、自定义节点、插件
│   ├── components/           # 侧边栏 / 页面树 / 搜索 / 同步面板
│   ├── store/                # Zustand
│   └── lib/                  # Tauri IPC 封装
├── src-tauri/                # Tauri 后端（Rust）
│   └── src/
│       ├── db.rs             # SQLite 连接 / 迁移
│       ├── commands.rs       # 页面 CRUD 命令
│       ├── search.rs         # FTS5 检索
│       └── sync.rs           # outbox / LWW / push-pull
├── sync-server/              # 同步服务端（独立 Rust 二进制）
└── docs/plans/               # 开发方案文档
```

## 设计文档

完整架构与开发方案见 [docs/plans/2026-08-15-local-first-note-app-plan.md](docs/plans/2026-08-15-local-first-note-app-plan.md)，包含需求分析、数据模型、ADR、同步协议与路线图。

## 后续计划（阶段 5）

- 附件同步（内容寻址去重）
- 端到端加密
- 自动定时同步
- 反链 / 标签
- 数据库视图（表格 / 看板）
- 插件系统
