# 阶段 0 · **接口收口**：现状盘点与那一层的边界（2026-09-18）

> 状态：**施工准备**（不含代码改动）。上位：[全量 CRDT 冲刺计划](2026-09-18-crdt-full-migration-plan.md) §3 阶段 0 第 2 条。
> 目标：把「**文档内容的读取 / 写入 / 合并 / 派生**」收成**一层**，让未来换 CRDT（或做块级 LWW）**只改一层**，
> 而不是全仓改。冲刺计划里这条被标为「**不做它，C 会变成无法收尾的重构**」。

---

## 1. 盘点（2026-09-18 实测，按命中数）

**口径**（= 门禁 `scripts/check-doc-content-access.mjs` 的口径，**唯一权威**）：扫
`src/**/*.{ts,tsx}` 与 `src-tauri/src/**/*.rs`，数子串 `content_json` / `content_text` / `contentJson` 的出现次数。

**合计：前端 538 处 / Rust 208 处 = 746 处，分布在 80 个文件（前端 64 / Rust 16）。**

> ⚠️ **两个口径别混**（2026-09-18 收口开工后必须分开看）：
> - **原始读数**（把每一处子串都算上，含那一层自己与测试文件）：**763 处 / 83 文件**；
> - **门禁受约束读数**（扣掉 `LAYER_FILES` 那一层、扣掉 `*.test.ts(x)`）：**644 处 / 68 文件**。
>
> **收口会让"原始读数"上升**（那一层与它的判据**必须**提到这两个字段），
> 而**受约束**那份单调下降（746 → 728 → 644）。**门禁约束的是后者** ——
> 只看原始数会得出"收口失败"的相反结论，这正是上面那句"746 → 763"的由来。

> ⚠️ **旧口径作废**：本文第一版写的是「542 处 / 26 个文件」——那是我**手工扫"主要文件"**得出的，
> 漏了测试文件与零散命中。**以门禁读数为准**（它可复跑、可回归、只减不增）。
> 数字变大**不是**收口变难了，而是第一版**低估**了：要收的是**接口**，不是这 746 个字符串。

| 前端文件（Top 10） | 命中 | Rust 文件（Top 10） | 命中 |
|---|---:|---|---:|
| `lib/platform/web.ts`（Web 平台适配/命令桩；**同一批命令的浏览器实现**） | 126 | `commands.rs`（命令层） | 31 |
| `components/PdfAnnotationCanvas.tsx` | 34 | `blocks.rs`（块 CRUD） | 30 |
| `editor/Editor.tsx` | 29 | `versions.rs`（版本历史） | 26 |
| `components/TemplateCenterView.tsx` | 24 | `plugins.rs`（插件宿主/能力） | 21 |
| `components/EmailPanel.tsx` | 22 | `db.rs` | 15 |
| `App.tsx` | 18 | `search.rs`（FTS/派生） | 15 |
| `lib/ai/lexical.ts` | 14 | `workspaces.rs` | 15 |
| `lib/communityImport.ts` | 14 | `security.rs` | 12 |
| `lib/platform/pageChunks.test.ts` | 14 | `templates.rs` | 10 |
| `lib/ai/apply.ts` | 13 | `sync.rs`（**合并点**） | 9 |

（余下 70 个文件各 ≤ 13 处，其中 **13 个文件只有 1 处**——这类最容易被顺手挪进壳里。）

## 2. **怎么读这张表**（关键：命中数 ≠ 要改的地方）

746 处里**绝大多数是"读"**，而且分三类，代价完全不同：

| 类别 | 例子 | 换 CRDT 时要动吗 |
|---|---|---|
| **派生 / 展示 / 导出**（只读，可从合并后状态重建） | `search.rs`（FTS）、`blocks.rs` 的派生、导出、Markdown、模板、邮件转笔记 | **不必逐个改**——只要它们**从同一个"读出口"拿数据** |
| **平台适配 / 命令桩** | `web.ts` 126 处（同一批命令的浏览器实现） | 同上（跟着接口走，不跟实现走） |
| **真正的写路径与合并点** | 写入命令（`blocks.rs`/`commands.rs`）＋ `sync.rs` 的合并 | ⚠️ **这才是那一层要圈的** |

⇒ **结论**：要收的不是"746 处"，而是「**写入口 ＋ 合并点 ＋ 派生的输入**」这三处。
**先把这三个口封住，746 处里的多数会自然跟着走**（因为它们本来就是"读"）。

## 3. 那一层要做的四件事（API 草案）

```
read(spaceId, pageId)      -> DocContent      // 唯一读出口：拿到"已合并"的内容（带版本）
write(spaceId, pageId, ...) -> Result<...>    // 唯一写入口：**强制经版本号（P0）**
merge(local, remote)        -> { merged, conflicts }   // ★ 今天=页级 LWW；未来换 CRDT **只改这里**
derive(merged)              -> DerivedIndex   // 派生索引重建接口（保持"可重建、不参与同步"的纪律）
```

★ 是**整个收口的意义所在**：`merge` 是唯一知道"怎么合"的地方。
今天它是页级 LWW；阶段 1 把它换成**块级 LWW**；阶段 2/3 换成 **CRDT 合并**——**调用方一行不改**。

## 4. 边界规则（四条，写进门禁而不是写在文档里）

1. **派生索引只能从 `derive` 出**（不许自己扫 `content_json` 生成索引）；
2. **导出 / 备份 / Markdown / 模板只能从 `read` 出**（不许直接读库里的 `content_json`）；
3. **插件与 AI 只能经 `read`/`derive`**（能力层不感知存储形态——这与"插件不该碰加密边界之外"同源）；
4. **同步只能经 `merge`**（不许在别处偷偷做"谁覆盖谁"的判定）。

## 5. 落地顺序（低成本起步，1–2 人日）

1. **先加一层"壳"包住现有实现，行为完全不变**（纯重构、无功能改动）：前端一层 ＋ Rust 一层；
2. **再加一条 grep 门禁**（挂进现有门禁清单）：**除该层外，新增文件不得直接引用 `content_json`/`content_text`**
   —— 存量 **746 处（门禁口径）**以**白名单**登记，**只许减不许增**（这条让"收口"变成一个**单调收敛**的过程，
   而不是一次大爆炸）；
3. 之后每做一次相关改动，顺手把白名单里的条目挪进壳里。

> ✅ **第 2 条已落地**（2026-09-18）：`scripts/check-doc-content-access.mjs` ＋ 逐文件基线
> `scripts/doc-content-access-baseline.json`（**生产面 68 文件 / 634 处**），已登记进 `scripts/lib/gates.mjs`（contract 组）。
> 三条规则：出现**新文件**直接引用 ⇒ 红；某文件计数**超过**基线 ⇒ 红；计数**低于**基线 ⇒ 提示下调基线
> （`--update`，**只允许变小**；首次创建基线豁免——门禁第一次跑时正是它自己把"创建基线即上涨"抓出来的）。
> 豁免名单（本该直接访问的那一层）在脚本的 `LAYER_FILES`：`src/lib/docContent.ts`、`src-tauri/src/doc_content.rs`，
> **2026-09-23 增加第三个**：`src/lib/crdt/contentJsonYDoc.ts` —— 阶段 2 Slice A 落的「`content_json` ⇄ `ydoc` **唯一实现**」
> （见 [2026-09-23-crdt-stage2-kickoff.md](2026-09-23-crdt-stage2-kickoff.md) §3）：它按定义同时提到两种形态，别的地方一律经它转。
>
> 🔧 **口径修订（macOS 侧，2026-09-18，同日）**：**测试代码从计数里排除**（93 个 `*.test.ts(x)`
> ＋ 24 个 Rust 文件末尾的 `#[cfg(test)] mod tests`）。原口径把测试也数进去，效果是"**谁为新功能写一条
> 内容相关的测试，谁就红**"——门禁上线当天就撞上了：`pages.get` 加分页（`dc400c16`）在生产侧的
> 直接访问**净增为零**（同一条 SQL 列、同一个 JSON 键），涨的 13 处全在测试与注释里。换 CRDT 时
> 没人需要改测试夹具里 `INSERT INTO pages (... content_text ...)` 的那一列，它不是替换面。
> 因此 **746 处 / 80 文件 → 634 处 / 68 文件**（只降不升，符合"单调收敛"）；Rust 侧切测试尾部带一个
> **保险**：只有在 `#[cfg(test)] mod tests` 位于文件后半段时才切，否则全量计数（免得中间位置的测试模块
> 把后面的生产代码一起排除）。**生产侧一处的余量都没有**，两处变异（TS 生产文件 +1、Rust 测试模块之前 +1）
> 都实测判红。有异议请直接回滚这一处修改（信箱里有同日的说明信）。

> ⚠️ 与 P0 的关系：`write` 强制带版本号 ⇒ **接口收口最好在 P0（密文格式版本化）之后或同时做**，
> 否则壳的签名会被 P0 再改一次。

## 6. 风险与边界

| 风险 | 缓解 |
|---|---|
| 壳变成"多一层转发"而无收益 | 收益判据是**白名单只减不增**＋`merge` 的调用方零改动 |
| 前后端两套壳语义漂移 | 两侧**同一份 API 草案**（本文件 §3）＋契约测试钉住 |
| 一次性大重构 | 明确**不做大爆炸**：壳先行为等价，白名单逐步收敛 |

## 7. 进展（2026-09-18）

**✅ 第 1 条的 Rust 一侧已落地**：`src-tauri/src/doc_content.rs`（`read` / `write` / `derive` / `derive_fts` /
`local_state` / **`merge`**），调用方已改四处：

| 调用方 | 改了什么 |
|---|---|
| `commands::save_page` | 现状回读 → `read`；UPDATE → `write`；两处派生 → `derive`（SQL 与顺序**逐字**保留） |
| `blocks::resolve_block` / `get_page_blocks` | 各自的 `SELECT content_json …` → `read` |
| `sync::apply_upsert` | ★ **LWW 判定** → `doc_content::merge`（唯一的合并点）；FTS → `derive_fts` |

**行为等价的复核方式**：壳里那 5 条 `merge` 单测是**纯函数**测试，但**Windows 跑不了 `cargo test`**
（`0xC0000139`）⇒ 必须由 AMD/Mac 在被验 commit 上 `cargo test --lib doc_content` 复核（分工见信箱对应回信）。

**白名单**：受约束口径 746 → 728（Rust 壳）→ **644 处 / 68 文件**（前端壳 ＋ 测试文件豁免），
每次都由 `--update` **只减不增**地下调。

**✅ 第 1 条的前端一侧第一切片也已落地**：`src/lib/docContent.ts`
（`readContent` / `writeContent` / `resolveSaveContent` / ★`shouldTakeRemote`），
调用方改道 `platform/web.ts` 的 `applyChange`（LWW 判定）与 `save_page`（保存解析）。
判据：`src/lib/docContent.test.ts` 14 条（真 sql.js ＋ 真平台 schema），
外加门禁 `two-device-sync`（真 `applyChange`）**14 通过 / 0 失败**。
前端 `web.ts` 仍有约 114 处未收（它是浏览器侧**整套命令的实现**，要按命令面分批搬）。

**✅ 前端第二切片：批量读出口 `readAllContents` ＋ 三个"扫全库找块"的命令**
（`get_page_blocks` / `resolve_block` / `list_block_backlinks`）：

| 命令 | 搬运前 | 搬运后 |
|---|---|---|
| `get_page_blocks` | `SELECT content_json FROM pages WHERE id = ? AND deleted_at IS NULL` | `readContent(store, pageId)`（谓词**逐字相同**） |
| `resolve_block` | `SELECT id, title, content_json FROM pages WHERE deleted_at IS NULL`（扫全库） | `readAllContents(store)` |
| `list_block_backlinks` | 同上（扫全库） | `readAllContents(store)` |

**为什么加的是"批量读出口"而不是继续加单页函数**：这两条命令本来就是"扫全库找块"，
逐页调 `readContent` 会变成 N 次查询。`readAllContents` 一次给三列（`title/json/text`），
与 `readContent` 带 `title` 同一条理由 —— 它们在同一行，拆两个函数等于把全表扫两遍；
代价（只用 `json` 的调用方也多读一列 `text`）**写在函数注释里**，将来真成瓶颈就在那一层加重载，
**不许**让调用方回去自己写 `SELECT content_json`。

**行为等价的三条**：谓词逐字相同（`deleted_at IS NULL`）、**没有加 `ORDER BY`**
（`resolve_block` 依赖"第一个命中"，加排序就是行为改动）、`String(row.x ?? "")` 的兜底也照搬。
判据：`docContent.test.ts` **17 条**（新增 3 条：只回未软删、空库给空数组、**钉住"没有 ORDER BY"**）
＋ 门禁 `smoke-web` **350/350** —— 它真的走 `get_page_blocks` / `resolve_block` /
`list_block_backlinks` 三条命令（`scripts/smoke-web.mjs:641/643/665`）。
白名单：`web.ts` **123 → 114**，受约束口径 **644 → 635 处 / 68 文件**（`--update` 只减不增）。

**⏳ 一处故意没搬（记下来，别当成漏了）**：`list_block_backlinks` 读**目标页**那一句
（`SELECT content_json FROM pages WHERE id = ?`）**不带** `deleted_at IS NULL`，
而 `readContent` 带 ⇒ 搬过去会改变"软删页能否算自己的块反链"这个行为。
那属于"顺手修"而不是"只搬不改"，**留作单独一次提交**（还得同时看桌面侧同不同语义）。

**✅ 前端第三切片：合并点的**两侧**都进层（`localState` ＋ `upsertRemoteContent`）**

前两切片只把**判定**（`shouldTakeRemote`）搬进了那一层，而它两侧的 SQL 还留在 `web.ts`
（`applyChange` 里"读本地 `sync_seq`/`dirty`"与"用远端则 `INSERT … ON CONFLICT`"）。
这一轮把两侧补齐——**这才让"同步只能经 merge"（§4 规则 4）在代码上真的成立**：

| 位置 | 搬运前 | 搬运后 |
|---|---|---|
| 合并判定的读数 | `SELECT sync_seq, dirty FROM pages WHERE id = ?`（`applyChange` 内联） | `localState(store, id)`（与 Rust `doc_content::local_state` 同 SQL 同形状） |
| "用远端"落库 | `INSERT … ON CONFLICT … dirty=0`（18 列，`applyChange` 内联） | `upsertRemoteContent(store, row, remoteSeq)` |

两条纪律写在函数注释里：**逐字搬运**（含 `?? "active"` / `?? {}` / `?? 300` / `?? 50` 这些
"看起来能省"的默认值 —— 它们决定远端行缺字段时本地落成什么）；**`dirty` 硬写 0** 是同步契约，
与 `writeContent` 硬写 1 成一对（远端应用 vs 本地改动）。

判据：`docContent.test.ts` **22 条**（新增 5：`localState` 两条 ＋ 插入/覆盖/默认值三条，其中
"覆盖后 dirty 归 0"与"缺字段默认值"是这次搬运唯一可能改变行为的地方）＋ 门禁 `two-device-sync`
**14/14**（它用**真 `applyChange`** 跑两台设备同页并发，含"时钟漂移下 dirty 保护本地"那条 ——
这才是合并点的承重判据）。
白名单：`web.ts` **114 → 106**，受约束口径 **604 → 596 处**（`--update` 只减不增）。

**⏳ 还没做**（别当成收口已完成）：

- **远端写路径**：`sync::apply_upsert` 的 `INSERT … ON CONFLICT` 与 `fetch_page` 的整行 SELECT **仍在原处**；
  **两侧的远端写入口都已搬**（前端 `docContent.upsertRemoteContent`、Rust `doc_content::upsert_remote`
  —— 见下面那条），剩下的是 `fetch_page` 的整行 SELECT，它要 `cover/icon/kind/…`，
  属"页面元数据"而不是"内容"，等元数据那一层有着落再说；
- **SQL 层内联子查询**（`list_block_backlinks` 的 `(SELECT content_json …)`）加一层函数收不了。

**✅ Rust 侧远端写入口也进层了：`doc_content::upsert_remote`**（2026-09-18）

`sync::apply_upsert` 原先只把**判定**交给那一层，`INSERT … ON CONFLICT`（13 列）还写在 `sync.rs` 里。
现在那一笔也搬进 `doc_content.rs` ⇒ **"判定 + 落库"在同一个文件里**，
将来换 CRDT 时 `apply_upsert` 这一整条只改一处。前端那份（18 列，多 `db_rule/icon/cover/...`）
是**同一条 SQL 的另一份实现**；两侧 schema 本就不同，**语义**必须一致：
`sync_seq` 记远端的、`dirty` 硬写 0（与 `write` 硬写 1 成一对）。

**"逐字搬运"是核过的，不是自称**：把 `HEAD:src-tauri/src/sync.rs` 里那条 SQL 与搬完之后的
逐 token 规范化对比 ⇒ **字符串完全相同**（`params!` 的 11 个字段顺序也逐个对齐）。
判据：`cargo check --lib` 干净（Windows 只能证"编得过"）；
**行为**那半按老规矩请 AMD/macOS 在**被验 commit** 上跑 `cargo test --lib doc_content sync::`。
白名单：`sync.rs` **9 → 1**，受约束口径 **593 → 585 处**。


**✅ 顺手清掉一段死代码（并记下一个用户可见的平台差异）：`web.ts::get_graph` 的「块层」**

`get_graph` 返回 `blocks` / `block_edges` 两个数组。桌面侧它们来自**派生表** `blocks`
（`blocks::rebuild_block_graph` 维护，那张表**只建在 Rust 的 schema 里**，Web 侧没有这张表）。
而 Web 侧原先留着两段"扫 `p.content_json` 建块节点/块边"的循环 —— 但**上面那条查询根本没选
`content_json`** ⇒ 两个 `if (!p.content_json) continue;` 必然命中，
**这两段从来没有执行过一次**（注释也承认"block 层图暂为空"）。本仓的门禁
`smoke-web` 只断言了 `graph.pages`，所以它一直没被发现。

**为什么删掉、而不是"把 `content_json` 加回查询让它跑起来"**：那等于在平台层**自己扫内容建索引**，
直接违反 §4 规则 1（派生只能从 `derive` 出）；而且那是 Web 独有的实现，会让两侧的图语义静默漂开。
⇒ 要恢复块层，正路是**先有 Web 侧的派生**（与 Rust 的 `blocks` 表同一份语义），再由 `get_graph` 读派生结果。

**删掉之后守卫自动有了**：谁要是想再把 `content_json` 扫回来，`web.ts` 的计数就会**超过**收口基线
⇒ `check-doc-content-access` 当场红（这也是"受约束口径只减不增"这条设计顺带产生的效果）。
基线：`web.ts` 106 → 103，受约束口径 **596 → 593 处**。

> ⚠️ **未解的差异（要产品/两边一起定，不是我能单方面补的）**：**Web 的图今天没有块层**
> （`blocks: []` / `block_edges: []`），桌面有。要么补 Web 侧的派生，要么在 UI 上把"块层"
> 对 Web 隐藏 —— **不许**在 `get_graph` 里临时扫内容凑一个。

### 7.1 顺带修掉的一个**数据丢失**缺陷（前端壳的第一次"回本"）

`platform/web.ts` 的 `save_page` 原先用 `str(args.content_json ?? "")` 取内容，而**只传标题的保存**
（改名：`store/notes.ts`、`FileManagerView.tsx` 的 `savePage({ id, title })`）**必然**走到它 ⇒
`content_json` / `content_text` 被清成空串，且 `dirty = 1` 会把这份空内容**推到服务端**（别的设备上正文也没了）。
桌面侧一直是保留正文的（`args.content_json.unwrap_or(cur_json)`）——**两侧语义漂移**（正是 §6 那张表里的风险）。
⇒ 把这条语义收进那一层（`resolveSaveContent`），两侧同语义、同判据。

**⏳ 还没做**（别当成收口已完成）：

- **前端一侧的壳未开始**（`src/lib/docContent.ts`）；
- **远端写路径**：`sync::apply_upsert` 的 `INSERT … ON CONFLICT` 与 `fetch_page` 的整行 SELECT 仍在原处
  （前者要 `PageDetail` 的 11 个字段、后者属"页面元数据"，各值得单独一次提交）；
- **SQL 层内联子查询**（`list_block_backlinks` 的 `(SELECT content_json …)`）加一层函数收不了。

**🐛 门禁自身修了一处**（这一条是壳落地时**门禁自己抓出来的**）：豁免层原先只在**校验**分支生效，
`--update` 不认它 ⇒ 壳一落地就再也下调不了基线（`doc_content.rs` 被判成"0 → 9 的新增文件直接引用"）。
现在 `counts`（原始读数，含豁免层）与 `regulated`（受约束/入库，摘掉豁免层）分开。

### 7.2 记一笔：`get_page_blocks` 多读了一列（**观察，不在收口期做**）

来源：macOS 侧对 `feat/doc-content-layer @4a85bbb8` 的复核（信 `2026-09-18-doc-content-layer-rust-shell.reply-1.md` §三）。

`doc_content::read` 一次取三列（`title` / `content_json` / `content_text`），而 `blocks::get_page_blocks`
**只用 `json`** ⇒ 每次"取这一页的块列表"都会**多读一列 `content_text`**（正文纯文本，可能几十 KB），
而这个入口**打开页面就会走到**。

- **语义上没问题** —— 收口期保持"纯搬运"是有意的（`read` 是三列一起取，与搬运前逐字一致）；
- 后续可加 `read_json_only`（或让 `read` 接"要哪几列"）—— **属性能优化，排在收口之后**；
- 记在这里的唯一目的：**别让它变成"以后没人知道这里多读了一列"**。
