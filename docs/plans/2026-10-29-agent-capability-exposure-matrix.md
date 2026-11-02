# 外部 Agent 能力暴露矩阵（v3 · 定稿）

状态：方案 v3.1 ＋ 实施进度见 §14（B1/B2/B3/UX 已落 dev；剩余项见 §14.2）。
本文是**唯一版本**（v1/v2 的评审记录已并入本文，不再保留两份）。

关联：`capabilities/capabilities.json`（注册表＝单一事实源）· `src-tauri/src/mcp_channel.rs`（默认关/只绑回环/令牌/权限位）· [`mcp-external-ai.md`](../mcp-external-ai.md)（面向用户的配置指南）· [`2026-10-29-agent-block-write-p2.md`](2026-10-29-agent-block-write-p2.md)（块级写面）。

---

## 0. 适用范围与三条总则

- **只覆盖个人版**（单用户/本机/空间级权限）。团队·企业空间的 Agent 写面**不开**（前置四问见 §10）。
- **默认关**：所有能力在用户显式打开「外部 AI 接入」前不可用；B1 落地后**仍默认关**。
- **最小面**：只覆盖常见工作流（读 → 总结 → 改块 → 整理结构 → 传附件），其余先不暴露。

## 1. 级别与批次

| 级别 | 含义 |
|---|---|
| **R** | 只读 |
| **W** | 写：必须 `expectedRev`/`expectedSha` ＋ 审计；默认权限关 |
| **Wc** | 写 ＋ **需用户当场确认**（草稿确认或系统保存框） |
| **✗** | 不暴露（进 §9.2 红测试） |

| 批次 | 主题 |
|---|---|
| **B1** | 只读扩容（含导出/下载句柄） |
| **B2** | 写扩容 ＋ 回滚 ＋ 删除/恢复同批 |
| **B3** | 专议（会打扰用户或耗算力） |

## 2. 现有 29 条注册表能力

| 能力 id | permission | 级别 | 批次 | 备注 |
|---|---|---|---|---|
| pages.list / pages.get / pages.search | read:pages | 现✓ | — | 已有；`get` 已带 `rev`＋块锚点 |
| pages.count | read:pages | **R** | **B1a** | v3 误标「现✓」——MCP 实际没有 `pages_count`（13 个工具里没有它） |
| page.current | read:page.current | R | B1 | 补"当前页"入口 |
| blocks.list | read:pages | 现✓ | — | 已有 |
| backlinks.list | read:backlinks | 现✓ | — | 已有 |
| files.list / files.search / files.read | read:files | 现✓ | — | 已有（派生文本） |
| coverage.report | read:files | R | **B3** | `host:"frontend"`，`check-capabilities` §2c 禁止进 MCP 面 ⇒ 需先建「Rust→前端」请求/应答桥（2026-10-29 决定） |
| tags.list | read:tags | R | B1 | 注册表有、MCP 未暴露 |
| properties.list | read:properties | R | B1 | 数据库/属性读前门 |
| spaces.list | read:pages | 现✓ | — | 已有 |
| pages.create | write:pages | 现✓ | — | 草稿确认 |
| pages.importMarkdown | write:pages | 现✓ | — | 整页，粗粒度 |
| pages.update | write:pages | 现✓ → 收窄为 Wc | — | 块级写落地后降级 |
| blocks.append | write:pages | 现✓ | — | 尾部追加 |
| tags.add / tags.remove | write:tags | W | B2 | 成对 |
| properties.set / properties.unset | write:properties | W | B2 | 成对；校验 attrId/类型 |
| files.export | export:files | Wc | **B1** | 需用户点保存 |
| editor.insertText | write:page.current | **✗** | — | 即时生效、插用户光标处 |
| spaces.switch | write:pages | **✗** | — | 改用户界面所在空间；不给 Agent |
| user.notify | — | **✗** | — | 弹提示＝打扰（2026-10-29 拍） |
| kv.get/set/remove、settings.get、log.write | kv:own / — | ✗ | — | 插件私有面 |

## 3. 新增能力

| 能力 | permission | 级别 | 批次 | 判据要点 |
|---|---|---|---|---|
| `pages.tree` | read:pages | R | B1 | 与 pages.list 集合一致；层级与树 UI 一致 |
| `changes_since(pages:{pageId:rev})` | read:pages | R | B1 | **页面级游标**；同 rev 两次读⇒空；改一块⇒只回该块 |
| `db.schema` | read:pages | R | B1 | 列/视图结构可与 UI 对照 |
| `db.rows` | read:pages | R | B1 | **只读原始值**；过滤用**简单 where**（白名单操作符，见 §4.4）；⛔ 不重算公式/汇总 |
| `versions.list` / `version.get` | read:versions | R | B1 | 与版本 UI 一致；读旧版不改现状 |
| `trash.list` | read:trash | R | B1 | 与回收站一致；本批不给恢复 |
| `files.stat` | read:files | R | B1 | sha/mime/size/pageId/抽取状态 |
| `files.extract_status` | read:files | R | B1 | 与 coverage 同口径 |
| `files.list_orphan` | read:files | R | B1 | `page_id IS NULL`；.shuyodoc 导入会产生 |
| `files.download` | export:files | Wc | B1 | 句柄单次+TTL 120s；sha 自证；⛔ 不塞上下文 |
| `export.markdown` / `export.docpackage` | export:files | Wc | B1 | 句柄；.shuyodoc 已实现（M1） |
| `templates.list` | read:pages | R | B1 | — |
| `templates.apply` | write:pages | Wc | B2 | 建页要草稿确认 |
| `blocks.patch / insert / delete` | write:pages | W | B2 | 见 P2 七条判据 |
| `nodes.delete`（软删） | write:pages | W | **B2** | 进回收站、可恢复、引用检查 |
| `trash.restore` | write:pages | W | **B2（与软删同批）** | 不许"能删不能恢复" |
| `pages.revert(rev)` / `audit.revert(auditId)` | write:pages | W | **B2** | 回滚后逐字一致 + 新增回滚审计 |
| `files.upload_to_page` | write:files | W | B2 | sha 自证、同名不覆盖、大小/MIME 上限 |
| `files.detach` | write:files | W | B2 | 摘归属保文件（⛔ 与 delete 分开） |
| `files.move` / `files.rename` / `files.delete` | write:files | W | B2 | delete 做引用检查，正文引用则拒绝并点名 |
| `db.rows_write` / `db.rows_delete` | write:pages | W | B2 | 类型/必填校验；v1 不写公式列 |
| `import.docpackage` | write:pages | Wc | B2 | 复用 M1 读包 + 永远新建 |
| `files.convert_to_note` / `files.reextract` | write:pages | Wc | B3 | 新建页 / 耗算力 ⇒ 专议 + 限流 |

## 4. 四条贯穿规则（每个能力都要满足）

### 4.1 空间作用域（2026-10-29 拍）
- 读：`pages.list` / `pages.search` 可选 `spaceId`（需「只读（全部空间）」档）；
- 写：统一加**可选 `spaceId`**（省略＝当前空间，行为逐字节不变）；**缺 `write_all` 档却带 `spaceId` ⇒ `permission_denied`**（⛔ 不静默回落）；
- 返回体 + 审计**必须带 `spaceId`**；⛔ 不给 `spaces.switch`；
- 判据：带 `spaceId` 写后 `spaces.list.active` 前后不变；`pages.get(id, spaceId)` 跨空间按 id 读（不属于任何空间 ⇒ `not_found`）。

### 4.2 写的一致性
全部 **W/Wc**：`expectedRev`（页面级）或 `expectedSha`（附件级）＋ `dryRun` ＋ 草稿/确认 ＋ **审计恰一条**；冲突 ⇒ `rev_conflict` 返回 `currentRev`＋当前 markdown。

### 4.3 拒绝/打扰（统一三条）
满足任一条 ⇒ 不暴露或降 Wc：① **改用户正在做的事**（光标插入、切空间）；② **绕过草稿**；③ **不可撤销**。

### 4.4 数据库过滤（`db.rows`，2026-10-29 拍）
简单 `where`：`字段 + 操作符 + 值`；操作符白名单 `= != > >= < <= in contains is_null`；字段必须来自 `db.schema`；⛔ 任意表达式/SQL；越界 ⇒ `invalid_args`。

## 5. 文件夹与附件（补 §6 的两块）

### 5.1 文件夹 = 页面树节点（`kind=folder`）
现状：只有 `pages.create`（建页），**没有建文件夹/移动/重命名/删除能力** ⇒ Agent 能写字不能整理。
- `folders.create`、`nodes.move`、`nodes.rename`、`nodes.delete`（软删）→ **B2**；
- 读前门：`pages.tree`（B1）；
- 安全：移动/删除做**环检测**＋**引用检查**（反链数量如实提示）；批量上限；⛔ 清空文件夹。

### 5.2 附件（未整理 vs 页面附件）
同一张表两态：`page_id IS NULL`＝未整理；带 `page_id`＝页面附件。**"从页摘掉" ≠ "删文件"**。
- B1 读：`files.stat` / `files.extract_status` / `files.list_orphan` / `files.download`；
- B2 写：`files.upload_to_page` / `files.detach` / `files.move` / `files.rename` / `files.delete`；
- B3：`files.convert_to_note` / `files.reextract`；
- 🔴 **detach 与 delete 必须是两条工具**（UI 现在只有"移除附件"一个动作且无确认框）；
- 🔴 删除/摘除前**引用检查**：正文仍按 sha 引用 ⇒ 拒绝并点名；软删。
- ✗：`files.bulk` / `files.purge`（批量/永久删除）。

## 6. 数据外泄约束

凡返回**原字节**或**落盘**：返回**句柄**（128bit 随机、单次、TTL 120s、绑会话）；>10 MB 或 >20 文件需用户确认；审计只记"哪个对象"，⛔ 不记内容；判据：二次使用/过期/跨会话必须失败。

## 7. 默认数值

批量 ≤50/次；文本返回 ≤200 KB/次；句柄 TTL 120s 单次；大文件阈值 >10 MB 或 >20 文件；读单页沿用现状（200 条 / 20000 字符）。

## 8. 分批与验收

| 批次 | 内容 | 批级判据 |
|---|---|---|
| **B1 只读扩容** | §2 的 R ＋ §3 的 R/Wc：pages.tree、changes_since、db.schema/rows、versions.*、trash.list、files.stat/extract_status/list_orphan/download、export.*、files.export、templates.list | 零写路径改动；每条挂载级判据；§9 元判据全绿 |
| **B2 写扩容＋回滚** | blocks.*、pages.move/rename、nodes.delete＋trash.restore、pages.revert、tags.add/remove、properties.set/unset、db.rows_write/delete、files.upload_to_page/detach/move/rename/delete、templates.apply、import.docpackage、folders.create、nodes.move | 带 rev/sha＋dryRun；冲突必拒；审计一条/次；§9 全绿 |
| **B3 专议** | spaces.switch、files.convert_to_note/reextract、批量 | owner 逐条拍 |

## 9. 判据矩阵

### 9.1 元判据（对注册表全量跑，表驱动）
1. 每条已暴露能力，权限关 ⇒ 必 `permission_denied`；
2. 每个 W/Wc 在"写操作元数据"清单里（rev/sha/dryRun/审计）；
3. 每个 R 有分页/上限参数；
4. 工具声明的能力 id ⊆ 会话已授予权限；
5. 每个写调用恰 1 条审计（批量合并也要上限）。

### 9.2 不暴露清单红测试
出现以下任一 ⇒ 失败：`editor.insertText`、`user.notify`、`kv.*`、`settings.get`、`log.write`；描述含"任意 SQL/任意 URL/按路径读取"；永久删除/清空回收站；返回**裸字节**而非句柄的下载工具。

### 9.3 跨块不变式
引用检查（附件被引用 ⇒ delete 拒绝并点名）；树不变式（move 后无环/无孤儿/父级顺序正确）；回滚不变式（revert 后逐字一致＋新增回滚审计）。

## 10. 团队/企业空间（本册不覆盖）

① Agent 以谁的身份写；② 企业角色能否被继承、跨空间越权怎么挡；③ 审计合规与保留期；④ 租户内容不得被外部 Agent 带出。四条不落，企业版不开写面。

## 11. 已拍决策（2026-10-29）

| # | 决策 | 结论 |
|---|---|---|
| 1 | B1 只读默认档 | **默认关**（保持现状） |
| 2 | 导出/下载归属 | **B1**（`Wc`） |
| 3 | `user.notify` | **不给（✗）** |
| 4 | `db.rows` 过滤 | **简单 where**（操作符白名单） |
| 5 | `rev` 形态 | `updated_at:content_json sha256 前 8 位`（零迁移） |
| 6 | 读时带块锚点 | **默认带**，`includeAnchors:false` 可关 |
| 7 | 个人版写入授权 | **首次弹一次，之后记住** |
| 8 | `write_all`（可写全部空间） | **开放但默认关**；写工具加可选 `spaceId`；返回/审计带 `spaceId` |

## 12. 下一步

**B1 开工**（只读，不改写路径）：按 §8 清单逐条实现，每能力一条挂载级判据 ＋ §9.1 元判据一起跑。之后 B2（块级写＋回滚），再谈企业版。

## 13. v3.1 修订（2026-10-29 自审后，开工前必读）

> 本节修 12 处问题；前面各节与本节的冲突**以本节为准**。可行性核对见 [`2026-10-29-mcp-capability-feasibility.md`](2026-10-29-mcp-capability-feasibility.md)。

### 13.1 事实更正
1. **`pages.count` 不是"现✓"**：MCP 实际工具只有 13 个，没有 `pages_count` ⇒ 改判 **R / B1a**（低风险，补上即可）。
2. **`pages.move` 与 `nodes.move` 重复**：统一为 **`nodes.move`**（`movePage` 底层已存在，文件夹是页面节点，同一个调用可移两者）。

### 13.2 设计补齐
3. **句柄消费方**：新增 **`blobs.fetch(handle, destPath?)`**（`Wc`）：把导出/下载句柄换成文件（用户选保存位置）；判据：句柄单次、TTL 120s、跨会话失败、二次使用失败。**没有它，B1c 的导出/下载不算完成。**
4. **幂等键**：所有 W/Wc 增加可选 `clientRequestId`；同 id 重复调用返回**同一结果**（不重复落库）；判据：同 id 连发两次 ⇒ 只落一次、`audit` 只一条。
5. **回滚保留策略**：`pages.revert(rev)` 只能回退到**仍在版本历史里**的 rev；默认保留 **每页最近 20 版 且 30 天内**（与 `cleanupOldVersions` 对齐）；超出 ⇒ `not_found`（⛔ 不假装成功）。
6. **数据库写范围**：`db.rows_write/delete` v1 **只支持简单表格（table）的原始列**；⛔ 不写关系列/公式列/汇总列；`db.rows` 明确标注"**原始值**，可能与界面计算值不同"。

### 13.3 结构性调整
7. **B1 拆三段**：**B1a**（纯读：`page.current`/`pages.count`/`tags.list`/`properties.list`/`pages.tree`（`coverage.report` 改判 B3：需前端桥））→ **B1b**（`db.schema`/`db.rows`＋简单 where）→ **B1c**（`versions.*`/`trash.list`/`files.stat`/`files.extract_status`/`files.list_orphan`/`files.download`/`export.*`/`files.export`/`blobs.fetch`）。三段各自可合入、可回滚。
8. **`nodes.delete` 语义**：删**非空文件夹** ⇒ **拒绝**并提示"N 个子项"（⛔ 不递归删）；空文件夹或页面 ⇒ 软删进回收站。
9. **`changes_since` 响应形状**：`{pageId, rev, changedBlocks:[{blockId, op:"update"|"insert"}], deletedBlockIds:[]}`；强制 `limit`（默认 100，上限 500）；无变化 ⇒ 空数组。
10. **`audit.tail`（R / B1a）**：只读最近 N 条（默认 20，上限 100）：`{at, tool, capability, targets:[ids], ok}`；**只回本会话 + 本机**；⛔ 不回内容正文、不回其他用户会话。

### 13.4 实现前必须核实的
11. **能力面指纹**：新增 capability 会改 `check-api-surface-version` 的指纹 ⇒ **每批开工前先确认是否需要 `apiVersion` 升级**（升版本要写 changelog + 判据），不要等门禁红才处理。
12. **底层接口逐条核实**：见可行性文档（结论摘要：`trash/versions/files/tags/properties/folder/move/delete/restore/export/import` 大多**已有 api**；`audit.tail`、`blobs.fetch`、`db where`、`blocks.*`、`changes_since`、`templates.apply` **需新建**）。

### 13.5 v3.1 的开工顺序（替代 §12）

1. **可行性核对**（已完成，见文档）→ 2. **B1a**（纯读 6 个，零新建命令）→ 3. **B1b**（db 读＋where，需扩展 `query_database` 过滤）→ 4. **B1c**（导出/下载＋句柄消费方）→ 5. **B2**（写＋回滚＋删除/恢复，`blocks.*` 另立 P2 实现任务）。

### 13.6 门禁前缀（A 方案，2026-10-29 拍）

`page.current` / `properties.list` 挂 `ai:true` 时被 `check-agent-surface` §4「笔记域前缀白名单」判红 —— 原因是 `NOTE_ID_PREFIXES` 漏了 `page.` / `properties.`，**不是安全边界问题**（该规则本意挡 fs/网络类能力）。

- **决定：A** —— 给 `NOTE_ID_PREFIXES` 补 `"page."`、`"properties."` 两个笔记域前缀，保住「应用内 AI 面 ＝ MCP 面同一套」，⛔ 不面分裂；
- 改门禁脚本必须附**变异证据**（账本 `_repo_mutations`）：删掉 `"page."` ⇒ 门禁必红（逐字 `ai:true 的能力「page.current」不在**笔记域**前缀集里`）⇒ 还原必绿；
- `coverage.report` 从 B1a 移出、改判 **B3**：它是 `host:"frontend"`，而 `check-capabilities` §2c 明令前端宿主能力不得进 MCP 清单 ⇒ 要接必须先建「Rust→前端」请求/应答桥（超出 B1a 范围，⛔ 不手改生成物硬塞）。
## 14. 实施进度（2026-10-30 收口）

### 14.1 已完成（全部在 `dev`，已推 GitCode；GitHub 已推到 `bf9f1b13`）

| 范围 | 内容 | 状态 |
|---|---|---|
| B1a | `page_current`/`pages_count`/`pages_tree`/`tags_list`/`properties_list` | ✅ |
| B1b | `db_schema`/`db_rows`（简单 where、分页、200KB 截断、原始值不重算） | ✅ |
| B1c | `versions_*`/`trash_list`/`files_stat`/`files_extract_status`/`files_list_orphan`/`files_download`/`blobs_fetch`（句柄：单次/TTL120s/固定导出目录） | ✅ |
| B3 | 前端桥：`export_markdown`/`export_docpackage`/`coverage_report`（5s 超时、unavailable/timeout 可判） | ✅ |
| B2-结构 | `folders.create`/`nodes.move|rename|delete`/`trash.restore`/`pages.revert`/`tags.remove`/`properties.unset` | ✅ |
| B2-块 | `blocks.patch/insert/delete`（`rev_conflict` 带 currentRev + 带锚点 markdown；draft-mediate） | ✅ |
| B2-附件与模板 | `files.move/rename/delete`（正文引用检查）、`templates.apply` | ✅ |
| B2-补遗-1 | 受控上传通道（系统文件选择框）：`files.upload_to_page`/`import.docpackage`/`files.detach`（新命令 `detach_attachment`） | ✅ |
| B2-补遗-2 | `db.rows_write`/`db.rows_delete`（简单表原始列、草稿→前端 apply 改 db 块、零新写库入口） | ✅ |
| B2-补遗-3 | e2e 判据：块写锚点数/块 id、附件 detach/delete、db 行写读回、锁空间拒绝 | ✅ |
| UX 优化批 | 写闭环（`draftId` + `drafts_status` + `audit_tail`）、`templates_list`、`space_current`、`pages_import_markdown`（旧名保留）、`pages_update` 弃用指引、`export_page_markdown`/`export_space_markdown` | ✅ |
| UX-④ | `files.*`/`versions.*` 9 条补可选 `spaceId`（逐 cap `with_conn_for_space`）＋ 确认框取消回写 `rejected` | ✅ |
| P1 面板适配 | 第六档 `write_all`（只开权限门）、`McpStatus.level` 扩展、`mcp_recent_drafts`/`mcp_recent_audit` 两个只读命令；设置面板六块（六档＋动态「能做什么」、状态/token 打码、按域能力清单、草稿、审计、边界） | ✅ |
| P2 能力补齐 | `audit_tail.onlyWrites`、`pages.changes_since`（工具 `changes_since`，页级增量）、`cap_limits.rs` 限额常量收敛 | ✅ |
| 跨空间写 v1 | `pages.create` 带 `spaceId` 写到目标空间（`create_node_in` 单连接、目标空间 `changes` 同写、审计带 `spaceId`、回滚开关 `SHUYONOTE_MCP_CROSS_SPACE_WRITE`） | ✅ |
| 跨空间写 v2 | owner 拍「甲」：`write_all` 档同时获得 `read:all-spaces`；`pages.update`/`blocks.append/patch/delete` 支持目标空间（校验改「传连接」变体，块合并仍在 `apply.ts`） | ✅ |
| AI 不可见空间清单 | 存 `meta.sync_state` 的 `ai_hidden_spaces`（本机偏好、不同步）；`mcp_hidden_spaces_get/set`；dispatch 单点遮蔽（读/写/跨空间）、`spaces_list` 过滤、`space.current` 与当前空间隐藏均明确拒绝 | ✅ |

**当前面（2026-10-31）**：**70 条能力 / MCP 61 工具（读 34 / 写 27）/ `apiVersion` 1.27.0** —— 以 `node scripts/check-capabilities.mjs` 的输出为准（注册表 70、生成物 61、TS 适配器 62 有参数比对）。

### 14.2 仍未做 / 明确降级（2026-10-31 对账）

> 2026-10-31 只核代码、未改代码的对账（**别再把 §14.1 已落地的项当"未做"读**）：
> · **块级写 P2 已实现**（不是"未开始"）：`blocks.patch` / `blocks.insert` / `blocks.delete` 已注册（`src-tauri/src/capabilities_gen.rs:55-57`，`kind:"write"`、`mediate:"draft"`、`ai:true`），用例见 `src-tauri/src/plugins.rs:18593`（`blocks_insert_cross_space_draft_and_gates`）；
> · **第六档「可写（全部空间）」已是实际档位**：`McpLevel::WriteAll`（`src-tauri/src/mcp_channel.rs:1388-1390`）；`level_to_config` 给它授 `write:all-spaces` 并收回其它档（同文件 `:1442-1457`）；`level_of` 按该权限判档（`:1471-1472`）；面板六档含该项（`src/components/McpAccessPane.tsx:133`，说明见 `:956`）⇒ 原「没有档位授予 ⇒ 跨空间写不可用」已过期；
> · **`>10MB` / `>20 文件` 的确认 UI 已落地**：导出/上传走 `confirmDialog`「允许一次」＋一次性额度（`src/lib/mcpFrontendTools.ts:108-133`），下载走 `files.confirm_download` ＋ `mcp_download_grant`（同文件 `:230-247`、`src-tauri/src/plugins.rs:3206`），文档见 `docs/mcp-external-ai.md:111-120`。

| # | 项 | 现状证据（file:line） | 仍缺什么 |
|---|---|---|---|
| 1 | 其余写工具的跨空间 | 白名单已扩到 **22 条**（`src-tauri/src/plugins.rs:6007-6031`）：`pages.create/update`、`blocks.append/patch/insert/delete`、`files.rename/delete/move/detach`、`nodes.move/rename/delete`、`folders.create`、`tags.add/remove`、`properties.set/unset`、`db.rows_write/delete`、`trash.restore`、`pages.revert` | 仍不支持跨空间的写工具：`templates.apply`、`files.upload_to_page`、`import.docpackage`、`pages.importMarkdown`（含旧名 `pages.import_markdown`）—— 不在白名单 ⇒ 带 `spaceId` 命中 `bad_args: 暂不支持跨空间`（`src-tauri/src/plugins.rs:6032-6034`） |
| 2 | `export.*` 跨空间 | **单页已支持**：`export.markdown` / `export.docpackage` 带 `spaceId` 走 `with_conn_for_space`（`src-tauri/src/plugins.rs:3445-3467` / `:3494-3516`） | **整空间导出仍只认当前空间**（同文件 `:3472-3479` 明确 `bad_args`）；跨空间整空间导出还需要命令面读别空间页面/附件的入口 |
| 3 | 应用内 AI 面跨空间 | 读已部分支持：`pages.list` / `pages.search` / `pages.tree` 等经 `listWorkspacePages` 走 `spaceId`（`src/lib/capabilities/frontend.ts:403-435`、`:492-516`）；DB 跨空间**如实拒绝**（同文件 `:386-393`） | 应用内面的跨空间**写**与 DB 读仍缺；应用内面 vs 外部面的 `spaceId` 支持矩阵尚未逐条对齐（没有"一张表"） |
| 4 | 跨空间下载字节 | `files.download` 已带 `spaceId` 门（`src-tauri/src/plugins.rs:3276-3290`、`:6105`），超限确认走一次性额度（`:3206`） | **仍没有"跨空间下载真字节"的端到端断言**（要真附件文件；现有判据只覆盖同空间下载与超限额度） |
| 5 | "用户关窗不响应" | 草稿状态机 `pending → applied/rejected`，超 10 分钟 TTL 读作 `expired`（`src-tauri/src/plugins.rs:5007-5012`、`:5117-5120`）；确认/取消回写 `mcp_draft_state`（`:5095`） | **关窗仍无取消事件可挂** ⇒ 用户直接关窗时草稿停在 `pending`、10 分钟后才变 `expired`（⛔ 不猜成 `rejected`） |
| 6 | 团队/企业写面 | 仍不覆盖（§10 四问未定；`README.md:57` 记 2026-10-29 起团队协作已移除、改由独立企业版承载） | 身份/角色/审计合规/数据边界四问落定前，企业版不开写面 |
| 7 | GitHub CI 读数 | 上次记录：镜像已推到 `bf9f1b13`；`api.github.com` fetch failed，CI 结论未读到（不算通过） | 仍需联网读一次 GitHub Actions 结论（本机绿 ≠ CI 绿） |

### 14.3 环境坑（本机，非产品）

- **构建产物 Low 完整性级别**：会话沙箱把 `src-tauri/target/**` 标成 Low IL ⇒ 进程写 `%APPDATA%` 被拒、SQLite 报 `readonly database`。修法：`icacls <target\debug> /setintegritylevel Medium /T /C`；重新构建后若复现就重跑这条。
- **`tauri-plugin-http` 的 cookies 特性**：init 建 `<cache>/.cookies` 时本机稳定 `os error 5` ⇒ 已在 `Cargo.toml` 关掉（应用不使用插件 cookie 罐）。
