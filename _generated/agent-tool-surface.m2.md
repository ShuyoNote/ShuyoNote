# 外部工具面：M2（可写，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m2` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `9ba134849021d07dfe12abf9d877dd77b583a1aff22f7d49bc81a99fb8157b69` |
| `apiVersion` | 1.20.0 |
| 取用条件 | `ai === true` **且** `kind === "write"` |
| 条数 | **27** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m2` |

| id | scope | permission | desc |
|---|---|---|---|
| blocks.append | current-space | write:pages | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| blocks.delete | current-space | write:pages | 删除顶层块（不留空占位）。参数: blockId + expectedRev。写操作 ⇒ 只产草稿；`dryRun` 只演练；冲突 ⇒ `rev_conflict` 带 currentMarkdown。 |
| blocks.insert | current-space | write:pages | 插入块：pageId 或 afterBlockId(至少一个) + markdown/text(二选一) + expectedRev。返回 `newBlockId`（用户确认后即可用它继续 patch/delete）。写操作 ⇒ 只产草稿；`dryRun` 只演练；冲突 ⇒ `rev_conflict` 带当前 markdown。 |
| blocks.patch | current-space | write:pages | 整块替换（顶层块）：blockId(必填) + markdown 或 text(二选一) + expectedRev(可选但强烈建议)。**块 id 不变**。写操作 ⇒ 只产草稿（返回 `{drafted:true,applied:false,rev,changed}`，用户确认后才落库）；`rev` 变/冲突 ⇒ `rev_conflict` 带 currentRev 与当前 markdown（带锚点）；`dryRun` 只演练。 |
| db.rows_delete | current-space | write:pages | 删除数据库行。参数: pageId, rowIds（必须是该数据库页的子行）。行不存在/不属于该表 ⇒ `not_found` 点名（⛔ 不静默跳过）；写操作 ⇒ 只产草稿等确认。 |
| db.rows_write | current-space | write:pages | 写数据库行（只支持**简单表格原始列**；⛔ 关系/公式/汇总列）。参数: pageId, rows=[{rowId?（有=改，无=增）, title?（新增必填）, values:{列id或列名: 原始值}}], expectedRev。未知列/禁用列/类型不符/新增缺 title ⇒ `bad_args` 点名第几行第几列；写后可用 db_rows 读回。写操作 ⇒ 只产草稿等确认（`applied:false`）。 |
| files.delete | current-space | write:files | 删除附件条目。⚠️ **正文仍在引用它 ⇒ 明确拒绝并点名是哪些页面**（不静默删）；字节在该 hash 仍被别处引用时会保留。参数: attId, expectedSha(可选)。写操作 ⇒ 只产草稿等确认。 |
| files.detach | current-space | write:files | 把附件从页面摘除（**保留文件**，变未整理）——与删除分开。参数: attId。已经是未整理 ⇒ `bad_args`。写操作 ⇒ 只产草稿等确认。 |
| files.move | current-space | write:files | 把附件移到别的页面/文件夹（改归属；内容不变）。参数: attId, toPageId, expectedSha(可选)。写操作 ⇒ 只产草稿等确认；可配 `dryRun`/`clientRequestId`。 |
| files.rename | current-space | write:files | 重命名附件（只改显示名；按界面同一条 mime 修复规则）。参数: attId, name, expectedSha(可选)。写操作 ⇒ 只产草稿等确认。 |
| files.upload_to_page | current-space | write:files | 上传附件到页面。⚠️ **确认后系统会弹文件选择框，由用户亲自选文件**（⛔ 不接受任意路径）；同名自动 `-N` 不覆盖；>10MB ⇒ `needs_confirm`；用户取消 ⇒ `cancelled`。参数: pageId, name(可选)。写操作 ⇒ 只产草稿等确认。 |
| folders.create | current-space | write:pages | 新建一个文件夹节点（不是页面）。参数: title(必填), parentId(可选,省略=顶层)。写操作 ⇒ **只产生草稿**（`{drafted:true, summary, spaceId}`），用户确认后才落库；`dryRun:true` 只演练不产生草稿；`spaceId` 本版只支持当前空间。 |
| import.docpackage | current-space | write:pages | 导入 `.shuyodoc`：确认后由用户亲自选文件（⛔ 不接受路径）；**永远新建、不覆盖**；坏包 ⇒ 错误原文（点名条目）；取消 ⇒ `cancelled`。参数: parentId(可选)。写操作 ⇒ 只产草稿等确认。 |
| nodes.delete | current-space | write:pages | **软删**一个节点（进回收站，可恢复）。参数: id(必填), expectedRev(可选)。⚠️ 还有子项 ⇒ `bad_args` 并点名 N（⛔ 不递归删）；返回里带 `backlinks` 数。写操作 ⇒ 只产生草稿等用户确认。 |
| nodes.move | current-space | write:pages | 移动节点（页面或文件夹都算）。参数: id(必填), newParentId(可选,省略=顶层), sortOrder(可选), expectedRev(可选)。**环检测**：移到自己的后代下面 ⇒ `bad_args`；返回里带 `backlinks` 数（如实提示）。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同上。 |
| nodes.rename | current-space | write:pages | 给节点改名（只改标题）。参数: id(必填), title(必填,≤200 字), expectedRev(可选)。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同样支持。 |
| pages.create | current-space | write:pages | 新建一页。参数: title, content?, parentId?, spaceId?, dryRun?。⭐ `spaceId` ⇒ 写到目标空间（需『可写（全部空间）』档；目标锁着 ⇒ permission_denied）；跨空间 v1 **只支持 pages_create**。写操作 ⇒ 只产草稿等确认。 |
| pages.import_markdown | current-space | write:pages | 导入整篇 Markdown 新建一页（新名）。参数: title, markdown, parentId(可选)。与旧名 `pages_importMarkdown` **调用同一能力、行为一致**；旧名保留。写操作 ⇒ 只产草稿等确认。 |
| pages.importMarkdown | current-space | write:pages | deprecated: 用 pages_import_markdown（旧名保留以兼容外部客户端）。deprecated: 用 pages_import_markdown（旧名保留以兼容外部客户端）。导入 Markdown 新建一页（一次调用写完整页）。参数: title (必填), markdown (必填，Markdown 原文), parentId (父页面 id；不传就是顶层)。这是写操作，返回草稿供用户确认。 |
| pages.revert | current-space | write:pages | 回退到历史版本。参数: pageId(必填), versionId(必填), expectedRev(可选)。版本不在该页历史里 ⇒ `not_found`（⛔ 不假装成功）。写操作 ⇒ 只产生草稿等用户确认。 |
| pages.update | current-space | write:pages | ⚠️ 整页替换。能按块改就用 blocks_patch/blocks_insert/blocks_delete；本工具仅用于整页重写。⚠️ 整页替换。能按块改就用 blocks_patch/blocks_insert/blocks_delete；本工具仅用于整页重写。更新已有页面：把整页正文替换成新内容（草稿确认）。参数: id (必填目标页), markdown 或 content (二选一，整篇新正文), title (可选新标题)。这是写操作，返回草稿供用户确认。 |
| properties.set | current-space | write:properties | 设置某个页面的属性值。参数: attrId (必填, 从 properties.list 拿), value (必填), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| properties.unset | current-space | write:properties | 去掉页面的属性值（不删属性定义）。参数: attrId(必填), pageId(可选,省略=当前页)。属性不存在 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认。 |
| tags.add | current-space | write:tags | 给页面加一个标签。参数: name (必填, 不带 #), pageId (可选, 省略=当前打开的页面)。标签不需要预先创建。这是写操作，返回草稿供用户确认。 |
| tags.remove | current-space | write:tags | 把标签从页面移除（不删标签本身）。参数: name(必填), pageId(可选,省略=当前页)。标签不存在/该页没有它 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认。 |
| templates.apply | current-space | write:pages | 用模板新建一页。参数: templateId(来自 templates_list), parentId(可选,省略=顶层)。永远**新建**、不覆盖。写操作 ⇒ 只产草稿等确认；`dryRun`/`clientRequestId` 同上。 |
| trash.restore | current-space | write:pages | 从回收站恢复节点。参数: id(必填)。活着的节点 ⇒ `bad_args`；不存在 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同上。 |
