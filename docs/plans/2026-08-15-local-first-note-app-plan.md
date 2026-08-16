# ShuyoNote 本地优先类 Notion 笔记应用开发方案

> **目标：** 基于 Tauri + Lexical 构建一款本地优先（local-first）、跨平台的类 Notion 笔记应用，数据全部存储在本机，可离线使用，后续支持多设备同步与协作。
>
> **架构：** 前端 React + Lexical 编辑器，通过 Tauri IPC 调用 Rust 后端；Rust 后端用 SQLite 存储文档与元数据、FTS5 提供全文检索、文件系统存储附件。核心是「一页 = 一个 Lexical 文档」的文档模型。
>
> **技术栈：** Tauri 2.x / Rust / React + TypeScript + Vite / Lexical / SQLite (rusqlite) / FTS5 / Zustand

---

## 1. 需求分析

### 1.1 功能需求

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 富文本编辑 | 标题、段落、粗体/斜体/链接、列表、待办、引用、代码块、分隔线 |
| P0 | 页面树 | 页面可嵌套（parent/child），侧边栏树状导航 |
| P0 | 自动保存 | 输入即持久化到本地 SQLite，无「保存」按钮 |
| P0 | 本地存储 | 全部数据在本机，离线可用 |
| P1 | 全文搜索 | 跨页面全文检索，支持中文 |
| P1 | Markdown 导入/导出 | 与外部工具互通 |
| P1 | 附件管理 | 图片、文件嵌入，内容寻址存储 |
| P1 | 斜杠菜单（`/`） | 快速插入块类型 |
| P1 | 块拖拽排序 | 块级拖拽重排 |
| P2 | 反链 / 标签 | 页面引用关系 |
| P2 | 多设备同步 | 自建同步服务，离线合并 |
| P2 | 实时协作 | 可选，多人同时编辑 |
| P3 | 数据库视图 | Notion 式表格/看板视图 |
| P3 | 插件系统 | 用户扩展 |

### 1.2 非功能需求

| 类别 | 指标 |
|------|------|
| 性能 | 键入到屏幕延迟 < 16ms（60fps）；典型页面打开 < 200ms；1 万页搜索 < 100ms |
| 启动 | 冷启动 < 1s |
| 数据安全 | WAL 模式 + 原子写 + fsync；崩溃后不丢数据；支持一键导出备份 |
| 可靠性 | RPO ≈ 0（自动保存间隔 500ms~1s）；支持导入备份恢复 |
| 体积 | 安装包 < 30MB，内存占用显著低于 Electron 方案 |
| 平台 | Windows / macOS / Linux（后续可扩展 iOS / Android） |
| 安全 | 最小化 IPC 暴露面；命令参数校验；可选本地数据加密 |

### 1.3 约束

- 单人/小团队开发，避免过度工程（YAGNI）。
- 优先本地单机体验，同步/协作作为后置阶段，不阻塞 MVP。

---

## 2. 技术选型

| 领域 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 桌面壳 | **Tauri 2.x** | Electron、Flutter Desktop | 体积小（~10MB vs 100MB+）、内存低、Rust 后端安全高性能、移动端可扩展 |
| 编辑器 | **Lexical** | ProseMirror、TipTap、Slate | Meta 出品、可扩展节点模型（契合 Notion 块概念）、官方 React 绑定、内置 Yjs 协作、活跃维护 |
| 前端框架 | **React 18/19 + TS + Vite** | Svelte、Vue | 与 Lexical 官方 React 绑定最顺、生态最全 |
| 状态管理 | **Zustand** | Redux、Jotai | 轻量、无样板，适合编辑器状态与 UI 状态 |
| 本地数据库 | **SQLite（rusqlite）** | IndexedDB、JSON 文件 | 单文件、ACID、事务、FTS5 全文检索、可直接文件级备份 |
| 数据访问 | **Rust 自定义 Tauri command** | `tauri-plugin-sql`（前端拼 SQL） | 把 SQL/迁移/事务收口在 Rust，前端不接触 SQL，类型安全、便于演进 |
| 全文检索 | **SQLite FTS5 + trigram** | Meilisearch、Tantivy | 零依赖、单文件；trigram 分词解决中文/CJK 子串搜索 |
| 附件存储 | **文件系统（内容寻址）** | SQLite BLOB | 大文件不进库，按 sha256 命名去重，元数据入 SQLite |

> 关键取舍：不用 `tauri-plugin-sql` 的前端直连 SQL，而是用 Rust command 封装。前端只调用语义化命令（`save_page`、`search`、`list_pages`），迁移、FTS 索引、事务都在 Rust 内完成，后续换存储或加同步都不动前端。

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                      前端 (WebView)                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React UI (侧边栏 / 页面树 / 命令面板)             │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Lexical Editor (RichTextPlugin + 自定义节点) │  │  │
│  │  │  - 反序列化 editorState.toJSON()             │  │  │
│  │  │  - onChange → debounce → save_page           │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │  Zustand store (当前页 / 树 / 搜索状态)           │  │
│  └───────────────────────────────────────────────────┘  │
│                          │ Tauri IPC (invoke)             │
└──────────────────────────┼───────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   Rust 后端 (src-tauri)                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ commands/    │ │ db.rs        │ │ search.rs (FTS5) │  │
│  │ pages.rs     │ │ 连接池/WAL   │ │ 中文 trigram     │  │
│  │ attachments  │ │ 迁移         │ │ 相关度排序       │  │
│  └──────────────┘ └──────────────┘ └──────────────────┘  │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              ▼                       ▼                    │
│     ┌────────────────┐      ┌──────────────────┐          │
│     │ SQLite (WAL)   │      │ 附件目录 (sha256) │          │
│     │ pages/page_fts │      │  /data/attachments│          │
│     │ workspaces     │      └──────────────────┘          │
│     └────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

**数据流：**
1. 用户在 Lexical 中输入 → `onChange` 触发 → 序列化 `editorState.toJSON()`。
2. 防抖 500ms~1s → `invoke("save_page", { id, contentJson, contentText })`。
3. Rust 在单个事务内：更新 `pages.content_json` + `content_text` → 更新 FTS5 索引（外部内容表）。
4. 侧边栏/搜索经 `invoke("list_pages")` / `invoke("search")` 读取。

---

## 4. 数据模型

### 4.1 文档模型（核心决策）

Notion 的底层是「块数据库」（每个块一行记录），Lexical 则是「单个文档编辑器」。两者有两种结合方式：

| 方案 | 说明 | 评价 |
|------|------|------|
| A. 一页一文档（**推荐**） | 每页是一个 Lexical 文档，块 = 文档根级节点（段落/标题/待办/引用…） | 与 Lexical 天然契合，性能好，光标/历史/复制粘贴正常 |
| B. 每块一个编辑器 | 每个块是一个独立 Lexical 实例 | 编辑器数量爆炸、性能差、光标与粘贴跨块问题严重，**不采用** |

**结论：采用方案 A。** Notion 的「块」映射为 Lexical 根级自定义节点；页面嵌套用「页面树」（parent_id）表达，而非内联块；内联表格、引用、代码、图片、子页面引用等用 Lexical 自定义节点在文档内表达。

### 4.2 SQLite Schema

```sql
-- 工作区（未来多空间，MVP 一个默认工作区）
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,          -- UUID
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,          -- Unix ms
  updated_at  INTEGER NOT NULL
);

-- 页面（一页一文档，content_json 存 Lexical EditorState JSON）
CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id    TEXT REFERENCES pages(id),  -- 页面树，NULL = 根
  title        TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{}', -- Lexical 序列化全文（含块结构）
  content_text TEXT NOT NULL DEFAULT '',   -- 提取的纯文本，供搜索与预览
  icon         TEXT,                        -- emoji
  cover        TEXT,                        -- 封面图路径
  sort_order   REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER                      -- 软删除墓碑（供同步）
);
CREATE INDEX idx_pages_parent ON pages(workspace_id, parent_id, sort_order);
CREATE INDEX idx_pages_updated ON pages(updated_at);

-- 附件元数据（文件本体按 sha256 存磁盘）
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  page_id    TEXT REFERENCES pages(id),
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL,          -- sha256，内容寻址去重
  mime       TEXT,
  size       INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_page ON attachments(page_id);

-- FTS5 外部内容表（索引 pages.content_text，中文 trigram）
CREATE VIRTUAL TABLE page_fts USING fts5(
  title, body,
  content='pages', content_rowid='rowid',
  tokenize='trigram'
);

-- 同步变更日志（阶段 4 使用）
CREATE TABLE changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,      -- 'page' | 'attachment'
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,      -- 'upsert' | 'delete'
  payload    TEXT,               -- 快照或 diff
  created_at INTEGER NOT NULL
);
```

> **中文检索**：FTS5 默认 `unicode61` 分词器对中文按整句切分，无法做子串检索；使用 `trigram` 分词器（SQLite 3.34+，rusqlite bundled 已含）可支持中文任意子串匹配。代价是索引略大，1 万页量级可忽略。

---

## 5. 编辑器集成设计（Lexical）

### 5.1 依赖（官方包）

```
@lexical/react        # LexicalComposer / RichTextPlugin / HistoryPlugin ...
@lexical/rich-text    # 富文本
@lexical/list         # 列表 / 待办
@lexical/code         # 代码块
@lexical/table        # 表格
@lexical/markdown     # Markdown 导入导出
@lexical/link         # 链接
@lexical/selection    # 选择/选区
@lexical/utils        # 工具
```

### 5.2 自定义节点（对应 Notion 块）

| 节点 | 类型 | 说明 |
|------|------|------|
| `CalloutNode` | 块 | 引用提示框（emoji 图标 + 背景色） |
| `TodoNode` | 块 | 复选框待办 |
| `CodeBlockNode` | 块 | 用官方 `CodeNode` 扩展语言高亮 |
| `TableNode` | 块 | 用官方 `@lexical/table` |
| `ImageNode` | 内联/块 | 图片，src 指向附件命令返回的本地路径 |
| `FileNode` | 内联 | 附件卡片 |
| `PageLinkNode` | 内联 | 指向其他页面的引用（反链基础） |
| `DatabaseNode` | 块 | 阶段 3，嵌入式数据库视图 |

每个自定义节点实现 `exportJSON` / `importJSON`，保证可序列化持久化；实现 `exportDOM` 供 Markdown/HTML 导出。

### 5.3 编辑器组合

```tsx
<LexicalComposer initialConfig={{ nodes, namespace, editable, onError, theme }}>
  <ToolbarPlugin />
  <RichTextPlugin contentEditable={<ContentEditable />} placeholder={...} />
  <HistoryPlugin />
  <AutoSavePlugin pageId={id} />   {/* onChange → debounce → save_page */}
  <SlashMenuPlugin />              {/* "/" 命令菜单 */}
  <MarkdownShortcutPlugin />       {/* # -> 标题 等 */}
  <DragDropPlugin />               {/* 块拖拽 */}
</LexicalComposer>
```

### 5.4 自动保存

- `OnChangePlugin` 中 `editorState.read(() => $getRoot().getTextContent())` 提取纯文本，`editorState.toJSON()` 取全文。
- 防抖 500ms~1s 后 `invoke("save_page", ...)`；失焦与关闭前强制 flush（`beforeunload` / Tauri `onCloseRequested`）。
- 保存命令幂等，全量覆盖 `content_json`（单文档体量小，无需 diff；阶段 4 同步再引入变更日志）。

---

## 6. Rust 后端（Tauri command）

### 6.1 命令清单（IPC 暴露面）

| 命令 | 参数 | 说明 |
|------|------|------|
| `list_workspaces` | — | 工作区列表 |
| `list_pages` | workspace_id | 页面树（id/title/parent/sort/updated） |
| `get_page` | id | 返回 content_json + content_text |
| `save_page` | id, content_json, content_text, title? | 事务内写库 + 更新 FTS |
| `create_page` | parent_id, title | 新建页，返回 id |
| `delete_page` | id | 软删除（写 deleted_at 墓碑） |
| `move_page` | id, new_parent_id, sort_order | 重排/换父 |
| `search` | query, limit | FTS5 检索，返回页 + 高亮片段 |
| `import_markdown` | markdown, parent_id | 转 Lexical JSON 入库 |
| `export_markdown` | id | Lexical JSON → Markdown |
| `export_backup` / `import_backup` | path | 全库 + 附件打包（阶段 1） |
| `read_attachment` / `write_attachment` | ... | 附件读写（sha256 内容寻址） |

### 6.2 关键实现要点

- **迁移**：`rusqlite_migration` 或手写 `PRAGMA user_version` 版本迁移，启动时自动执行。
- **连接**：单连接 + `Mutex`（或 `r2d2` 连接池），开启 `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`。
- **事务**：`save_page` 在 `conn.transaction()` 内同时更新 `pages` 与 FTS（FTS5 外部内容表仅需更新 `content_text` 源列，索引自动同步）。
- **数据目录**：`app_data_dir()` 下 `shuyonote.db` 与 `attachments/`；用 `tauri-plugin-store` 或 JSON 文件存轻量设置。
- **错误处理**：command 返回 `Result<T, AppError>`，统一序列化为前端错误码，避免 panic 泄漏到 IPC。

---

## 7. 本地优先与同步方案（单用户多设备）

> **已确认范围：单用户多设备同步。** 阶段 1–3 纯本地不阻塞；同步在阶段 4 引入，且不破坏已有本地数据层。多人协作不在此范围（仅保留未来扩展位）。

### 7.1 同步目标与粒度

- **单位：页面级**（整页 Lexical JSON 快照）+ 附件（内容寻址，按 hash 传输）。
- **场景：** 同一账号在 A/B/C 多台设备离线编辑，联网后相互收敛到一致状态。
- **冲突模型：** 页面级 LWW（last-write-wins，按 `updated_at` + 墓碑 `deleted_at`）。单用户场景下同一页面同时编辑概率低，LWW 足够且行为可预测。

### 7.2 方案对比

| 方案 | 复杂度 | 适用 | 结论 |
|------|--------|------|------|
| **快照 + LWW + 墓碑** | 低 | 单用户多设备 | 简单可靠，但每次全量快照、流量大、无法增量 |
| **变更日志（outbox/inbox，推荐）** | 中 | 单用户多设备、弱网 | 增量同步、离线排队、断点续传；是本次采用方案 |
| Yjs CRDT + `@lexical/yjs` | 高 | 多人实时协作 | 超出范围，留作未来协作扩展位 |
| 专用同步引擎（Zero / Replicache / ElectricSQL） | 高 | 复杂协作 | 重、有绑定约束；cr-sqlite 已停维护，不采用 |

### 7.3 推荐方案：outbox 变更日志 + LWW

#### 7.3.1 整体结构

```
┌─────────────┐        ┌──────────────────────┐        ┌─────────────┐
│  设备 A      │  push  │                      │  pull  │  设备 B      │
│  SQLite     │───────▶│  同步服务 (自建/轻量)  │───────▶│  SQLite     │
│  changes 表  │◀───────│  存储各设备变更日志     │◀───────│  changes 表  │
└─────────────┘  pull  └──────────────────────┘  push  └─────────────┘
```

- **同步服务**：无状态 HTTP 端点（Rust Axum，或直接复用 Tauri 侧独立服务端二进制），负责接收变更、按 `device_id` + `seq` 去重、按游标下发。
- **本地 outbox**：每个写操作在本地事务内同时写 `pages`/`attachments` 和一条 `changes` 记录，保证「写入 = 待同步」。

#### 7.3.2 变更日志表（本地 & 服务端同构）

```sql
CREATE TABLE changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- 本地/服务端自增游标
  device_id  TEXT NOT NULL,     -- 产生该变更的设备 UUID
  device_seq INTEGER NOT NULL,  -- 该设备上的本地序列号（去重用）
  entity     TEXT NOT NULL,     -- 'page' | 'attachment'
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,     -- 'upsert' | 'delete'
  payload    TEXT,              -- upsert 时为完整快照 JSON；delete 为 NULL
  updated_at INTEGER NOT NULL,  -- LWW 排序依据（客户端时钟）
  UNIQUE(device_id, device_seq)
);
CREATE INDEX idx_changes_seq ON changes(seq);
```

#### 7.3.3 同步协议（push/pull 游标）

1. **写入**（本地）：`BEGIN; UPDATE pages ...; INSERT INTO changes(...); COMMIT;`
2. **Push**：把 `seq > last_pushed_seq` 的变更批量上传；服务端按 `(device_id, device_seq)` 去重后存储，返回服务端最大 `seq` 作为新游标。
3. **Pull**：携带 `last_pulled_seq` 拉取服务端新增变更，按 `seq` 顺序本地重放：
   - `upsert` → 若本地 `updated_at` 更新则覆盖，否则忽略（LWW）；
   - `delete` → 写墓碑 `deleted_at`。
4. **游标持久化**：`last_pushed_seq` / `last_pulled_seq` 存本地 `sync_state` 表，断点续传。

#### 7.3.4 LWW 冲突细节

- 用**客户端 `updated_at`** 比较，而非服务端接收时间，避免时钟偏斜造成的乱序。
- 单用户场景下冲突罕见；若两台设备对同一页的 `updated_at` 相同（毫秒级同刻），以 `device_id` 字典序决出胜负，保证确定性。
- 删除永远是「墓碑」而非物理删除，物理清理在**所有设备都已确认收到删除且超过保留期**后统一 GC。

#### 7.3.4.1 冲突粒度权衡（本方案的核心取舍）

页面级 LWW 的**代价**：若两台设备**离线期间各自编辑了同一页**（例如办公电脑改标题、家里电脑改正文），收敛时后写的一台会整体覆盖另一台，导致「另一台的改动丢失」——因为冲突单位是整页快照，无法按字段/块合并。

冲突粒度越低，合并越精准，但实现越复杂：

| 粒度 | 丢失风险 | 实现成本 | 说明 |
|------|----------|----------|------|
| 页面级快照（当前） | 整页覆盖 | 低 | 单用户多设备、错峰编辑时几乎无感；最简 |
| 字段级（title / content_json / parent_id 分开） | 仅同字段覆盖 | 中 | 标题与正文分开比较 `updated_at`，可保住「改标题」与「改正文」互不覆盖 |
| 块级（每块独立 entity） | 仅同块覆盖 | 中高 | `changes.entity='block'`，需块 ID 稳定、块级排序冲突规则 |
| CRDT（Yjs/Automerge/Loro） | 字符级合并 | 高 | 同一段落的并写也能合并，但需编辑器绑定、同步服务升级 |

**推荐演进路径（按需升级，不一次性到位）：**

1. **MVP（阶段 4）**：页面级 LWW。接受「同一页并发编辑会覆盖」这一罕见代价，换取最小实现。
2. **若真遇到该场景**（用户反馈或自己踩坑）：先做**字段级**——把 `title` 与 `content_json` 拆成独立 `updated_at`，覆盖单位从「整页」降到「字段」，改动小、收益大。
3. **仍不够**（多人在同一页协作）：才升级 `@lexical/yjs` + Hocuspocus，走块/字符级 CRDT。

> 关键：本地 `pages` 表已同时存 `title` 与 `content_json`，`changes` 表用 `entity_id` 定位实体，只要把 `payload` 从「整页快照」改为「字段快照」（或新增 `field` 列），即可从页面级平滑迁移到字段级，无需重写同步协议。

#### 7.3.5 附件同步

- 附件本体按 `sha256` 内容寻址：上传前先查 `HEAD /attachment/{hash}`，命中则只同步元数据，未命中再传文件，天然去重与断点续传。
- 附件元数据走同一 `changes` 日志（`entity='attachment'`），文件字节单独走对象存储/文件端点。

#### 7.3.6 鉴权与安全

- 端到端：同步服务用简单账号 + 长期 token（或设备配对码）认证；传输强制 TLS。
- 可选：数据在客户端加密后再上传（端到端加密，服务端只见密文），作为后续增强，MVP 不强求。

#### 7.3.7 阶段 4 交付物

- `sync/` Rust 模块：outbox 写入、push/pull 客户端、LWW 合并器。
- 同步服务端：Rust Axum，存各设备 `changes` + 附件对象存储。
- 命令：`sync_push` / `sync_pull` / `sync_state`，前端触发（启动、定时、手动）。

### 7.4 未来协作扩展位（不在本期）

若未来要多人实时协作：在编辑器层接入 `@lexical/yjs` + Hocuspocus 服务；本地仍以 SQLite 快照为准，Yjs 只作协作传输层，落盘后写回 `pages.content_json`。当前「页面级快照 + outbox」结构保留了对块级/字段级演进的余地。

---

## 8. 关键架构决策（ADR 摘要）

| # | 决策 | 权衡与理由 |
|---|------|-----------|
| ADR-1 | 用 Tauri 2 而非 Electron | 体积/内存大幅降低、Rust 后端；代价是需维护 Rust 层 |
| ADR-2 | 用 Lexical 而非 TipTap/ProseMirror | 节点模型契合块编辑、官方 React 绑定与 Yjs 协作；成本是较新、生态相对小 |
| ADR-3 | 一页一文档，而非每块一编辑器 | 性能与光标正确性；代价是块间不能独立引用（用自定义节点补足） |
| ADR-4 | Rust command 封装 SQLite，不用 tauri-plugin-sql | 收口 SQL/事务/迁移；前端零 SQL |
| ADR-5 | 全文检索用 FTS5 trigram 而非 Meilisearch | 零额外进程、单文件备份；量级内性能足够 |
| ADR-6 | 附件用内容寻址文件系统而非 BLOB | 大文件不撑爆库、天然去重、备份友好 |
| ADR-7 | 同步用 outbox 变更日志 + 页面级 LWW，不用 CRDT | 单用户多设备场景 LWW 足够、行为可预测、实现简单；CRDT 仅为多人协作预留 |
| ADR-8 | 冲突粒度从页面级起步，预留字段级演进 | 先最小实现；`payload` 设计为可降级到字段级，避免未来重写同步协议 |

---

## 9. 项目结构

```
ShuyoNote/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── migrations/
│   │   └── 0001_init.sql
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── db.rs            # 连接 / WAL / 迁移
│       ├── models.rs
│       ├── error.rs         # AppError
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── pages.rs
│       │   ├── search.rs    # FTS5
│       │   └── attachments.rs
│       ├── sync/            # 阶段 4：outbox / push / pull / LWW 合并
│       │   ├── mod.rs
│       │   ├── outbox.rs
│       │   ├── push.rs
│       │   ├── pull.rs
│       │   └── merge.rs
│       └── migrations/
│           ├── 0001_init.sql
│           └── 0002_sync.sql   # changes / sync_state 表
├── sync-server/             # 阶段 4：独立同步服务（Rust Axum）
│   ├── Cargo.toml
│   └── src/main.rs
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── editor/
│   │   ├── Editor.tsx
│   │   ├── nodes/           # Callout / Todo / Image / PageLink ...
│   │   ├── plugins/         # AutoSave / SlashMenu / DragDrop ...
│   │   └── theme.ts
│   ├── components/          # Sidebar / PageTree / SearchPanel ...
│   ├── store/               # Zustand
│   ├── lib/                 # tauri invoke 封装 / 类型
│   └── types.ts
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 10. 开发路线图

| 阶段 | 里程碑 | 交付物 | 预估 |
|------|--------|--------|------|
| **0 脚手架** | 工程初始化 | Tauri 2 + Vite + React + TS 跑通，`invoke` 示例 | 0.5 周 |
| **1 MVP** | 单页可写可存 | 页面树 + 富文本 + 自动保存 + 增删改移页 | 2 周 |
| **2 块系统** | 完整块类型 | 待办/引用/代码/表格/图片、斜杠菜单、Markdown 导入导出、块拖拽 | 3 周 |
| **3 检索** | 全文搜索 | FTS5 + trigram、中文搜索、附件管理、备份导入导出 | 2 周 |
| **4 同步** | 单用户多设备 | outbox 变更日志 + LWW + 同步服务 + 附件内容寻址同步 | 3 周+ |
| **5 扩展** | 高级特性 | 反链、数据库视图、插件系统（可选多人协作 Yjs） | 持续 |

**MVP 完成标准：** 离线可用的本地笔记 —— 创建/编辑/删除页面、页面树导航、自动保存、重启不丢数据、基础富文本。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Lexical API 变动 | 升级成本 | 锁定主版本，自定义节点收敛在一个模块；跟进官方 changelog |
| 中文 FTS5 效果 | 搜索召回 | 用 trigram 分词器并做中文语料验证；必要时接 jieba 分词 |
| 自动保存丢数据 | 数据丢失 | 防抖 + 失焦/退出 flush + WAL + 每日自动备份 |
| 大文档性能 | 编辑卡顿 | 分页/懒加载超大文档；虚拟化长列表；限制单页规模 |
| 同步冲突 | 覆盖丢失 | 页面级 LWW（客户端 `updated_at` 比较 + `device_id` 决胜），墓碑保留；物理删除待全设备确认后 GC；同页并发编辑若频繁则升级字段级 |
| 时钟偏斜 | 乱序合并 | LWW 用客户端时间戳，同刻以 device_id 决胜；未来可换 HLC/逻辑时钟 |
| IPC 安全 | 注入/越权 | 命令最小集、参数校验、不暴露任意 SQL/任意文件路径 |

---

## 12. 参考资料

- [Tauri 官方插件生态](https://v2.tauri.app/plugin/)
- [tauri-plugin-sql 2.2.0（备选方案，本项目改用 Rust command 封装）](https://docs.rs/crate/tauri-plugin-sql/2.2.0)
- [Lexical 官方协作 FAQ](https://lexical.dev/docs/collaboration/faq)
- [Lexical 仓库（facebook/lexical）](https://github.com/facebook/lexical)
- [Tauri 跨端笔记实战：本地数据存储选型（少数派）](https://sspai.com/post/99753)
- [Local-First 架构：何时用 CRDT（DEV）](https://dev.to/raxxostudios/local-first-architecture-for-solo-apps-when-crdts-help-and-when-they-hurt-4pj0)
- [CRDT 与 Local-First 引擎对比（Yjs / Automerge / Loro / Zero 等）](https://www.youngju.dev/blog/culture/2026-05-15-crdt-local-first-engines-2026-yjs-automerge-loro-replicache-liveblocks-deep-dive.en)
- [为什么 cr-sqlite 被放弃（Replicache/Zero 对比）](https://yomotherboard.com/question/why-was-cr-sqlite-abandoned-in-favor-of-replicache-and-zero/)
- [ObjectBox Sync：并发变更与自定义冲突解决（outbox/LWW 参考）](https://objectbox.io/customizable-conflict-resolution-for-offline-first-apps/)
