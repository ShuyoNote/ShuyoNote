# 知识层本体（**生成物 —— 不要手改** ✗）

> 由 `scripts/gen-knowledge-ontology.mjs` 从 `capabilities/capabilities.json` 生成 ✓
> 判据：`node scripts/check-ontology-generated.mjs`（与注册表逐字节一致；不一致就红 ✓）

| 源 | 值 |
|---|---|
| 注册表文件 | `capabilities/capabilities.json` |
| 注册表 sha256 | `b096be41953f4c7d0d6f575ab9a493916d235d20aab9fd18c8c8b7a8a522701d` |
| `registryVersion` | 1 |
| `apiVersion` | 1.0.0 |
| 能力条数 | **25**（按 `kind`：host 2 / read 15 / write 8） |
| 生成命令 | `node scripts/gen-knowledge-ontology.mjs` |

| id | kind | scope | permission | ai | mediate | desc |
|---|---|---|---|---|---|---|
| backlinks.list | read | current-space | read:backlinks | ✓ |  | 查询哪些页面反向链接到目标页面。参数: pageId (可选, 省略=当前打开的页面)。返回引用它的页面列表。 |
| blocks.append | write | current-space | write:pages | ✓ | ✓ | 向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| blocks.list | read | current-space | read:pages | ✓ |  | 列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (可选, 省略=当前打开的页面), limit (可选)。返回块数组，可用于定位具体块。 |
| coverage.report | read | current-space | read:files | ✓ |  | 检查**整个库**的索引覆盖：哪些内容真的进了检索面、哪些没进、哪些**进了但没抽全**。参数: 无。返回 {summary, report}：`summary` 是一行中文摘要（可直接展示）；`report.attachments` 给出 已索引/没抽全/未索引 的计数与分类，`report.gaps` 给出**明细**（每条含 `reason` 与一句「该怎么办」）。⚠️ 三个必须分清的口径：① **没抽到 ≠ 文件里没有**（`no_content` 可能是空文件/加密/纯图）；② **页面正文空 ≠ 这页内容没被索引**（图片/附件/数据库块由附件侧负责）；③ **`partial` 是「搜得到，但只覆盖了一部分」**（典型：混合 PDF 只抽到正文页）—— 别把「已索引 N/N」读成「内容全在检索面里」。**缺口列表可能被截断**（看 `gapsTotal` 与 `gapsTruncated`）。 ★ **只有 AI 宿主**能实现它（`host: frontend`）：判「没人认领这种格式」必须以 TS 侧的抽取器注册表为准，Rust 侧再长一份就是两份实现、而漂移不会报错 ⇒ 它不进插件 shim／插件类型包／Rust 绑定表，插件调不到。 |
| editor.insertText | write | current-space | write:page.current |  | ✓ | 把一段纯文本插入到当前页的光标处（没有光标则追加到页尾）。**即时生效**，不进草稿确认——它只动你正在编辑的这一页。参数: text (必填)。 |
| files.export | write | app | export:files |  | ✓ | 把文本内容保存成文件：用户点「保存」才写。参数: fileName (必填, 建议的文件名), content (必填, 要写入的文本)。 |
| files.list | read | current-space | read:files | ✓ |  | 列出页面附件。参数: pageId (可选, 省略=当前打开的页面)。返回文件名/类型/大小。 |
| files.read | read | current-space | read:files | ✓ |  | 读取某个附件的**派生文本**（抽取结果，**不含原文字节**）。参数: id (必填), offset/limit (可选分页)。返回 {segments, total, truncated, coverage}；**还没抽过 ⇒ segments 空 + total 0**（不是失败，别据此断言文件里没有内容）。`truncated` 说的是「这一页没给全」，而 `coverage` 说的是「**抽取本身**有没有承认没抽全」（§15.10：成功 ≠ 抽全了）：coverage 里每个抽取器一条 `{extractor, coverage}`，`coverage` 是原始 JSON（如 `{"complete":false,"gapIndexes":[2]}`），**空字符串或空数组都表示「未知」，不许读成「完整」**。 |
| files.search | read | current-space | read:files | ✓ |  | 在已抽取的文件内容里做块级检索（含扫描件/文档正文）。参数: query (必填), limit (可选, 默认 10)。返回 {chunkId, pageId, attId, loc, snippet, score}：pageId/attId 用来回链到原文位置。 |
| kv.get | read | app | kv:own |  |  | 读取插件自己的私有数据。参数: key (必填), scope (可选, 默认 space)。没存过返回 null。与 api.settings 的区别：settings 是**用户**设的、插件只读；kv 是插件自己存的。 |
| kv.remove | write | app | kv:own |  | ✓ | 删掉插件自己的一条私有数据。参数: key (必填), scope (可选, 默认 space)。即时生效。 |
| kv.set | write | app | kv:own |  | ✓ | 写插件自己的私有数据。参数: key (必填), value (必填), scope (可选, 默认 space = 随空间加密；'app' = 明文 meta 库，别放敏感内容)。**即时生效**：只动插件自己的数据，不碰笔记内容，所以不走草稿确认。 |
| log.write | host | app | — |  |  | 写一条插件日志（进插件面板可查的日志缓冲）。参数: message (必填), level (可选, 默认 'info')。**插件里没有 console**，排错只能靠它。 |
| page.current | read | current-space | read:page.current |  |  | 读取当前打开页面的正文（Lexical content_json 的原始字符串）。没有打开页面时返回空串。 |
| pages.count | read | current-space | read:pages |  |  | 本空间未删除页面的数量。 |
| pages.create | write | current-space | write:pages | ✓ | ✓ | 新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。 |
| pages.get | read | current-space | read:pages | ✓ |  | 读取单个页面的标题与正文纯文本。参数: id (必填), offset/limit (可选分页，按**字符/Unicode 标量**计数)。**必须看 `chars_total` 与返回长度判断是否读全**：只读了窗口就当整页用，是这类工具最常见的误用。 |
| pages.list | read | current-space | read:pages |  |  | 列出本空间页面（id / 标题 / 创建时间 / 更新时间），按更新时间倒序。参数: limit (可选, 默认 50, 上限 200)。不含正文。 |
| pages.search | read | current-space | read:pages | ✓ |  | 在本空间检索页面（关键词匹配；应用内 AI 检索会叠加本地嵌入的语义加分，配了嵌入模型时意思相近的内容也能命中）。参数: q (必填, 关键词/内容描述), limit (可选, 默认 8)。返回匹配页面的 id/title/snippet。 |
| properties.list | read | current-space | read:properties |  |  | 列出本空间的属性定义 [{id, name, type}]。**写属性要的是 id**（properties.set 的第一个参数），所以通常先调它按名字找 id。 |
| properties.set | write | current-space | write:properties |  | ✓ | 设置某个页面的属性值。参数: attrId (必填, 从 properties.list 拿), value (必填), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。 |
| settings.get | read | app | kv:own |  |  | 读取用户在插件管理里为该插件设置的值。参数: key (必填, manifest.settings 里声明的 key)。没设过返回 null（此时用你自己的默认值）。**只有宿主界面能写**——插件不能改用户给它设的配置。 |
| tags.add | write | current-space | write:tags |  | ✓ | 给页面加一个标签。参数: name (必填, 不带 #), pageId (可选, 省略=当前打开的页面)。标签不需要预先创建。这是写操作，返回草稿供用户确认。 |
| tags.list | read | current-space | read:tags |  |  | 列出本空间用到的标签及各自的页面数。返回 [{id, name, page_count}]。 |
| user.notify | host | app | — |  |  | 给用户弹一条提示。参数: message (必填)。命令执行结束后显示；插件没有 console，这是给人看的那条路（写日志用 log.write）。 |
