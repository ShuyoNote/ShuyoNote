# 外部工具面：M2（可写，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m2` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `e7b75677ba8710c0cb336ebddd38ae516f436e1378f61ad16e1f6cb656a535cb` |
| `apiVersion` | 1.4.0 |
| 取用条件 | `ai === true` **且** `kind === "write"` |
| 条数 | **4** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m2` |

| id | scope | permission | desc |
|---|---|---|---|
| blocks.append | current-space | write:pages | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| pages.create | current-space | write:pages | 新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。 |
| pages.importMarkdown | current-space | write:pages | 导入 Markdown 新建一页（一次调用写完整页）。参数: title (必填), markdown (必填，Markdown 原文), parentId (父页面 id；不传就是顶层)。这是写操作，返回草稿供用户确认。 |
| pages.update | current-space | write:pages | 更新已有页面：把整页正文替换成新内容（草稿确认）。参数: id (必填目标页), markdown 或 content (二选一，整篇新正文), title (可选新标题)。这是写操作，返回草稿供用户确认。 |
