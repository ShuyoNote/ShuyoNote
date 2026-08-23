# 「每工作空间独立存储（物理隔离）」实现方案

> 目标：把 ShuyoNote 从「**单库 + 全局附件，空间逻辑隔离（workspace_id）**」升级为「**每个工作空间独立的 SQLite 数据库文件**（物理隔离）」——让每个空间可**单独搬移 / 单独备份 / 单独加密 / 独立删除**，数据主权按空间颗粒度。
> 由 [多工作空间方案](plans/2026-08-22-multi-workspace-plan.md) 的 M10 演进而来，是其「隔离语义」的**物理化**。**这是一次高成本、高风险的架构变更**，故必须走**安全分阶段迁移**（见 §5），并保留回滚。

> ⚠️ **实现落地说明（M15 已达成，与下文「提议」有偏差，以下文实际实现为准）**：
> - **数据库** → 物理隔离：每空间一个独立 SQLite 库 `spaces/<ws_id>/*.db`，`meta.db` 管理空间清单/同步/模板/插件状态。✅ 与提议一致。
> - **附件** → **实际采用「全局内容寻址附件库」`attachments/`（跨空间共享字节、按内容去重），而非建议中的「每空间独立附件目录」**。这是实现决策：规避「每空间附件目录全链路整改」的爆炸半径，同时保留附件字节的跨空间去重。该空间的可搬移性由「按该空间引用筛出附件子集」的 `export_workspace` 空间包实现（见 §5.2-4、§7 M15.3）。
> - **`attr_defs`/标签/模板**：模板按应用级（`meta.templates`）全局；`attr_defs`/标签按每空间库存（同提议）。
> - **E2EE 密钥 / 同步游标**：保持**每空间**独立（同提议）。
> - 因此：**「每空间附件独立目录」是本方案的原始提议，但未被实现**；下文 §1/§2/§3.2/§5.2/§8 中涉及「附件目录」的描述记作**已舍弃/未采用**，请以本文「实现落地说明」+ [roadmap M15](roadmap.md) 的最终状态为准。

## 1. 背景与动机

| | 现状（方案 A：逻辑隔离） | 目标（方案 B：物理隔离） |
|---|---|---|
| 数据库 | 单文件 `shuyonote.db` | 每空间 `spaces/<ws_id>/shuyonote.db` |
| 附件 | 全局内容寻址 `attachments/`（跨空间去重） | **（原始提议：每空间独立目录；实际实现：保持全局内容寻址，空间级子集导出——见顶部实现落地说明）** |
| 隔离 | 逻辑（`pages.workspace_id` + 查询 scope） | 物理（独立库文件） |
| 单空间搬移/备份 | 难（`export_workspace` 未实现） | **易**（`export_workspace` 空间包 = 库 + 该空间引用附件子集） |
| 单空间加密 | wire 层、同文件 | 可**按文件**整体加密（当前为每空间 E2EE 密钥 + wire 加密） |
| 删除空间 | 软删 + 集中物理清理 | 删空间目录/库文件（干净） |
| 单空间损坏 | 影响整库 | 只影响该空间 |

**核心收益**：① 单空间可整体搬走 / 单独备份 / 单独交付；② 每空间文件可独立加密；③ 空间间规模隔离、故障隔离；④ 数据主权细粒度到空间。

## 2. 目标架构（存储布局 + 表归属）

```
<app_data_dir>/
├── meta.db                    # 应用级共享状态（跨空间）
│   ├── workspaces             # 空间清单（id/name/theme/icon/sort_order/...）
│   ├── sync_state             # active_workspace_id / device_id / 应用/每空间同步游标
│   ├── templates              # 模板（built_in 全局 + 我的模板）
│   └── plugin_state           # 插件启停（应用级）
├── attachments/               # 附件字节（全局内容寻址，跨空间去重）——实际实现
└── spaces/
    ├── <workspace_id>/
    │   └── shuyonote.db       # 该空间全部内容（WAL）
    │       ├── pages / page_props / attr_defs / page_tags / tags
    │       ├── backlinks / blocks / database_columns / db_views / db_rule
    │       ├── page_versions / page_fts
    │       └── changes(该空间 outbox) / attachments(该空间文件表，引用全局字节)
    └── <workspace_id2>/ ...
```
> 注：`spaces/<ws_id>/attachments/`（每空间附件目录）为**原始提议**，实际未采用——附件字节统一放全局 `attachments/`。

### 2.1 表归属（关键）

| 表 | 归属 | 说明 |
|---|---|---|
| `workspaces` / `sync_state`(active/device) / `templates` / `plugin_state` | **meta.db（应用级）** | 跨空间共享；`active_workspace_id` 由此读 |
| `pages` / `page_props` / `attr_defs` / `page_tags` / `tags` / `backlinks` / `blocks` / `database_columns` / `db_views` / `page_versions` / `page_fts` / `changes` / `attachments` | **每空间库** | 内容数据；每库只含一个空间，`workspace_id` 列可**移除**（冗余） |
| 附件**字节** | **全局 `attachments/`（实际实现）** | 内容寻址，**全局去重**；`spaces`/`attachments` 表只记录引用，不复制字节（原始提议「每空间目录」未采用） |

> **代价（诚实标注）**：
> - `attr_defs` 变为**每空间一份**——「同名属性跨库语义一致」的哲学在物理隔离下**不再成立**（每个空间有自己的属性定义）。这是物理隔离的必然取舍。
> - 附件去重：**保留全局内容寻址去重**（跨空间相同文件共享一份字节），这与「每空间附件目录（空间内去重）」相反——为实现简单与去重收益，牺牲了「每空间附件物理独立」。单空间的可搬移性改由 `export_workspace` 的空间级附件子集导出实现。

## 3. 关键设计决策

1. **连接层改造**：`Db(Mutex<Connection>)` → `Db { meta: Mutex<Connection>, spaces: Mutex<HashMap<String, Connection>> }`；提供 `conn_for(space_id)` 按需打开/缓存每空间连接。**所有内容命令必须先解析 `active_workspace_id` 再打开对应库**。
2. **附件**：**实际实现 = 全局内容寻址 `attachments/`（跨空间去重）+ 空间级附件子集导出**。原始提议「每空间一个 `attachments/` 目录（空间内去重）」**未采用**，原因见顶部实现落地说明。
3. **outbox/同步**：每空间一个 `changes` 表 + 每空间同步游标（`sync_state` 按 `space_id` 命名空间）——空间同步线独立。
4. **模板**：保持**应用级**（`meta.db`），跨空间共享（`built_in` 全局 + `我的模板` 全局可见）。
5. **E2EE**：每空间一个库文件 → 每空间一把钥匙，可**整体加密该文件**（比 wire 层更强的粒度）。
6. **db_rule / db_views**：随空间库走（是数据库页的配置）。

## 4. 跨空间能力适配（必须改）

| 能力 | 现状（单库） | 改后（跨库） |
|---|---|---|
| **全空间搜索** | 单 `page_fts` + `all_spaces` | 遍历所有空间库，各自 FTS 检索后 **Rust 层聚合**（前端不变） |
| **跨空间复制页面** | 单 `copy_page_to_workspace` | 打开目标空间库，跨库插行 + **复用全局附件字节**（仅复制附件行/引用，不复制字节），重新映射块引用 |
| **共享模板** | `templates`（全局） | 不变（meta.db 全局） |
| **移动附件（move_attachment）** | 单库改 `page_id` | 仅空间内；跨空间移动需复制附件行（字节全局共享，无需拷贝） |
| **空间清理 / 统计** | 单库统计 + 全局零引用 | 每空间库分别统计；孤儿附件按**全局零引用**判断（各处空间引用全没了才删） |

## 5. 迁移方案（安全、可回滚）—— 只做一次，绝不丢原库

### 5.1 前置
- 迁移前**先整库备份**（复用 `export_backup`，产出原单库 zip）。**原库保留**，迁移成功并验证后才归档。

### 5.2 分阶段
1. **阶段 0（底座）**：建 `meta.db`，把 `workspaces` / `sync_state`(active/device) / `templates` / `plugin_state` 迁入；`meta.db` 先与单库并存。
2. **阶段 1（拆库器，幂等+可续）**：对单库中**每个非删除空间**，建 `spaces/<ws_id>/shuyonote.db`，把该空间的
   `pages/props/attr_defs/tags/page_tags/backlinks/blocks/database_columns/db_views/db_rule/page_versions/page_fts/changes` **按 `workspace_id` 过滤**复制过去（build 其 FTS/块图）；该空间页面引用的**附件行**随库复制（引用全局字节，不复制字节子集——全局附件库已含这些字节）。
   - **幂等**：记录已迁移空间 id，重跑跳过；**可续**：失败重试不丢进度。
   - **校验**：每个空间库行数 == 原库该空间行数；FTS 行数 == pages 行数。
3. **阶段 2（命令层改造）**：所有 Rust 命令改为「解析 active → `open_space_conn(space)`」；查询去掉 `workspace_id` 过滤（每库单空间）；`active_workspace_id` 改读 `meta.db`。逐个回归 list/tags/trash/search/graph/backlinks/db/属性/版本。
4. **阶段 3（跨空间适配）**：全空间搜索跨库合并、跨空间复制跨库实现、备份/导出改为
   - `export_workspace`：`spaces/<id>/shuyonote.db` + **该空间引用的附件子集**（从全局库筛出）打成一个可独立导入的 zip（**单空间搬移**）。
   - `export_backup`：`meta.db` + 所有 `spaces/*` 打包（整库）。
5. **阶段 4（验收 + 清理）**：全部 M10/M13 里程碑行为不回归；确认后归档原单库。

### 5.3 回滚
- 若某阶段失败，**原单库仍在**，可整体回退：`meta.db` 删除，`spaces/` 删除，恢复原 `shuyonote.db`。迁移是**新增 + 校验 + 切换指针**，非破坏性覆盖。

## 6. 后端 / 前端改造要点

- **Rust**：`Db` 结构改为多连接托管；新增 `connect_space(space_id)`；所有内容 command 走 `conn_for`。新增迁移器模块 `migration.rs`（拆库/校验），新增 `set_active_workspace_id` 改读写 `meta.db`。
- **前端**：`api.getActiveWorkspaceId` / `listWorkspaces` 语义不变；`search(all_spaces)` 改为跨库聚合（后端聚合，前端不变）；备份按钮加「导出当前空间」选项。
- **数据库迁移**：`meta.db` 用独立的 `meta_migrate`；每空间库用现有 schema（去掉 `workspace_id` 列）。

## 7. 里程碑（M15）

- **M15.0 元数据库 + 存储底座**：`meta.db` + `spaces/<id>/` 布局 + 多连接托管；`active_workspace_id` 改读 meta。（v 增量）
- **M15.1 拆库迁移器**：单库 → 每空间库 + **附件行**（字节全局共享）（幂等/可续/校验/回滚）。注：用户确认清理旧库、不迁移 → 以「首启重建」代替。
- **M15.2 命令层改造**：所有内容命令走 `conn_for(space)`，去掉 `workspace_id` 过滤；回归各内容查询。
- **M15.3 单空间备份/导出**：`export_workspace` / `import_workspace`（空间 = 库 + 该空间引用附件子集，zip）。
- **M15.4 跨空间适配**：全空间搜索跨库合并、跨空间复制跨库 + 附件行复用。
- **M15.5 验收 + 清理**：全功能回归；归档原单库。

## 8. 测试与验收标准

- [x] 每个空间有独立 `shuyonote.db`；`meta.db` 只含 workspaces/sync/templates/plugin。
- [x] 迁移/首启后每空间行数/FTS 行数正确；原库保留且可回滚（归档为 `.archived`）。
- [x] 切换空间 = 打开另一空间库；list/tags/trash/search/graph/backlinks/db/属性/版本 行为不回归（每库单空间）。
- [x] `export_workspace` 产出的空间包可独立导入（库 + 该空间引用附件子集一起），空间内容完整。
- [x] 全空间搜索能跨库返回各空间结果并标注空间名。
- [x] 跨空间复制页面：在目标空间库插行 + 复用全局附件字节，块引用重映射。
- [x] 空间清理按各自空间统计（软删空间库文件删除）、孤儿附件按全局零引用判断。
- [x] 每空间 `changes`（outbox）独立，同步互不影响；每空间同步游标独立。

## 9. 风险与取舍（诚实标注）

- **高成本 / 高风险**：命令层 + 连接托管全面重构；迁移是破坏性的（但设计了「新增+校验+切换」+ 原库保留回滚）。
- **附件取舍**：实际实现**保留全局内容寻址去重**（跨空间共享字节），而非「每空间附件目录（空间内去重）」——换取实现简单与去重收益，牺牲「每空间附件物理独立」；单空间可搬移由空间级附件子集导出实现。
- **跨库一致性**：全空间搜索/复制/统计从单事务变成跨库操作，需在 Rust 层聚合/拷贝，无跨库强事务。
- **attr_defs 每空间一份**：放弃「同名属性跨库一致」哲学（物理隔离的必然结果）。
- **迁移复杂度**：`workspaces`/`sync_state`/`changes`/`attachments` 等表要分清应用级 vs 空间级；拆库顺序、外键、FTS/块图重建都要严谨。
- **范围很大**：建议**一次做 M15.0–M15.2 后再决定是否继续**（M15.3/M15.4）——先把底座+迁移+命令改造做稳并验证，再上跨空间/导出。

## 10. 结论

「每空间独立存储（物理隔离）」能带来**可搬移 / 可单独备份 / 可单独加密 / 故障隔离**的真实价值；代价是**跨库一致性、attr_defs 空间化、命令层大规模重构与破坏性迁移**。附件字节**保持全局内容寻址去重**（实际实现决策），单空间可搬移由空间级附件子集导出承担。方案按 **M15.0 → M15.5 分阶段**推进（已全部达成），迁移采用「**新增 + 校验 + 切换指针 + 原库保留可回滚**」的安全策略。配套取舍见[设计哲学](design-philosophy.md)「空间是隔离容器」。
