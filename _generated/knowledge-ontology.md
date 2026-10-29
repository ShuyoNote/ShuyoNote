# 知识层本体（**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-knowledge-ontology.mjs` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-ontology-generated.mjs`（与注册表逐字节一致；不一致就红 ✓）

| 源 | 值 |
|---|---|
| 注册表文件 | `capabilities/capabilities.json` |
| 注册表 sha256 | `7cf908eef185f0fa6c93648e01c76849e39307e4f7e3cd74789b167cfcc84a65` |
| `registryVersion` | 1 |
| `apiVersion` | 1.6.0 |
| 能力条数 | **42**（按 `kind`：host 2 / read 29 / write 11） |
| 生成命令 | `node scripts/gen-knowledge-ontology.mjs` |

| id | kind | scope | permission | ai | mediate | desc |
|---|---|---|---|---|---|---|
| backlinks.list | read | current-space | read:backlinks | ✓ |  | 查询哪些页面反向链接到目标页面。参数: pageId (可选, 省略=当前打开的页面)。返回引用它的页面列表。 |
| blobs.fetch | read | current-space | export:files | ✓ |  | 句柄消费方（**唯一落盘处**）：把句柄换成文件，写到应用数据目录下的 exports/，返回 {path, size, sha256}。句柄单次、120 秒有效、绑定本会话；二次使用/过期/别的会话 ⇒ not_found。参数: handle (必填)。 |
| blocks.append | write | current-space | write:pages | ✓ | ✓ | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| blocks.list | read | current-space | read:pages | ✓ |  | 列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (可选, 省略=当前打开的页面), limit (可选)。返回块数组，可用于定位具体块。 |
| coverage.report | read | current-space | read:files | ✓ |  | 检查**整个库**的索引覆盖：哪些内容真的进了检索面、哪些没进、哪些**进了但没抽全**。参数: spaceId (可选；只接受当前空间 —— 报告目前是当前空间的派生层口径，跨空间未接，给别的空间 ⇒ bad_args)。返回 {ok, summary, report}：`summary` 是一行中文摘要（可直接展示）；`report.attachments` 给出 已索引/没抽全/未索引 的计数与分类，`report.gaps` 给出**明细**（每条含 `reason` 与一句「该怎么办」）。⚠️ 三个必须分清的口径：① **没抽到 ≠ 文件里没有**（`no_content` 可能是空文件/加密/纯图）；② **页面正文空 ≠ 这页内容没被索引**（图片/附件/数据库块由附件侧负责）；③ **`partial` 是「搜得到，但只覆盖了一部分」**（典型：混合 PDF 只抽到正文页）—— 别把「已索引 N/N」读成「内容全在检索面里」。**缺口列表可能被截断**（看 `gapsTotal` 与 `gapsTruncated`）。★ 实现只有 TS 那一份（判「没人认领这种格式」必须以 TS 侧抽取器注册表为准；Rust 侧再长一份就是两份实现、而漂移不会报错）⇒ 外部/插件面经 **Rust→前端桥** 取回同一函数的输出（2026-10-29 B3）。 |
| db.rows | read | current-space | read:pages | ✓ |  | 读取一个**数据库页**的行（**只给原始值**，⛔ 不重算公式/汇总；回话里的 note 会说明「可能与界面计算值不同」）。参数: pageId (必填), viewId (可选：套用视图保存的标题过滤与排序), where (可选：简单条件数组，多条 AND，字段必须来自 db.schema，操作符白名单 = != > >= < <= in contains is_null), limit (可选, 默认 100, 上限 500), offset (可选, 默认 0), spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒)。返回 {pageId, spaceId, total, returned, rows:[{id, values}], truncated, note}；过滤与分页在宿主（Rust）侧执行，超过 200 KB 会截断并如实标 truncated。 |
| db.schema | read | current-space | read:pages | ✓ |  | 读取一个**数据库页**的结构：列、视图、关系列。参数: pageId (必填：kind=database 的页面节点 id), spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒)。返回 {pageId, spaceId, views:[{id,name,type}], columns:[{id,name,type,isFormula?,isRollup?}], relations:[{id,name,type}]} —— 公式/汇总列**只标类型、不计算**；关系列（type=ref）单列在 relations 里。 |
| editor.insertText | write | current-space | write:page.current |  | ✓ | 把一段纯文本插入到当前页的光标处（没有光标则追加到页尾）。**即时生效**，不进草稿确认——它只动你正在编辑的这一页。参数: text (必填)。 |
| export.docpackage | read | current-space | export:files | ✓ |  | 把一页打包成 `.shuyodoc` 并**返回句柄**（不返回字节）：{handle, name, size, sha256, expiresAt}。**只支持单页**（与界面「导出为 .shuyodoc」同口径）。参数: pageId (必填)。句柄单次、120 秒、绑本会话；落盘用 blobs.fetch。⚠️ >10MB ⇒ needs_confirm。 |
| export.markdown | read | current-space | export:files | ✓ |  | 把一页导出成 Markdown、或把整个空间导出成 zip，**返回句柄**（不返回字节）：{handle, name, size, sha256, expiresAt}。参数: pageId (可选，单页 ⇒ .md) / spaceId (可选，整空间 ⇒ 含附件的 .zip；跨空间需「只读（全部空间）」档) —— 两者**只能给一个**。句柄单次、120 秒、绑本会话；落盘用 blobs.fetch。⚠️ >10MB ⇒ needs_confirm（本批未接确认 UI，不静默导出）。 |
| files.download | read | current-space | export:files | ✓ |  | 把附件字节取成一个**句柄**（不把字节塞进上下文）：{handle, name, size, sha256, expiresAt}。句柄单次、120 秒有效、绑定本会话；要落盘用 blobs.fetch。参数: attId (必填)。⚠️ >10MB 会返回 needs_confirm（本批未接确认 UI，不静默下载）。 |
| files.export | write | app | export:files |  | ✓ | 把文本内容保存成文件：用户点「保存」才写。参数: fileName (必填, 建议的文件名), content (必填, 要写入的文本)。 |
| files.extract_status | read | current-space | read:files | ✓ |  | 读一个附件的**抽取完整度**（单文件口径）：{attId, name, extracted, segments, extractors:[{extractor, coverage}]}。coverage 是原始 JSON 字符串，空串 = 未知，⛔ 空不等于完整。参数: attId (必填)。 |
| files.list | read | current-space | read:files | ✓ |  | 列出页面附件。参数: pageId (可选, 省略=当前打开的页面)。返回文件名/类型/大小。 |
| files.list_orphan | read | current-space | read:files | ✓ |  | 列出**未整理附件**（没有挂到任何页面的附件）: {files:[{attId,name,mime,size,sha256,createdAt}], total}。参数: limit (可选, 默认 50, 上限 200), offset (可选, 默认 0)。 |
| files.read | read | current-space | read:files | ✓ |  | 读取某个附件的**派生文本**（抽取结果，**不含原文字节**）。参数: id (必填), offset/limit (可选分页)。返回 {segments, total, truncated, coverage}；**还没抽过 ⇒ segments 空 + total 0**（不是失败，别据此断言文件里没有内容）。`truncated` 说的是「这一页没给全」，而 `coverage` 说的是「**抽取本身**有没有承认没抽全」（§15.10：成功 ≠ 抽全了）：coverage 里每个抽取器一条 `{extractor, coverage}`，`coverage` 是原始 JSON（如 `{"complete":false,"gapIndexes":[2]}`），**空字符串或空数组都表示「未知」，不许读成「完整」**。 |
| files.search | read | current-space | read:files | ✓ |  | 在已抽取的文件内容里做块级检索（含扫描件/文档正文）。参数: query (必填), limit (可选, 默认 10)。返回 {chunkId, pageId, attId, loc, snippet, score}：pageId/attId 用来回链到原文位置。 |
| files.stat | read | current-space | read:files | ✓ |  | 读一个附件的元数据：{attId, pageId, name, mime, size, sha256, spaceId}。sha256 是真实的内容指纹（附件就是按它内容寻址存的）。参数: attId (必填)。 |
| kv.get | read | app | kv:own |  |  | 读取插件自己的私有数据。参数: key (必填), scope (可选, 默认 space)。没存过返回 null。与 api.settings 的区别：settings 是**用户**设的、插件只读；kv 是插件自己存的。 |
| kv.remove | write | app | kv:own |  | ✓ | 删掉插件自己的一条私有数据。参数: key (必填), scope (可选, 默认 space)。即时生效。 |
| kv.set | write | app | kv:own |  | ✓ | 写插件自己的私有数据。参数: key (必填), value (必填), scope (可选, 默认 space = 随空间加密；'app' = 明文 meta 库，别放敏感内容)。**即时生效**：只动插件自己的数据，不碰笔记内容，所以不走草稿确认。 |
| log.write | host | app | — |  |  | 写一条插件日志（进插件面板可查的日志缓冲）。参数: message (必填), level (可选, 默认 'info')。**插件里没有 console**，排错只能靠它。 |
| page.current | read | current-space | read:page.current | ✓ |  | 读取当前打开页面的正文。**插件面**返回原始内容字符串（没有打开页面时返回空串）；外部/MCP 面返回与 pages.get 同口径的结构化正文。参数: includeAnchors (可选, 默认 true，仅外部/MCP 面与页面锚点有关；插件面忽略)。 |
| pages.count | read | current-space | read:pages | ✓ |  | 本空间未删除节点的数量（与 pages.list 的集合同口径：页面/数据库/文件夹各算一个）。参数: spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒)。 |
| pages.create | write | current-space | write:pages | ✓ | ✓ | 新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。 |
| pages.get | read | current-space | read:pages | ✓ |  | 读取单个页面的标题与正文纯文本。参数: id (必填), offset/limit (可选分页，按**字符/Unicode 标量**计数), includeAnchors (可选，默认 true：给每个顶层块后加一行 `<!-- b:<blockId> -->` 锚点，传 false 关掉且正文逐字节不变)。**必须看 `chars_total` 与返回长度判断是否读全**：只读了窗口就当整页用，是这类工具最常见的误用。⚠️ 锚点行**不计入** `chars_total`/`offset`：翻页用 `offset + limit`（夹到 `chars_total`）推算，⛔ 别数返回正文的字符数。返回值另带 `rev`（乐观并发令牌，形如 `<更新时间毫秒>:<正文指纹前 8 位>`；按块写回时要原样带回）。 |
| pages.importMarkdown | write | current-space | write:pages | ✓ | ✓ | 导入 Markdown 新建一页（一次调用写完整页）。参数: title (必填), markdown (必填，Markdown 原文), parentId (父页面 id；不传就是顶层)。这是写操作，返回草稿供用户确认。 |
| pages.list | read | current-space | read:pages | ✓ |  | 列出页面（id / 标题 / 创建时间 / 更新时间），按更新时间倒序；不含正文。默认本空间；可用 spaceId 指定别的空间（需「只读（全部空间）」档）。**搜索之外的发现通路**：不知道关键词、或检索返回空时，先用它看这个空间里有什么。参数: limit (可选, 默认 50, 上限 200), spaceId (可选)。 |
| pages.search | read | current-space | read:pages | ✓ |  | 在本空间检索页面（可用 spaceId 指定别的空间，需「只读（全部空间）」档）：关键词用空格分隔 ⇒ 全部出现才算命中（与应用内搜索同一个引擎，含正文与附件抽取文本）。参数: q (必填), limit (可选, 默认 8), spaceId (可选)。返回 [{id,title,snippet}]；**空数组 = 该空间没有命中，不是失败**。 |
| pages.tree | read | current-space | read:pages | ✓ |  | 一次读取**整个空间的页面树**（结构视图）：返回 {spaceId, spaceName, nodes:[{id,title,kind,parentId,order}], total, truncated}。参数: spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒), limit (可选, 默认 2000, 上限 2000)。数据与 pages.list **同一张表、同一口径**（未删除的全部节点，含文件夹与数据库），只是一次给出层级与排序。 |
| pages.update | write | current-space | write:pages | ✓ | ✓ | 更新已有页面：把整页正文替换成新内容（草稿确认）。参数: id (必填目标页), markdown 或 content (二选一，整篇新正文), title (可选新标题)。这是写操作，返回草稿供用户确认。 |
| properties.list | read | current-space | read:properties | ✓ |  | 列出本空间的属性定义 [{id, name, type}]。**写属性要的是 id**（properties.set 的第一个参数），所以通常先调它按名字找 id。参数: spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒)。 |
| properties.set | write | current-space | write:properties |  | ✓ | 设置某个页面的属性值。参数: attrId (必填, 从 properties.list 拿), value (必填), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| settings.get | read | app | kv:own |  |  | 读取用户在插件管理里为该插件设置的值。参数: key (必填, manifest.settings 里声明的 key)。没设过返回 null（此时用你自己的默认值）。**只有宿主界面能写**——插件不能改用户给它设的配置。 |
| spaces.list | read | app | read:pages | ✓ |  | 列出所有空间及当前激活空间（切换空间前先看 id/名称）。只读，不改变任何状态。 |
| spaces.switch | write | app | write:pages |  | ✓ | 切换 ShuyoNote 的当前空间：参数 id 或 name 二选一。这是写操作（影响后续读写作用域），返回草稿供用户确认。 |
| tags.add | write | current-space | write:tags |  | ✓ | 给页面加一个标签。参数: name (必填, 不带 #), pageId (可选, 省略=当前打开的页面)。标签不需要预先创建。这是写操作，返回草稿供用户确认。 |
| tags.list | read | current-space | read:tags | ✓ |  | 列出本空间用到的标签及各自的页面数。参数: spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒)。返回 [{id, name, page_count}]。 |
| trash.list | read | current-space | read:trash | ✓ |  | 列出回收站里已软删除的页面（不含正文，也不恢复/清空）。参数: spaceId (可选；跨空间需外部接入的「只读（全部空间）」档，否则明确拒), limit (可选, 默认 50, 上限 200)。 |
| user.notify | host | app | — |  |  | 给用户弹一条提示。参数: message (必填)。命令执行结束后显示；插件没有 console，这是给人看的那条路（写日志用 log.write）。 |
| version.get | read | current-space | read:versions | ✓ |  | 读取某个历史版本的正文（与 pages.get 同一套分页/锚点口径，只读、不回滚）。参数: pageId (必填), versionId (必填), offset/limit (可选, 默认 6000, 上限 20000), includeAnchors (可选, 默认 true)。版本不存在 ⇒ not_found。 |
| versions.list | read | current-space | read:versions | ✓ |  | 列出某个页面的历史版本（最多 200 条）：返回 [{versionId, at, title}]，按时间倒序；不含正文，读正文请用 version.get。参数: pageId (必填), limit (可选, 默认 50, 上限 200)。 |
