# 外部工具面：M1（只读，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m1` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `7e0c07f9e5d91f91740804a01f403ff4c9243add33bc96f46a3c2acaa31d4375` |
| `apiVersion` | 1.1.0 |
| 取用条件 | `ai === true` **且** `kind === "read"` |
| 条数 | **8** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m1` |

| id | scope | permission | desc |
|---|---|---|---|
| backlinks.list | current-space | read:backlinks | 查询哪些页面反向链接到目标页面。参数: pageId (可选, 省略=当前打开的页面)。返回引用它的页面列表。 |
| blocks.list | current-space | read:pages | 列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (可选, 省略=当前打开的页面), limit (可选)。返回块数组，可用于定位具体块。 |
| coverage.report | current-space | read:files | 检查**整个库**的索引覆盖：哪些内容真的进了检索面、哪些没进、哪些**进了但没抽全**。参数: 无。返回 {summary, report}：`summary` 是一行中文摘要（可直接展示）；`report.attachments` 给出 已索引/没抽全/未索引 的计数与分类，`report.gaps` 给出**明细**（每条含 `reason` 与一句「该怎么办」）。⚠️ 三个必须分清的口径：① **没抽到 ≠ 文件里没有**（`no_content` 可能是空文件/加密/纯图）；② **页面正文空 ≠ 这页内容没被索引**（图片/附件/数据库块由附件侧负责）；③ **`partial` 是「搜得到，但只覆盖了一部分」**（典型：混合 PDF 只抽到正文页）—— 别把「已索引 N/N」读成「内容全在检索面里」。**缺口列表可能被截断**（看 `gapsTotal` 与 `gapsTruncated`）。 ★ **只有 AI 宿主**能实现它（`host: frontend`）：判「没人认领这种格式」必须以 TS 侧的抽取器注册表为准，Rust 侧再长一份就是两份实现、而漂移不会报错 ⇒ 它不进插件 shim／插件类型包／Rust 绑定表，插件调不到。 |
| files.list | current-space | read:files | 列出页面附件。参数: pageId (可选, 省略=当前打开的页面)。返回文件名/类型/大小。 |
| files.read | current-space | read:files | 读取某个附件的**派生文本**（抽取结果，**不含原文字节**）。参数: id (必填), offset/limit (可选分页)。返回 {segments, total, truncated, coverage}；**还没抽过 ⇒ segments 空 + total 0**（不是失败，别据此断言文件里没有内容）。`truncated` 说的是「这一页没给全」，而 `coverage` 说的是「**抽取本身**有没有承认没抽全」（§15.10：成功 ≠ 抽全了）：coverage 里每个抽取器一条 `{extractor, coverage}`，`coverage` 是原始 JSON（如 `{"complete":false,"gapIndexes":[2]}`），**空字符串或空数组都表示「未知」，不许读成「完整」**。 |
| files.search | current-space | read:files | 在已抽取的文件内容里做块级检索（含扫描件/文档正文）。参数: query (必填), limit (可选, 默认 10)。返回 {chunkId, pageId, attId, loc, snippet, score}：pageId/attId 用来回链到原文位置。 |
| pages.get | current-space | read:pages | 读取单个页面的标题与正文纯文本。参数: id (必填), offset/limit (可选分页，按**字符/Unicode 标量**计数)。**必须看 `chars_total` 与返回长度判断是否读全**：只读了窗口就当整页用，是这类工具最常见的误用。 |
| pages.search | current-space | read:pages | 在本空间检索页面（关键词匹配；应用内 AI 检索会叠加本地嵌入的语义加分，配了嵌入模型时意思相近的内容也能命中）。参数: q (必填, 关键词/内容描述), limit (可选, 默认 8)。返回匹配页面的 id/title/snippet。 |
