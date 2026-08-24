# Web 功能补齐与体验优化（建议清单）方案

> 目标：把当前「桌面已实现、web 空桩/占位」的命令与交互短板，以及数据安全、搜索、拖拽、存储统计等体验缺口，**按优先级**逐项落地，让 web/桌面能力真正对齐。**这是一份"待办清单 + 分项方案"的汇总文档**，每项可独立实现、独立验证；不要求一次性做完，也不做架构级重写。
> 关联方案：[跨平台适配](plans/2026-08-24-cross-platform-plan.md)（M16 全平台底座）与 [每空间独立存储](plans/2026-08-22-per-workspace-storage-plan.md)（存储布局）；受益于 M16.1b 已打通的 web 真实 SQLite / 属性 / 数据库 / 版本 / 块引用 / 备份。

> ⚠️ **本方案定位**：**建议清单 / backlog**，未进入实现。文中各分项标记「优先级 / 状态」，`roadmap.md` 按「规划（待落地）」登记，**未标记 ✅**。当前 app 继续正常（桌面 / web 皆可跑）。

---

## 1. 背景与动机

在持续迭代中，web 版（`web.ts`）作为 **M16.1b 浏览器/移动壳** 已覆盖核心 CRUD（真实 SQLite、属性/数据库、版本历史、块引用、备份、PWA）。但对照桌面（Rust）实现，仍有**一批命令是空桩/占位**，以及若干**影响真实使用体验**的缺口。

### 1.1 web 端「空桩/占位」命令盘点（基于 `web.ts` 排查）

| 命令 | 桌面行为 | web 现状 | 影响 |
|---|---|---|---|
| `move_attachment` | 移动新文件归属 | 空操作 | 文件管理器"移动"不生效 |
| `remove_attachments` | 批量删除附件 | 返回 0 | 文件管理器"批量删除"不生效 |
| `restore_attachment` | 从回收站恢复附件 | 返回 null | 附件回收站无法恢复 |
| `get_attachment` | 读取附件元数据 | 返回 null | 依赖方拿不到数据 |
| `copy_attachment` | 复制附件到别处 | 空操作 | 附件复制失效 |
| `storage_stats` | 真实 bytes | `db_bytes`/`attachment_bytes`/`trash_bytes`/`version_bytes` 全 0 | 存储面板显示不准 |
| `search`/`search_blocks` | FTS 全文搜索 | SQL `LOWER(...) LIKE` | 搜索精度/相关性弱 |
| 加密（`set_encryption` 等） | 端到端加密 | 空操作（浏览器无密钥管理） | 可接受（平台限制） |
| 同步（`set_sync_config`/`sync_now`） | 自建 sync-server | 空操作 | 可接受（浏览器无后端） |
| 插件（`run_plugin_command`） | `boa_engine` 沙盒 | 返回空对象 | 可接受（插件为桌面特性） |

> 标注「可接受」的项属于**平台能力边界**（浏览器没有对应原生能力），不是缺陷；本方案聚焦**真正影响 web 使用的功能缺口**（附件移动/批量删除、存储统计、搜索）。

### 1.2 通用体验/质量缺口

- **侧边栏拖拽**（已做指针拖动）仍可补：拖到文件夹自动展开、拖到树顶/底部自动滚动、更细的插入线预览。
- **写库安全性**：`sqliteStore.run` 后 `persist()`（整库快照写 IndexedDB）**无失败回滚/重试**，写入失败会静默丢数据。
- **大媒体内存**：`save_image`/`import_attachment_files` 在 web 仍全量读字节进内存（Blob URL），大视频吃内存。
- **测试覆盖**：web 冒烟 117 项主要覆盖 CRUD；拖拽、看板、错误路径无自动化。

---

## 2. 分项方案（按优先级）

### 2.1 🥇 P0 — 附件移动 & 批量删除真正生效（功能缺口）
- **问题**：`move_attachment` / `remove_attachments` / `restore_attachment` 在 `web.ts` 是空操作，文件管理器里"移动 / 批量删除 / 从回收站恢复附件"点了没反应。
- **做法**：在 `web.ts` 补真实 SQL + blob 处理：
  - `move_attachment(id, target_page_id)`：`UPDATE attachments SET page_id = ? WHERE id = ?`。
  - `remove_attachments(ids[])`：按 id 删除行（可选：字节仍可经 `cleanup_orphan_attachments` 清理，不即时删 blob）。
  - `restore_attachment(target_page_id, source_id)`：把软删附件恢复归属到目标页面。
- **验收**：文件管理器移动/批量删除/恢复附件后，`list_page_attachments` 与侧边栏 `TreeFiles` 同步正确；新增冒烟断言。

### 2.2 🥇 P0 — 存储统计精确化
- **问题**：`storage_stats` 的 `db_bytes`/`attachment_bytes`/`trash_bytes`/`version_bytes` 全 0，存储面板显示不准。
- **做法**：`db_bytes = store.snapshot().length`；`attachment_bytes = Σ blobStore entries.bytes.length`；`trash_bytes`/`version_bytes` 从对应表 `content_text`/`content_json` 长度累加。
- **验收**：存储面板显示真实大小；新增断言（`storage_stats` bytes > 0）。

### 2.3 🥇 P0 — 全文搜索（FTS）
- **问题**：`search` 用 `LOWER(title/content_text) LIKE`，无相关度、无分词；笔记 App 的搜索是核心体验。
- **做法**：web 版引入轻量 FST 或分词索引。方案：在 `sqliteStore` 维护 `search_index`（词频倒排）或复用 `FTS5`/`SIMPLE` 虚拟表；`search` 按相关度排序 + 高亮片段。**优先实现打分排序（TF）+ 时间衰减**，够用即不引外部依赖。
- **验收**：搜索命中精度提升；中英文分词可用；现有 `search`/`search_blocks` 用例仍绿。

### 2.4 🥈 P1 — 侧边栏拖拽体验补完
- **问题**：指针拖动已可用，但缺少自动展开/滚动，落点区 width 固定。
- **做法**（纯前端，增量）：
  - **拖到文件夹 hover 一定时长自动展开**（需要把某个 `TreeItem` 的 `expanded` 提升为可外部驱动的状态，或经 `useTreeDrag` 发指令）。
  - **拖到树顶/底部自动滚动**（`dragRef` 监听 `mousemove` 越界，`scrollBy`）。
  - **插入线实时预览**（把当前 `zone` 对应的目标行插入线再强化）。
- **验收**：拖动跨层级 / 大树滚动 / 精确落点都顺手。

### 2.5 🥈 P1 — 写库失败回滚 & 提示
- **问题**：`persist()` 失败静默。
- **做法**：`SqliteStore.persist()` 捕获 `adapter.save` 错误，`console.error` + 可选 toast；持久化失败时**不阻塞内存状态**（数据仍在内存，只是未落盘），并可加一个"未保存"角标。**不阻断主流程**，避免持久化失败把所有写库都弄崩。
- **验收**：模拟 adapter 失败时不抛错打断 CRUD；控制台有明确错误。

### 2.6 🥈 P1 — 大媒体内存优化
- **问题**：web `save_image`/`import_attachment_files` 全量内存读写，大视频吃内存。
- **做法**：
  - 列表页/文件管理对**视频**显示缩略占位而非全量加载；预览时才按需读。
  - 限制单文件大小上传（如 >50MB 提示走桌面）；或改 **IndexedDB 分片写入**。
- **验收**：插入/预览大视频不卡死、不 OOM。

### 2.7 🥉 P2 — 自动化测试补强
- **问题**：拖拽、看板、错误路径无自动化。
- **做法**：把拖拽的 `computeReorder`、`move_page` 语义抽成纯函数单测；为主流程补 `node:test`/vitest；给 `search` 打分排序加用例。
- **验收**：新增断言覆盖 P0/P1 各项，冒烟测试数提升。

---

## 3. 里程碑建议（对齐 M16 后续）

- **M16.6 web 能力补齐（P0）**：§2.1 附件移动/批量删除 + §2.2 存储统计精确化 + §2.3 全文搜索。这三项是"web 用户可直接感知"的硬缺口，**优先做**。
- **M16.7 web 体验优化（P1）**：§2.4 拖拽补完 + §2.6 大媒体内存 + §2.7 测试补强。
- **M16.8 web 数据安全（P1）**：§2.5 写库失败回滚/提示。
- **平台边界项（不纳入本轮）**：加密 / 同步 / 插件在浏览器是能力边界，保留桌面实现，web 维持"降级但不崩"。

## 4. 测试与验收标准

- [ ] 文件管理器：移动附件 / 批量删除 / 从回收站恢复附件，`list_page_attachments` + 侧边栏 `TreeFiles` 同步正确。
- [ ] 存储面板显示真实 `db_bytes`/`attachment_bytes`/`trash_bytes`/`version_bytes`。
- [ ] `search` 返回按相关度排序的结果，中文/英文都能命中。
- [ ] 侧边栏拖拽：跨层级、大树滚动、自动展开均顺手。
- [ ] 模拟持久化失败时不崩溃、有明确错误提示。
- [ ] 大视频上传/预览不卡死、不 OOM。
- [ ] 冒烟测试（`scripts/smoke-web.mjs`）对应新增断言全绿；原 117 项无回归。

## 5. 风险与取舍（诚实标注）

- **最小改动、不做架构重写**：本方案全部是 `web.ts`/组件层的增量补齐，不碰 storage-core 重构，也不会破坏桌面形态。
- **搜索是自己的 FTS 而非外部服务**：优先做打分排序，克制（不引入重量级搜索依赖），确认够用再进阶。
- **大媒体**：`blobUrl` 已是惰性读；本方案做"上传限制 + 预览按需"，不追求浏览器内流式大视频全功能（那是多平台壳的长期项）。
- **写库失败**：选择"不阻断内存状态 + 提示"，而非失败就回滚整个事务——因为整库快照持久化是"尽力而为"，回滚会让 UI 死锁；先保证不丢内存数据、有可见信号。

## 6. 结论

web 版已具备与桌面对齐的核心能力（真实 SQLite、属性/数据库、版本、块引用、备份、PWA）。**当前最值得做的是补 P0 三项：附件移动/批量删除、存储统计精确化、全文搜索**——它们直接影响 web 用户的真实使用。随后是拖拽体验、写库安全、大媒体内存与测试补强。加密/同步/插件归为平台能力边界，不在本轮。全部为增量实现、可独立验证。

配套取舍见[设计哲学](design-philosophy.md)（本地优先 + 数据可移植）。
