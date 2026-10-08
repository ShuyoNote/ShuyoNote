# 外部工具面：M2（可写，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m2` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `7e0c07f9e5d91f91740804a01f403ff4c9243add33bc96f46a3c2acaa31d4375` |
| `apiVersion` | 1.1.0 |
| 取用条件 | `ai === true` **且** `kind === "write"` |
| 条数 | **3** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m2` |

| id | scope | permission | desc |
|---|---|---|---|
| blocks.append | current-space | write:pages | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| pages.create | current-space | write:pages | 新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。 |
| pages.importMarkdown | current-space | write:pages | 导入 Markdown 新建一页（一次调用写完整页）。参数: title (必填), markdown (必填，Markdown 原文), parentId (父页面 id；不传就是顶层)。这是写操作，返回草稿供用户确认。 |
