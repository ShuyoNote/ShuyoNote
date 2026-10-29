# 能力暴露：底层可行性核对（B1 前置，2026-10-29）

状态：核对完成（2026-10-29）—— 目的：**开工前确认每条待暴露能力有没有底层命令**，避免"做到一半发现没有写入口"。依据：`src/lib/api.ts` 的命令清单（2026-10-29 实测扫描）＋ 注册表。

## 结论速览

| 结论 | 能力 |
|---|---|
| ✅ **已有底层命令，可直接接线** | `trash.list`(listDeleted)、`trash.restore`(restorePage)、`versions.list/get`(listVersions)、`pages.revert`(restoreVersion)、`files.stat`(listPageAttachments/getAttachment)、`files.download`(readAttachmentBytes/downloadAttachment)、`files.upload_to_page`(writeAttachmentBytes)、`files.detach`(removeAttachment→可改归属)、`files.move`(moveAttachment)、`files.rename`(renameAttachment)、`files.delete`(removeAttachment＋restoreAttachment)、`tags.*`(listTags/createTag/renameTag/deleteTag/removeTag)、`properties.*`(listAttrDefs/setPageProp/removePageProp/getPageProps)、`folders.create`(createFolder)、`nodes.move`(movePage，文件夹也是节点)、`nodes.delete`(deletePage 软删)、`import.docpackage`(openDocumentPackage＋createPage)、`export.docpackage`(buildDocumentPackage) |
| 🟡 **有命令但需扩展参数** | `db.rows`（`queryDatabase(dbPageId)` **无过滤参数** ⇒ 需加 where 或在能力层过滤并分页）、`db.rows_write/delete`（需确认写行命令）、`templates.apply`（只有 list/save/delete）、`export.markdown`（有 exportWiki/exportWorkspace，需确认粒度） |
| 🔴 **需新建命令/能力** | `audit.tail`（现只有 pluginAudit）、`blobs.fetch`（句柄消费方）、`blocks.patch/insert/delete`（只有读：getPageBlocks/resolveBlock/searchBlocks）、`changes_since`（需块级 diff）、`pages.tree`（可用 listPages 组装，但建议专用命令）、`pages.count`（可用 listPages 计数，但建议专用） |
| ⛔ 不做 | `editor.insertText`、`user.notify`、`kv.*`、`settings.get`、`log.write`、任意 SQL/HTTP/路径、永久删除/清空回收站、`files.bulk/purge` |

## 逐条核对（关键项）

| 能力 | 底层（api.ts） | 结论 |
|---|---|---|
| `trash.list` | `listDeleted` | ✅ |
| `trash.restore` | `restorePage` | ✅（B2，与软删同批） |
| `versions.list` / `version.get` | `listVersions`（`restoreVersion` 用于回滚） | ✅ |
| `pages.revert` | `restoreVersion` ＋ `cleanupOldVersions`（保留策略） | ✅ 需定保留期（矩阵 §13.2-5） |
| `files.stat` | `listPageAttachments` / `getAttachment`（含 size/mime/sha? 需核字段） | ✅ 可能需补 sha 字段 |
| `files.list_orphan` | `listAttachmentHashes` / `cleanupOrphanAttachments` 口径 | 🟡 需确认"孤儿"查询口径 |
| `files.download` | `readAttachmentBytes` / `downloadAttachment` | ✅ |
| 导出 `/export.*` | `buildDocumentPackage`（.shuyodoc）＋ `exportWiki`/`exportWorkspace` | ✅/🟡 |
| `blobs.fetch` | 无 | 🔴 新建 |
| `db.schema` | `getDbColumns` / `listDbViews` / `listAttrDefs` | ✅ |
| `db.rows` | `queryDatabase(dbPageId)`（无 filter 参数） | 🟡 扩展 where |
| `db.rows_write/delete` | 需确认（未见 row 写入命令） | 🟡/🔴 核实 |
| `blocks.patch/insert/delete` | 只有 `getPageBlocks`/`resolveBlock`/`searchBlocks` | 🔴 新建（P2） |
| `changes_since` | 无（有 `listPendingRemotePages`/`listPageConflicts` 但语义不同） | 🔴 新建 |
| `audit.tail` | 只有 `pluginAudit`（插件审计，非 MCP） | 🔴 新建 |
| `templates.list` | `listTemplates` | ✅ |
| `templates.apply` | 无 apply | 🔴 新建或降级（读模板→agent 用 pages.create） |
| `pages.tree` | `listPages`/`listWorkspacePages` 组装 | 🟡 建议专用命令（一次查询，含 kind/parent/order） |
| `pages.count` | `listPages` 计数 | ✅（或专用） |
| `nodes.delete`（软删） | `deletePage`（＋`purgePage` 永久，⛔ 不暴露） | ✅ |
| `nodes.move` | `movePage`（文件夹＝页面节点） | ✅ |
| `files.delete` | `removeAttachment`（＋`restoreAttachment`） | ✅ 需引用检查 |
| `import.docpackage` | `openDocumentPackage` ＋ `createPage`（永远新建） | ✅ |

## 风险与前置

1. **`query_database` 无过滤** ⇒ B1b 要么给 Rust 加 `where` 参数（推荐），要么能力层拉全表再筛（大表会撞响应体上限 200 KB）——**必须先定**。
2. **`files.stat` 的 sha 字段**：`listPageAttachments` 是否返回 sha256 要核实；没有则补（内容寻址本来就有）。
3. **`blocks.*` 写** 依赖 P2（新 Rust 命令），**B2 里它是前置，不是顺手能做的**。
4. **`audit.tail`** 需要把 MCP 通道已有的审计环读出来（写入已存在）；只读暴露，注意只回本会话。

## 对 B1 三段的影响

- **B1a**（`page.current`/`pages.count`/`tags.list`/`properties.list`/`coverage.report`/`pages.tree`）：**零新建命令**（tree/count 可用 listPages 组装，建议专用但非阻塞）；
- **B1b**（`db.schema`/`db.rows`）：需先定 `query_database` 过滤方案；
- **B1c**（versions/trash/files 读/导出/下载/`blobs.fetch`）：需 **新建 `blobs.fetch`** ＋ 确认附件 sha 字段。
