# 外部工具面：M2（可写，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m2` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `4aa2ba0f33df3eba84affca59481327b612c3757c6e956d70dc9c63fc96b7941` |
| `apiVersion` | 1.7.0 |
| 取用条件 | `ai === true` **且** `kind === "write"` |
| 条数 | **14** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m2` |

| id | scope | permission | desc |
|---|---|---|---|
| blocks.append | current-space | write:pages | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| folders.create | current-space | write:pages | 新建一个文件夹节点（不是页面）。参数: title(必填), parentId(可选,省略=顶层)。写操作 ⇒ **只产生草稿**（`{drafted:true, summary, spaceId}`），用户确认后才落库；`dryRun:true` 只演练不产生草稿；`spaceId` 本版只支持当前空间。 |
| nodes.delete | current-space | write:pages | **软删**一个节点（进回收站，可恢复）。参数: id(必填), expectedRev(可选)。⚠️ 还有子项 ⇒ `bad_args` 并点名 N（⛔ 不递归删）；返回里带 `backlinks` 数。写操作 ⇒ 只产生草稿等用户确认。 |
| nodes.move | current-space | write:pages | 移动节点（页面或文件夹都算）。参数: id(必填), newParentId(可选,省略=顶层), sortOrder(可选), expectedRev(可选)。**环检测**：移到自己的后代下面 ⇒ `bad_args`；返回里带 `backlinks` 数（如实提示）。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同上。 |
| nodes.rename | current-space | write:pages | 给节点改名（只改标题）。参数: id(必填), title(必填,≤200 字), expectedRev(可选)。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同样支持。 |
| pages.create | current-space | write:pages | 新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。 |
| pages.importMarkdown | current-space | write:pages | 导入 Markdown 新建一页（一次调用写完整页）。参数: title (必填), markdown (必填，Markdown 原文), parentId (父页面 id；不传就是顶层)。这是写操作，返回草稿供用户确认。 |
| pages.revert | current-space | write:pages | 回退到历史版本。参数: pageId(必填), versionId(必填), expectedRev(可选)。版本不在该页历史里 ⇒ `not_found`（⛔ 不假装成功）。写操作 ⇒ 只产生草稿等用户确认。 |
| pages.update | current-space | write:pages | 更新已有页面：把整页正文替换成新内容（草稿确认）。参数: id (必填目标页), markdown 或 content (二选一，整篇新正文), title (可选新标题)。这是写操作，返回草稿供用户确认。 |
| properties.set | current-space | write:properties | 设置某个页面的属性值。参数: attrId (必填, 从 properties.list 拿), value (必填), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| properties.unset | current-space | write:properties | 去掉页面的属性值（不删属性定义）。参数: attrId(必填), pageId(可选,省略=当前页)。属性不存在 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认。 |
| tags.add | current-space | write:tags | 给页面加一个标签。参数: name (必填, 不带 #), pageId (可选, 省略=当前打开的页面)。标签不需要预先创建。这是写操作，返回草稿供用户确认。 |
| tags.remove | current-space | write:tags | 把标签从页面移除（不删标签本身）。参数: name(必填), pageId(可选,省略=当前页)。标签不存在/该页没有它 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认。 |
| trash.restore | current-space | write:pages | 从回收站恢复节点。参数: id(必填)。活着的节点 ⇒ `bad_args`；不存在 ⇒ `not_found`。写操作 ⇒ 只产生草稿等用户确认；`dryRun`/`clientRequestId` 同上。 |
