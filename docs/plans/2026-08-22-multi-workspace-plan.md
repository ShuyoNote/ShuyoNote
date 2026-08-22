# 多工作空间（多空间 / Multi-Workspace）实现方案

> 目标：把 ShuyoNote 从一个「单一空间」升级为「**多空间隔离**」的应用——每个空间是独立的页面树 + 标签 + 数据库 + 关系图 + 回收站 + 同步/加密，用于「生活 / 工作 / 项目」分离、独立备份导出删除、独立加密。核心是**隔离语义 + 查询 scope 修正 + 切换 UX**，而非重新建表（数据层已基本就绪）。

## 1. 背景与竞品对照

| 竞品 | 空间概念 | 关键点 |
|------|----------|--------|
| Notion | Workspace（工作区） | 一个账号可有多个工作区，完全隔离，顶部切换器切换；各自独立页面树/权限 |
| Obsidian | Vault（仓库） | 一个文件夹即一个 vault，vault 之间互不关联，vault 选择器切换 |
| 思源笔记 | 文档库 / 子文档库 | 文档库是顶层容器，各自独立的文档树 |
| ShuyoNote 现状 | 单空间 | `workspaces` 表 + `pages.workspace_id` FK 已存在，但**只有一个默认空间、无切换/新建/删除、查询未按空间过滤** |

**结论**：竞品都指向「**隔离容器**」。ShuyoNote 的数据层半就绪，缺的是：**多空间的创建/切换/删除、活动空间状态、以及所有查询按 `workspace_id` 过滤**。本方案把这三点补齐，并把「多空间」与已有「文件夹」明确区分开（文件夹=空间内部层级，空间=顶层隔离容器）。

## 2. 现状盘点（代码已核实）

### 2.1 已具备
- `workspaces` 表：`id / name / created_at / updated_at`（`src-tauri/src/db.rs`）。
- 初始化时创建默认空间 `default` / "默认空间"（`db.rs` 的 seed 逻辑）。
- `pages.workspace_id TEXT NOT NULL REFERENCES workspaces(id)`；`PageMeta` / `PageDetail` 都带 `workspace_id`。
- 同步 outbox 自带 `workspace_id`（`sync.rs` upsert `excluded.workspace_id`）。
- backlinks / tags / trash / database / properties 查询均 `SELECT ... workspace_id`。

### 2.2 缺失 / 需修正
| 项 | 现状 | 问题 |
|----|------|------|
| 查询 scope | `list_pages` 用 `WHERE deleted_at IS NULL`，**不带 workspace_id** | 加入第二个空间后会把两空间页面混在一起 |
| 活动空间 | 无 `active_space_id` 概念 | 无法知道当前在哪个空间 |
| 切换 UX | 无空间切换器 / 命令面板入口 | 只有一个空间，无需切换 |
| 空间 CRUD | 仅 `get_workspace_name` / `rename_workspace`，且 `get` 取第一条 | 不能新建/删除；重命名只作用于第一条 |
| 创建页面 | `create_node` 的 INSERT 需携带 `workspace_id` | 需改成写入活动空间 |
| 每空间设置 | 主题/空间名等偏应用级 | 空间名应属于活动空间；主题可做成每空间 |

## 3. 核心概念：隔离什么 / 共享什么

| 归属 | 内容 |
|------|------|
| **空间内隔离** | 页面树（page/database/folder）、标签、数据库、回收站、**块引用 / 嵌入 / 反链图**、属性、附件引用、**同步版本线**、**E2EE 密钥**、空间级设置（名称/图标/主题）、版本历史 |
| **应用级共享** | 可执行程序、窗口/系统设置、命令面板；附件**底层存储**内容寻址共享（去重省空间），归属按引用算 |
| **可选共享（Phase 4）** | 全空间全局搜索（可开关）、共享模板库、跨空间复制页面（需重映射块引用） |

> **红线**：块引用 / 反链图**必须留在空间内**，否则删除一个空间会产生悬空引用。跨空间块引用推迟。
> **不要退化成文件夹**：多空间是「比文件夹更高一层的隔离容器」，与页面树里的文件夹职责不同。

## 4. 数据模型（SQLite）

### 4.1 扩展 `workspaces`

```sql
-- 追加列（迁移用 ALTER TABLE ADD COLUMN，或重建表）
ALTER TABLE workspaces ADD COLUMN icon TEXT NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN theme TEXT;                 -- 可选：每空间主题，NULL=跟随应用
ALTER TABLE workspaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
-- 删除标记：软删，避免直接毁灭整棵页面树
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;
```

### 4.2 活动空间状态

- 持久化建议：前端 `localStorage('shuyonote:activeSpaceId')` 最简；多窗口场景用 `app_settings` 键值表兜底。
- 前端 `useSpaceStore`（zustand）：`{ spaces, activeId, setActiveId, refresh }`。
- 后端命令 `get_active_space_id` / `set_active_space_id` 读写 `app_settings`（`key='active_space_id'`）。

### 4.3 迁移策略
- 保留现有 `default` 空间为首个空间，名称仍为「默认空间」。
- 所有已有页面 `workspace_id` 已指向 `default`，无需回填。
- 把「重命名空间」从「改第一条」改为「改活动空间」。

## 5. 查询 scope 修正（正确性大头）

所有内容查询必须按 `workspace_id = active` 过滤。逐处核对：

| 文件 / 查询 | 处理 |
|------------|------|
| `commands.rs::list_pages` | `WHERE deleted_at IS NULL` → `AND workspace_id = ?` |
| `commands.rs::create_node` | INSERT 写入活动 `workspace_id` |
| `backlinks.rs` | 反链来源（`p`）按同一 `workspace_id` 过滤 |
| `tags.rs`（标签面板/侧栏筛选） | 标签下的页面列表按 `workspace_id` 过滤 |
| `trash.rs` | 回收站列表按 `workspace_id` 过滤（**每空间独立回收站**） |
| `database.rs` / `properties.rs` | 数据库查询按 `workspace_id` 过滤 |
| 全文搜索（FTS） | 结果按 `workspace_id` 过滤，返回 `space_id` 供跳转 |
| `sync.rs` | 已带 `workspace_id`；服务端需**按 `space_id` 命名空间**（外包变更、LWW、tombstone 均按空间存储） |

> 建议抽一个辅助 `fn workspace_filter(active: &str) -> String` 拼接片段，避免散落字符串；或在每处查询显式加参数。

## 6. 前端设计

### 6.1 空间切换器
- 位置：侧边栏顶部（当前 logo / 空间名处），点击弹出空间列表 + 「＋ 新建空间」。
- 列表项：图标 + 名称 + 当前空间高亮；点击切换。
- 支持右键 / 悬停菜单：重命名、导出、删除。

### 6.2 命令面板
- 新增命令：`切换空间`（列出所有空间）、`新建空间`。
- 快捷键预留 `Ctrl+Shift+O`（Open space）。

### 6.3 每空间设置
- 「设置个人模板」等空间级内容移动为**当前空间作用域**。
- 主题可做成**每空间**（`workspaces.theme`）或保持应用级（MVP 先应用级，Phase 3 再每空间）。

### 6.4 切换动作
- `setActiveSpace(id)`：写 `active_space_id` → 刷新 `list_pages` → 清空 `currentId/current` → 关闭模板中心/弹窗 → 重载标签/关系图/回收站。

## 7. 后端命令（新增）

| 命令 | 入参 | 出参 |
|------|------|------|
| `list_workspaces` | — | `[{id,name,icon,sort_order}]` |
| `create_workspace` | `{name}` | 新空间（写入 `workspaces`，种子默认首页） |
| `rename_workspace` | `{id,name}` | —（改造现有：作用于指定 id，而非第一条） |
| `delete_workspace` | `{id, hard?}` | 软删（`deleted_at`）或确认后硬删（级联删除页面树 + 关系图 + 标签关联）；删除前提示先导出 |
| `set_active_space_id` / `get_active_space_id` | `{id}` / — | — / id |
| `export_workspace` | `{id}` | 触发导出（复用整库备份，按空间过滤页面 + 附件子集） |

> 注册进 `lib.rs`；`workspaces` 变更加入 `db.rs` 迁移；新增 `src-tauri/src/workspaces.rs` 集中放空间命令。

## 8. 同步与加密

- **同步**：sync-server 数据表增加 `space_id` 命名空间；outbox 变更记录、页面 LWW 比较基准、墓碑（tombstone）均按 `space_id` 存储，不同空间互不干扰；创建/删除空间不影响其他空间同步。
- **加密（M2 端到端加密预留）**：**每空间一个密钥**，存本机密钥库。这样「隔离一个空间」意味着独立可解密 / 可独立删除，而不是一把钥匙开所有门。

## 9. 实施顺序（里程碑）

- **M1（隔离底座 + 查询 scope + 切换器）**：`app_settings(active_space_id)` + `useSpaceStore` + `list_workspaces/create_workspace` + 所有内容查询按 `workspace_id` 过滤 + 侧栏顶部空间切换器 + 切换时清空当前页。验收：新建两个空间互不干扰、切换后页面树/标签/回收站正确刷新、`list_pages` 不再串空间。
- **M2（生命周期 + 删除安全）**：`rename_workspace`（作用于指定空间）、`delete_workspace`（软删 + 导出提醒 + 确认对话框）、空间导出。验收：删除空间不影响其他空间；删除前可导出。
- **M3（每空间设置 + 独立标签/回收站/图谱隔离收尾）**：空间名/图标、每空间回收站独立、关系图仅含本空间节点。验收：各空间图谱/标签/回收站互不渗透。
- **M4（可选，跨空间）**：全空间全局搜索（可开关）、共享模板库、跨空间复制页面（重映射块引用）。

## 10. 测试与验收标准

- [ ] 新建两个空间，各自有独立的页面树 / 标签 / 数据库 / 回收站；切换后互不串。
- [ ] `list_pages` / backlinks / tags / trash / 搜索 / 关系图 均按活动空间过滤（回归验证，不混内容）。
- [ ] 创建页面/文件夹/数据库写入活动空间，重命名空间作用于当前空间。
- [ ] 删除空间为软删 + 导出提醒 + 确认对话框；不影响其他空间。
- [ ] 切换到另一空间后，`currentId` / 模板中心 / 弹窗正确清空。
- [ ] 同步 outbox 按空间隔离；不同空间同步互不影响。
- [ ] 旧数据（已有 `default` 空间）迁移后原页面完好、空间名保留。
- [ ] 附件仍是内容寻址存储，跨空间不重复占空间。

## 11. 风险与取舍

- **查询不 scope 会立即串空间**：`list_pages` 现在就不过滤，加入第二个空间立刻暴露——M1 必须先把 scope 修正做完再开放新建空间。
- **块图跨空间泄漏**：反链/引用必须限制空间内，否则删除产生悬空引用；跨空间链接推迟到 Phase 4。
- **删除空间是破坏性大操作**：软删 + 导出提醒 + 二次确认；不要把「删除空间」做成一个普通删除。
- **别退化成文件夹**：空间是隔离容器，与页面树文件夹职责不同，避免冗余。
- **每空间加密钥**：隔离才成立；一把钥匙开所有门会削弱「独立删除/独立解密」的价值。
- **主题作用域**：MVP 先应用级主题，避免「每空间主题」扩大状态面；Phase 3 再评估。

## 12. 结论

多空间对 ShuyoNote 的价值是「生活/工作/项目分离、独立备份导出删除、独立标签与图谱、独立同步/加密」，对**协作**不是刚需（那是另一个能力）。所以**阶段 1 与阶段 2 收紧做**，跨空间能力（全局搜索 / 共享模板 / 跨空间引用）放到阶段 4 按需开启。
