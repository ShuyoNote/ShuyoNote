# 外部工具面：M1（只读，**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-agent-tool-surface.mjs --phase m1` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-agent-surface.mjs`（面 ≡ 注册表 ／ 只读面写能力数 = 0 ／ 描述无内部标识 ✓）

| 源 | 值 |
|---|---|
| 注册表 sha256 | `9ba134849021d07dfe12abf9d877dd77b583a1aff22f7d49bc81a99fb8157b69` |
| `apiVersion` | 1.20.0 |
| 取用条件 | `ai === true` **且** `kind === "read"` |
| 条数 | **34** |
| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m1` |

| id | scope | permission | desc |
|---|---|---|---|
| audit.tail | current-space | read:pages | 读**本会话**最近 N 条审计（默认 20 / 上限 100）：`{at,tool,capabilityId,ok,code}`。⛔ 不回正文、不回别的会话。参数: limit。 |
| backlinks.list | current-space | read:backlinks | 查询哪些页面反向链接到目标页面。参数: pageId (可选, 省略=当前打开的页面)。返回引用它的页面列表。 |
| blobs.fetch | current-space | export:files | 句柄消费方（**唯一落盘处**）：把 `files_download`（以及将来 `export_*`）给的句柄换成文件，写进**应用数据目录下的 `exports/`**（文件名会清洗；⛔ **不接受任意目标路径**），返回 `{path, size, sha256}`。句柄**单次使用**、**120 秒**有效、绑定**本会话** —— 二次使用 / 过期 / 别的会话 ⇒ `not_found`。参数: handle (必填)。 |
| blocks.list | current-space | read:pages | 列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (可选, 省略=当前打开的页面), limit (可选)。返回块数组，可用于定位具体块。 |
| coverage.report | current-space | read:files | 检查**整个库的索引覆盖**：哪些内容真的进了检索面、哪些没进、哪些**进了但没抽全**。返回 `{ok, summary, report}`：`summary` 是一行中文摘要（可直接念给用户）；`report.attachments` 给 已索引/没抽全/未索引 的计数与分类，`report.gaps` 给**明细**（每条含 `reason`）。⚠️ 三条口径别读错：① **没抽到 ≠ 文件里没有**（`no_content` 可能是空文件/加密/纯图）；② **页面正文空 ≠ 这页内容没被索引**（图片/附件/数据库块由附件侧负责）；③ **`partial` = 搜得到但只覆盖一部分**。缺口列表可能被截断（看 `gapsTotal` / `gapsTruncated`）。⚠️ 报告是**当前空间**的派生层口径：`spaceId` 只接受当前空间（跨空间未接，给别的空间 ⇒ `bad_args`）。参数: spaceId (可选)。 ★ 若 `frontend_unavailable` / `frontend_timeout`：应用窗口没挂载或前端忙 ⇒ 报告需要**前端在运行**（它不是纯 Rust 能算的）。 |
| db.rows | current-space | read:pages | 读取一个**数据库页的行**：`{pageId, spaceId, total, returned, rows:[{id, values:{<columnId>: <原始值>}}], truncated, note}`。⚠️ **values 是数据库里存的原始值**（字符串），本工具⛔ **不重算公式列/汇总列** ⇒ 可能与界面里显示的计算值不同（`note` 里也写着这句）；要展示计算值请看界面或自己算。`total` 是**过滤后**的总行数（不受 limit 影响，可用它判断翻页到没到头）。**简单 where**（多条 AND）：`[{field, op, value?}]`，`field` 是**列 id 或列名（id 优先，列名须完全一致；必须来自 db_schema 报出的列）**，`op` 白名单 `= != > >= < <= in contains is_null`（`in` 的 value 必须是数组；`is_null` 不需要 value）；写错字段/操作符/形状 ⇒ `invalid_args` 并**点名第几条**（不会静默返回空）。可选 `viewId` 套用该视图保存的**标题过滤与排序**。`limit` 默认 100、上限 500，`offset` 默认 0（分页在宿主侧执行）；响应体超过 200 KB ⇒ 提前截断并 `truncated:true`。默认读**当前空间**；给了 spaceId 就读那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: pageId (必填), viewId (可选), where (可选), limit (可选, 默认 100, 上限 500), offset (可选, 默认 0), spaceId (可选)。 |
| db.schema | current-space | read:pages | 读取一个**数据库页**的结构：`{pageId, spaceId, views:[{id,name,type}], columns:[{id,name,type,isFormula?,isRollup?}], relations:[{id,name,type}]}`。列与视图与界面**同一条查询**（同一份数据库元数据），所以名字/顺序/类型都对得上。**公式列**带 `isFormula:true`、**汇总列**带 `isRollup:true` —— 本工具只**标明**它们是计算列，⛔ **不计算任何值**；`relations` 是关系列（`type:ref`，取值形如 `p:<pageId>`，要标题得自己按 id 再查）。默认读**当前空间**；给了 spaceId 就读那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: pageId (必填), spaceId (可选)。 |
| drafts.status | current-space | read:pages | 查一条草稿当前状态：pending（等用户确认）/ applied（已落库）/ rejected（用户拒绝）/ expired（10 分钟没确认）。参数: draftId。⚠️ 只回**本会话**的草稿；别的会话/不存在 ⇒ not_found。 |
| export.docpackage | current-space | export:files | 把**一页**打包成 `.shuyodoc`（单页；与界面「导出为 .shuyodoc」同一份格式实现）并**只回句柄**：`{handle, name, size, sha256, expiresAt}`。句柄 128bit 随机、**单次**、**120 秒**、绑**本会话**；要拿到文件用 `blobs_fetch`（只落 `exports/`）。页不存在 ⇒ `not_found`；文件夹 ⇒ `bad_args`；>10MB ⇒ `needs_confirm`。 |
| export.markdown | current-space | export:files | deprecated: 用上面两个显式工具 export_page_markdown / export_space_markdown（旧名保留以兼容外部客户端）。把内容导出成文件并**只回句柄**（不把字节塞进上下文）：`{handle, name, size, sha256, expiresAt}`。两种口径（**只能给一个**）：`pageId` ⇒ 该页的单个 `.md`（与界面「导出为 Markdown」同口径）；`spaceId` ⇒ 该空间整份 `.zip`（Markdown ＋ 附件，与界面「导出本空间」同口径；跨空间需要「只读（全部空间）」档）。句柄 128bit 随机、**单次**、**120 秒**、绑**本会话**；要拿到文件用 `blobs_fetch`（只落应用数据目录的 `exports/`）。页不存在 ⇒ `not_found`；文件夹 ⇒ `bad_args`；>10MB ⇒ `needs_confirm`（本批未接确认 UI，不静默导出）。 |
| export.page_markdown | current-space | export:files | 导出**单页** Markdown（`.md`）并只回句柄。参数: pageId(必填)。⚠️ 只接受 pageId（给 spaceId ⇒ `bad_args`；整空间用 `export_space_markdown`）。句柄单次/TTL 120s/绑会话；落盘用 `blobs_fetch`。 |
| export.space_markdown | current-space | export:files | 导出**整空间**（Markdown ＋ 附件 zip）并只回句柄。参数: spaceId(可选,省略=当前空间；本版只支持当前空间)。⚠️ 只接受 spaceId（给 pageId ⇒ `bad_args`）。句柄单次/TTL 120s/绑会话。 |
| files.download | current-space | export:files | 把附件取成一个**句柄**（**只回句柄、不回字节**）：`{handle, name, size, sha256, expiresAt}`。句柄 128bit 随机、**单次使用**、**120 秒**有效、绑定**本会话**；要拿到文件用 `blobs_fetch`（只会写进应用自己的导出目录）。不存在 ⇒ `not_found`；超过 10MB ⇒ `needs_confirm`（本批未接确认 UI，不静默下载）。参数: attId (必填)。 |
| files.extract_status | current-space | read:files | 读一个附件的**抽取完整度**（单文件口径）：`{attId, name, extracted, segments, extractors:[{extractor, coverage}]}`。`coverage` 是抽取器报的**原始覆盖度**，空串 = **未知**（⛔ 不许读成「完整」）；`extracted:false` 只说明还没抽过，不代表文件里没有内容。不存在 ⇒ `not_found`。参数: attId (必填)。 |
| files.list | current-space | read:files | 列出页面附件。参数: pageId (可选, 省略=当前打开的页面)。返回文件名/类型/大小。 |
| files.list_orphan | current-space | read:files | 列出**未整理附件**（没有挂到任何页面上的文件）：`{files:[{attId, name, mime, size, sha256, createdAt}], total}`。这是**发现孤儿附件**（例如 .shuyodoc 导入后留下的）的入口 —— 只读，不会清理/删除任何文件。参数: limit (可选, 默认 50, 上限 200), offset (可选, 默认 0)。 |
| files.read | current-space | read:files | 读取某个附件的**派生文本**（抽取结果，**不含原文字节**）。参数: id (必填), offset/limit (可选分页)。返回 {segments, total, truncated, coverage}；**还没抽过 ⇒ segments 空 + total 0**（不是失败，别据此断言文件里没有内容）。`truncated` 说的是「这一页没给全」，而 `coverage` 说的是「**抽取本身**有没有承认没抽全」（§15.10：成功 ≠ 抽全了）：coverage 里每个抽取器一条 `{extractor, coverage}`，`coverage` 是原始 JSON（如 `{"complete":false,"gapIndexes":[2]}`），**空字符串或空数组都表示「未知」，不许读成「完整」**。 |
| files.search | current-space | read:files | 在已抽取的文件内容里做块级检索（含扫描件/文档正文）。参数: query (必填), limit (可选, 默认 10)。返回 {chunkId, pageId, attId, loc, snippet, score}：pageId/attId 用来回链到原文位置。 |
| files.stat | current-space | read:files | 读一个**附件的元数据**：`{attId, pageId, name, mime, size, sha256, spaceId}`；`sha256` 是真实的内容指纹（附件按它内容寻址）。不存在 ⇒ `not_found`。参数: attId (必填)。 |
| page.current | current-space | read:page.current | 读取**当前打开的页面**的正文纯文本（与 pages_get 同口径：整页窗口上限 20000 字符、includeAnchors 默认 true 加块锚点、带 rev 乐观并发令牌）。⚠️ **外部接入拿不到界面里「当前页」这个状态**：没有打开的页面时**如实**返回 `{opened:false, note:「…」}`，不会编造一页；要读具体页面请用 pages_list 发现 id、再 pages_get。参数: includeAnchors (可选, 默认 true)。 |
| pages.changes_since | current-space | read:pages | 自 since 起变了哪些页（页级增量；v1 不做块级 diff）：`{pages:[...],truncated}`。since=ms 或 ISO；limit 默认 50/上限 200。要知道改了什么，请对返回的 pageId 再调 `pages_get`。 |
| pages.count | current-space | read:pages | 本空间**未删除节点的数量**（与 pages_list 同口径：页面/数据库/文件夹各算一个）。默认只数**当前空间**；给了 spaceId 就数那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: spaceId (可选)。 |
| pages.get | current-space | read:pages | 读取单个页面的标题与正文（分页，按字符计数；**必须看 chars_total 判断读全没有**）。**默认带块锚点**：每个顶层块后一行 `<!-- b:<块 id> -->`（HTML 注释，不破坏渲染；锚点数 = 本次返回范围内的顶层块数，分页截断时**只标注已返回的块**）—— 可把结论锚定到具体段落。传 includeAnchors:false ⇒ 正文与旧行为**逐字节相同**（省 token）。另带 `rev`（乐观并发令牌，形如 `<更新时间毫秒>:<正文指纹前 8 位>`）：同一页两次读相同、内容改一次就变；按块写回时原样带回。⚠️ 算不出时**不带** rev（不编）。⚠️ **锚点行不计入 chars_total / offset**：翻页请用 `offset + limit`（夹到 chars_total）推算，⛔ 别数返回正文的字符数（会把锚点行算进去 ⇒ 跳字）。参数: id (必填), offset/limit (可选, 默认 6000, 上限 20000), includeAnchors (可选, 默认 true)。 |
| pages.list | current-space | read:pages | 列出页面（id、标题、创建与更新时间），按**最近更新**倒序，不含正文。默认只列**当前空间**；给了 spaceId 就列那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。这是**搜索之外的发现通路**：pages_search 返回空、或不知道该搜什么词时，先调它把那个空间最近改过的页面看一遍。参数: limit (可选, 默认 50, 上限 200), spaceId (可选)。 |
| pages.search | current-space | read:pages | 检索页面：关键词用空格分隔 ⇒ **全部出现**才算命中（不是连续子串匹配）。默认只搜**当前空间**；给了 spaceId 就搜那个空间（只读，需要用户把外部接入开到「只读（全部空间）」档），**不会改变你界面上的活动空间**。返回 {matched（本次返回条数，受 limit 截断）, results:[{id,title,snippet}], scope:{spaceId,spaceName,pageCount}}；matched=0 时另给 hint —— 空结果只说明**这个**空间没命中，不代表别的空间没有。 |
| pages.tree | current-space | read:pages | 一次读取**整个空间的页面树**（结构视图）：{spaceId, spaceName, nodes:[{id,title,kind,parentId,order}], total, truncated}。节点与 pages_list **同一集合**（未删除的页面/数据库/文件夹），按树顺序给出 parentId 与 order；`kind` 是 page / database / folder。默认读**当前空间**；给了 spaceId 就读那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。超过 limit（默认与上限都是 2000 节点）⇒ `truncated:true`（如实说，别把截断的树当全量）。参数: spaceId (可选), limit (可选, 默认 2000, 上限 2000)。 |
| properties.list | current-space | read:properties | 列出本空间的**属性定义** `[{id, name, type}]`（写属性时要的是 id；读数据库/属性值前先用它找 id）。默认只列**当前空间**；给了 spaceId 就列那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: spaceId (可选)。 |
| space.current | current-space | read:pages | 当前活动空间：`{spaceId,name,pageCount}`（与 `spaces_list` 的 active 一致）。只读；⛔ 不切换空间。 |
| spaces.list | app | read:pages | 列出所有空间及当前激活空间（切换空间前先看 id/名称）。只读，不改变任何状态。 |
| tags.list | current-space | read:tags | 列出本空间用到的**标签及各自的页面数**：`[{id, name, page_count}]`（page_count 不含已删除页面）。默认只列**当前空间**；给了 spaceId 就列那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: spaceId (可选)。 |
| templates.list | current-space | read:pages | 列出本空间用户模板：`[{templateId,name,title?}]`；空表 ⇒ `[]`。拿到的 `templateId` 可传给 `templates_apply`。 |
| trash.list | current-space | read:trash | 列出**回收站**里已软删除的页面：`[{pageId, title, deletedAt}]`（按删除时间倒序，不含正文），**只读 —— 不恢复、不清空**。默认只列**当前空间**；给了 spaceId 就列那个空间（只读，需要「只读（全部空间）」档），**不改变活动空间**。参数: spaceId (可选), limit (可选, 默认 50, 上限 200)。 |
| version.get | current-space | read:versions | 读取某个**历史版本**的正文（与 pages_get 同一套字符分页与块锚点口径；**只读，不回滚**）。返回 {pageId, versionId, at, title, 正文窗口, chars_total, offset, limit}；版本不存在 ⇒ `not_found`。参数: pageId (必填), versionId (必填), offset/limit (可选, 默认 6000, 上限 20000), includeAnchors (可选, 默认 true)。 |
| versions.list | current-space | read:versions | 列出某个页面的**历史版本**：`[{versionId, at, title}]`（按时间倒序，最多 200 条），不含正文 —— 要读某个版本的内容再调 version_get。参数: pageId (必填), limit (可选, 默认 50, 上限 200)。 |
