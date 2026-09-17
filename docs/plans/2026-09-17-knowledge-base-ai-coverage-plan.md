# 「全库 AI 覆盖」方案 —— 让存入 ShuyoNote 的一切都可被 AI 检索与总结

> 目标：把**用户存入 ShuyoNote 的全部内容**纳入 AI 可检索、可总结的范围——页面正文与各类型块（附件、绘图、公式、图片、视频、数据库块）、文件夹里的各类格式文档。
> 关联：[薄 Agent 接口方案](2026-08-24-thin-agent-interface-plan.md)（AI 工具层的既有边界）/ [模板变量 + 语义检索方案](2026-08-24-template-var-semantic-search-plan.md)（`page_embeddings` 与向量重排）/ [PDF 批注方案](2026-08-27-pdf-annotation-plan.md)（`pdf://` 回链）/ [附件按需取字节](2026-09-15-attachment-on-demand-plan.md)（附件字节与元数据分离）/ [设计哲学](../design-philosophy.md)（§5.8 插件沙盒红线 / §8 IPC 最小暴露面 / §10 本地优先、倾向本地 AI）。
> ⚠️ 本方案为**提议**，未实现；`docs/README.md` / `roadmap.md` 按「规划（待里程碑落地）」登记，**未标记 ✅**。

---

## 1. 背景与动机

用户提问（2026-09-17）：**「如何做到对 ShuyoNote 知识库做 AI 总结分析？内容包括页面笔记全部内容（页面附件、绘图块、公式等）、文件夹中的各类格式文档、文件、图片、视频等——总而言之，用户存入 ShuyoNote 的所有东西都要纳入 AI 分析的范围。」**

这是一个**覆盖面**问题，不是模型能力问题。经盘点，结论是：

> **AI（以及全文检索 / FTS / 向量嵌入）唯一能看到的字段是 `content_text`。**
> 而 `content_text` 是一份**页面正文的纯文本镜像**——它是为「搜索 / 反链 / 导出」设计的，**不是为多模态内容设计的**。

于是现状是：**文字类基本已覆盖；图片、视频、附件文档、数据库块完全看不见**——恰好是用户点名要补的那一半。

## 2. 现状体检：库里有什么 × AI 看得见什么

### 2.1 页面里能装什么（19 种块类型，`src/editor/nodes/`）

`AttachmentRefNode` / `BlockEmbedNode` / `BlockRefNode` / `CalloutNode` / `ColumnNode`·`ColumnsBlockNode`·`ColumnsNode` / `DrawingNode` / `FormulaNode` / `ImageNode` / `ImageRowNode` / `InlineFormulaNode` / `MediaResolver` / `MermaidNode` / `PageLinkNode` / `PdfRefNode` / `SafeCodeNode` / `VideoNode` / `WebBookmarkNode`

### 2.2 逐个核实「有没有把内容写进 `content_text`」

| 内容类型 | 写入 `content_text`？ | 取证 |
|---|---|---|
| 正文 / 标题 / 列表 / 代码 | ✅ | Lexical 原生 `getTextContent` |
| 公式（块级 + 行内） | ✅ **LaTeX 源码** | `FormulaNode.tsx:3`「its LaTeX source goes into `content_text` so it's searchable」；`InlineFormulaNode.tsx:2` 同义 |
| Mermaid 图 | ✅ **源码** | `MermaidNode.tsx:69`「Surface the source so the page's content_text (search/backlinks) sees it」 |
| **绘图块** | ⚠️ **只有图上的文字标签** | `DrawingNode.tsx:125`「Surface the drawing's **scene text** so `content_text` … sees its **labels**」；`src/lib/drawingText.ts` |
| 页面链接 | ✅ 字面 `[[标题]]` | `PageLinkNode.tsx:52` / `PageLinkPlugin.tsx:44`（为兼容 `content_text` 刻意保留字面量） |
| 网页书签 | ✅ 链接文本 | ⚠️ **被链接网页的正文不在** |
| PDF 摘录 / 批注 | ⚠️ 只有「摘录 + `pdf://` 引用串」 | `pdfAnnotation.ts:170` = `[label, ref].join(" ")`；**PDF 正文本身不在** |
| **图片** | ❌ | `ImageNode` 是 `DecoratorNode`，**未覆写 `getTextContent`** ⇒ 默认空；只有默认空串的 `altText` |
| **视频** | ❌ | `VideoNode` 同上，未覆写 |
| **附件引用（各类文档）** | ❌ | `AttachmentRefNode` 同上，未覆写 |
| **数据库块 / 表格** | ❌ | `DatabaseView.tsx:842` 直接写 `content_text: ""`；应用自己的注释也把 `table` 与 `image`/`embed` 并列 |

### 2.3 应用自己知道这个缺口

`src/App.tsx:93` 原文：

> *"A page 'has content' if its serialized root has at least one top-level block. … (a page with only an **image/embed/table** has empty `content_text` but does contain content)."*

—— 这段注释是为「空页判定」写的，但它**恰好是这个缺口的官方自述**。

## 3. 根因与破局点

**根因**：能力按「块的可见文字」建模，而 AI 的检索面等于 `content_text`。两者之间的差额就是全部多模态内容。

**破局点（本方案的核心判断）**：

> **不要为每种模态新增 AI 工具，而是扩展 `content_text` 之外的「可检索面」——把多模态内容降维成文本，汇进同一层索引。**

理由：现有 AI 工具只有 7 个（`capabilities/capabilities.json` 里 `ai: true`）：`pages.get` / `pages.search` / `blocks.list` / `backlinks.list` / `files.list` + 草稿写 `pages.create` / `blocks.append`。**若为每种模态加工具，工具集会爆炸，且模型必须自己选对工具**——本地 7B 模型在这种工具选择上很不可靠。降维成文本后，现有「搜索 → 读取 → 总结」自动覆盖全部内容。

**已有可复用的三条资产**（不必从零造）：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| **VLM 通道** | `src/lib/ai/ocrVision.ts`（注释原文：*"用「视觉大模型（VLM）」识别页面图片中的文字——对中文/复杂/低清扫描件通常远优于 tesseract"*） | 图片/扫描件/视频关键帧的抽取直接走它 |
| PDF 光栅与文本层 | pdfium / mupdf（`pdf_native.rs`、`pdfium_native.rs`）、pdf.js 文本层 | PDF 文本抽取 |
| 离线 OCR 兜底 | tesseract（chi_sim + eng，`src/lib/ocr.ts`） | VLM 不可用时的降级 |

## 4. 推荐架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① 抽取层（新）—— 把非文本内容降维成文本                              │
│   PDF → pdfium 文本层 / 扫描件 → VLM / 兜底 tesseract               │
│   docx·xlsx·pptx → 解 OOXML（zip+XML）   .doc/.xls → LibreOffice    │
│   图片 → OCR(VLM) 取字 ＋ VLM 描述内容                              │
│   视频 → 关键帧→VLM ＋ 音轨→ASR                                     │
│   绘图块 → scene text（已有）＋ 图形结构序列化（新）                 │
│   数据库块 → 列名＋行＋规则序列化（新）                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 产出纯文本 + 定位信息（页/单元格/时间码）
┌──────────────────────────▼──────────────────────────────────────────┐
│ ② 派生文本层（新表，**不进 content_text**）                          │
│   attachment_text(att_id, kind, text, src_hash, extractor, …)       │
│   —— 内容哈希失效：附件变了才重抽；extractor 带版本：换实现可整批重跑 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ ③ 检索层（改造）—— 分块 ＋ 块级嵌入 ＋ 混合检索                      │
│   chunks(page_id|att_id, ord, loc, text, hash)                     │
│   chunk_embeddings(chunk_id, model, dim, vector, hash)             │
│   BM25/关键词 与 向量 混合 ＋ 重排                                   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ ④ AI 工具层（小幅扩）                                                │
│   新增 files.read（读派生文本）/ files.search（在派生文本里搜）       │
│   现有 pages.get 支持 offset/limit（长文分页读）                     │
│   写入仍走草稿确认（沿用既有写中介）                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## 5. 逐类型抽取矩阵

| 类型 | 手段 | 复用 | 产物定位 |
|---|---|---|---|
| 附件 PDF（有文本层） | pdfium / mupdf | ✅ 已有 | 页号 |
| 附件 PDF（扫描件） | VLM（`ocrVision`） | ✅ 已有通道 | 页号 |
| docx / xlsx / pptx | 解 OOXML（zip + XML） | ❌ 需补 | 段/表/单元格 |
| .doc / .xls / .ppt（旧格式） | LibreOffice headless 转换 | ❌ 需装 LO | 同上 |
| txt / md / csv / json | 直读 | ✅ | 行号 |
| **图片** | ① OCR 取字 ② VLM 描述内容 | ✅ 通道已有 | 无（整图） |
| **视频** | **关键帧 → VLM ＋ 音轨 → ASR** | ❌ 需补，最贵 | 时间码 |
| 绘图块 | scene text（已有）＋ 节点/连线结构（新） | 半有 | 块 id |
| 数据库块 | 列名 ＋ 行 ＋ 规则 | ❌ 需补 | 行 id |

> ⚠️ **图片必须分两档**，否则成本失控：
> **① 全量 OCR 建文本索引**（便宜，覆盖截屏/扫描件/票据/PPT 导出图 —— 大部分价值在这里）；
> **② VLM 只对候选图/关键图跑**（贵但量少，用于"这张图在说什么"）。

## 6. 存储决策：派生文本放哪（**最要紧的一步，选错要返工**）

| 方案 | 优点 | 代价 |
|---|---|---|
| ① 回写 `content_text` | 检索/向量/AI **零改动**全自动覆盖 | `content_text` 是页面正文镜像，塞进几万字附件会**污染正文**、撑爆 FTS，并让 `pages.get` 的 6000 字截断更早发生 |
| ② **独立 sidecar 表**（推荐） | 干净、可重建、可单独失效、**不参与同步** | 搜索/嵌入/AI 工具需同时查两张表 |
| ③ 每份附件生成**派生页** | 用户可见、可引用，天然带 `att://` 回链 | 撑大页面树；与「知识库是用户手写的」这一心智冲突 |

**建议：主用 ②，③ 只在用户主动「把这份附件总结成笔记」时按需生成**（走既有草稿确认流程）。

### 6.1 DDL（建议）

```sql
-- ② 派生文本：**一行 = 一个抽取段（segment）**，不是"一份附件一行"
--    为什么按段存：段自带定位（页/单元格/时间码），是回链与块级检索的最小单位；
--    压成"一份附件一行"会丢掉定位，P2 分块时只能靠猜。
CREATE TABLE IF NOT EXISTS attachment_text (
  att_id     TEXT    NOT NULL,          -- attachments.id
  extractor  TEXT    NOT NULL,          -- 抽取器标识 + 版本（'ooxml.docx@1'）；换实现 ⇒ 可按它整批重跑
  seq        INTEGER NOT NULL,          -- 段序号（稳定、从 0 递增）
  kind       TEXT    NOT NULL,          -- 段类型：'text'|'heading'|'table'|'sheet'|'slide'|'ocr'|'transcript'|…
  text       TEXT    NOT NULL,          -- 段纯文本（不含任何标记）
  loc        TEXT    NOT NULL DEFAULT '', -- 给人看的定位：'p.12' | 'S3!B4' | '00:03:21' | 'slide 7'
  src_hash   TEXT    NOT NULL,          -- 抽取时附件的哈希（内容寻址哈希，见 attachments.rs:291）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (att_id, extractor, seq)
);
CREATE INDEX IF NOT EXISTS idx_attachment_text_src ON attachment_text(att_id, src_hash);
```

-- ③ 分块：页面块与附件块统一进这一张表，检索不再按「页」为单位
CREATE TABLE IF NOT EXISTS chunks (
  id       TEXT PRIMARY KEY,
  page_id  TEXT,                        -- 页面块时非空
  att_id   TEXT,                        -- 附件块时非空
  ord      INTEGER NOT NULL,            -- 块序号
  loc      TEXT NOT NULL DEFAULT '',    -- 回链定位：'p.12' / 'S3!B4' / '00:03:21' / 'blk-xxx'
  lang     TEXT NOT NULL DEFAULT '',
  text     TEXT NOT NULL,
  hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_att  ON chunks(att_id);

-- ④ 块级嵌入：与既有 page_embeddings 同构（模型 + 维度 + 内容哈希）
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
```

**同步口径（明确写死，避免日后争议）**：`attachment_text` / `chunks` / `chunk_embeddings` 均为**本地派生缓存**——**只读、可重建、不进同步、不进备份、不进导出**（与「能重建的绝不是事实源」信条一致）。换设备后由本机重建。

## 7. 索引层必须同步动的四处

| 位置 | 现状 | 要改成 | 取证 |
|---|---|---|---|
| 页面嵌入 | 只嵌入 **标题 + 正文前 500 字** | **分块嵌入**（`chunks`） | `EMBED_TEXT_CAP = 500`，`src/lib/semanticEmbed.ts:144` 与 `src-tauri/src/search.rs` 同值 |
| AI 读页 | **硬截 6000 字**，无翻页 | 支持 `offset`/`limit` | `src/lib/capabilities/frontend.ts:69`：`text.length > 6000 ? text.slice(0,6000)+'…' : text` |
| 检索粒度 | 以**页**为单位，只回 `{id,title,snippet}` | 以**块**为单位，附带 `loc` 定位 | `frontend.ts` 的 `pages.search` 实现 |
| 工具集 | 7 个，无"读附件文本" | 新增 `files.read` / `files.search` | `capabilities/capabilities.json`（`ai: true`）＋ `src/lib/capabilities/frontend.ts` 实现；`scripts/check-capabilities.mjs` 做门禁（声明了没实现会红） |

> 为什么必须分块：**只用前 500 字做向量，等于"只索引了每份文档的封面"**。一份 50 页制度，靠语义找不到第 37 条；而按页取回又是整篇 6000 字截断。**分块是这一步的地基，绕不过去。**

> ⚠️ **一条集成期的实测成本（2026-09-17 接线时发现并已修）**：
> Web 平台的 `SqliteStore.run()` **每写一条就走一次 `db.export()` 全库快照**（`persist()`）。
> 而派生文本的落库是"一次 DELETE + N 次 INSERT"（§15.5 的整体替换），
> ⇒ **一份抽出 500 段的文档 = 501 次全库快照**，全库抽取时是**平方级**开销（慢到不可用）。
> **修法**：给 `SqliteStore` 加 `transaction<T>()`（事务区间内挂起 `persist`、提交时**只快照一次**），
> 并由 `derivedTextStore()` 把 `transaction` 透传给 `AttachmentTextStore`（§15.5 的 `SqlValue` 接口早已预留这一格）。
> **判据是数出来的，不是读代码相信**：单测数适配器的 `save()` 次数 —— 500 段 `replace` ⇒ **1 次**（修复前 501 次）；
> 非事务路径行为不变（仍是 1 写 1 快照）；抛错时回滚且仍落一次快照；嵌套可重入。

## 8. 分步落地（每步独立交付价值，顺序不可颠倒）

### P1 —— 附件文本抽取 ＋ 派生表 ＋ 接进现有检索与工具

**交付**：docx / xlsx / pptx / PDF / txt / 图片(OCR) 的文本抽取；`attachment_text` 落库；`pages.search` 与嵌入链同时命中派生文本；新增 `files.read` 工具。

> **进展（2026-09-17）**
> - **接口已冻结**（§15）。
> - **OOXML 一族的抽取器已实现**：`src/lib/extract/ooxml.ts`（docx/xlsx/pptx），`cost: cpu`。
>   **并已按"真实文档"而非"我造的最小文档"修过一轮**（这条值得单独记，因为它差点被最小夹具放过）：
>   ① `<w:br/>`（段内换行）与 `<w:tab/>`（段内制表）**没有文本内容**，原来"只取所有 `w:t`"会把它们
>   整段丢掉 ⇒ **两行黏成一行、对齐文本丢列位**（真实 docx 里极常见）；
>   ② 改为按文档顺序遍历后，**必须跳过属性块**（`w:pPr`/`w:rPr`/…）——
>   `<w:pPr><w:tabs><w:tab w:pos="720"/></w:tabs>` 是**制表位定义**不是制表符，一路下钻会把 `\t` 灌进正文；
>   ③ `<w:delText>`（修订删除的文字）与 `<w:instrText>`（域代码）原来只是**偶然**没被抽到
>   （localName 恰好不叫 `t`），现已改成**显式排除**。三条各有一条夹具钉住。
>   **pptx 又抓到两处同类缺口（同样是"静默丢内容"，不报错只是少了）**：
>   ④ 幻灯片里的**表格不是 `<p:sp>`**，而是 `<p:graphicFrame><a:tbl>` ⇒ 只取 `p:sp` 会把**整张表丢掉**；
>   ⑤ **演讲者备注**在独立 part `ppt/notesSlides/notesSlideN.xml`，且 **N 与幻灯片编号不是同一个编号**
>      （靠 `_rels` 关联）⇒ 按编号猜会把备注**贴到错的幻灯片上**，那比不抽更糟（回链会指错）。
>      两条各有一条夹具，备注那条的编号**故意不同**（备注 9 属于 slide 1）以防实现走捷径。
>   ⑥ **docx 脚注 / 尾注**同样在独立 part（`word/footnotes.xml` / `endnotes.xml`），
>      正文里只有 `<w:footnoteReference w:id="N"/>` ⇒ 只读 `document.xml` 会把它们整块丢掉。已补；
>      **id `0` / `-1` 是 Word 的分隔符标记、不是内容，必须排除**。
> - **图片 OCR 抽取器已实现**：`src/lib/extract/image.ts`（`image.ocr@1`），`cost: gpu` ——
>   它同时是契约 **§15.3-7**「未注入 `deps.vision` 必须立刻 `provider_error`、不许自建网络」的活样板
>   （该条此前既无实现也无测试，等于空头承诺）。**第二档（VLM 语义描述 → `caption`）按 §13 待拍板第 2 项
>   的默认值留到 P3**，不在 P1。
> - **派生表与落库已实现（TS 侧）**：`src/lib/extract/schema.ts`（DDL 单一事实源）、
>   `store.ts`（读写 + 按 `src_hash` 失效 + 整体替换）、`pipeline.ts`（候选调度与结果归类）。
> - **纯文本抽取器已实现**：`src/lib/extract/text.ts`（`text.plain@1`，txt/md/csv/json/…）。
>   补它的起因是**真样张跑器**：把一个真实 docs 目录指过去，**满屏 `no_extractor`、全是 `.md`**——
>   而 §5 抽取矩阵里"txt / md / csv / json = 直读"那一行**当时并没有实现**。
> - **HTML 抽取器已实现**：`src/lib/extract/html.ts`（`text.html@1`）—— **同一次真样张**里 `.html` 也是
>   `no_extractor`（保存的网页很常见）。口径：**先清 `script/style/noscript/head`**（不清会把一整页 JS
>   当正文灌进索引）、块级元素各起一段、`h1`-`h6` 标 `heading`、行内元素不单独成段。
>   ⚠️ **注册顺序有坑**：`text.plain@1` 的 `text/*` 也匹配 `text/html`，按注册表顺序先到先得 ⇒
>   **html 必须排在它前面**，放反了 HTML 会被当纯文本**原样读出标签**。
> - **真样张冒烟跑器已落地**：`src/lib/extract/realSamples.test.ts`（`EXTRACT_SAMPLES=<目录>` 才跑，
>   否则整体跳过，CI 里惰性）。它已经验到真东西：一份 **638 KB 真 PDF** 抽出 **8 段 / 6398 字**
>   （首段是真中文）；一个真 docs 目录里的 `.md` 全部抽出（最长 **140 段 / 26939 字**），标题与正文类型交替正确。
> - 目前 **8 个测试文件共 114 条**用例（真样张那组另计）；`npx tsc --noEmit` 0 错。
> - **仍未做**：接进 `sqliteStore.ts` / `db.rs` 的真实建表与调用（**Rust 侧需 AMD 或 Mac 复核**）、
>   `files.read` 工具、旧格式（`.xls`）/ 音视频抽取器（见 §12.4 分工表）。
>
> ⚠️ **两条本日新踩的坑，都记在这里免得后人重复**：
> ① **假对象会造出假 bug**：真样张跑器第一版图省事写了个内存假 store，它没实现 SELECT，
>    于是每份样张都报「0 段 / 0 字」——看起来像抽取器坏了，**差点据此向 Mac 侧报一条假 bug**。
>    ⇒ 跑真样张必须用真 SQLite（已改用 `sql.js`）。
> ② **为合成夹具写的断言，用在真样张上会假阳性**：`不许残留标签`（`/<[a-zA-Z/]/`）这条对夹具成立
>    （输入是我造的），但真文档里本来就可能出现 `<`（正文在讲 HTML/XML）。硬判会把跑器训练成
>    "红了也没人看"，**比没有检查更糟** ⇒ 真样张只保留"序号从 0 连续"这类硬判据，其余降级为提示。

#### 已知边界（**哪些是"故意不抽"的**，别当 bug 修）

实测确认、且当前实现**有意不覆盖**的几处。写出来是为了让人分清「还没做」与「故意不做」——
后者有明确理由，改之前先读这里：

| 内容 | 状态 | 为什么 |
|---|---|---|
| **docx 页眉 / 页脚** | **故意不抽** | 绝大多数是页码、公司名、密级标记 —— 抽出来是**噪声**，会把每一页都变成"命中同一批无关词"。真要抽，应作为**独立段并显式标注**，而不是顺手带上 |
| **xlsx 日期显示成序列号** | **暂不转换** | Excel 把 `45678` 显示成日期靠的是 `styles.xml` 的 numFmt。转换要解析 `cellXfs` + 内建格式号 + 自定义格式串；**猜错就是凭空造数据**（把真数字变成假日期），比"如实给出原始值"更糟。**建议立为 §13 的待拍板项**：做不做、以及"以 Excel 显示值为准"这条口径谁定 |
| docx **脚注 / 尾注** | ✅ **已补** | 它们是**真内容**（制度文件里常见），在独立 part。现已按 part 抽取，`loc` = `脚注 N` / `尾注 N`；**id `0`/`-1` 是 Word 的分隔符标记、不是内容，已排除**（夹具里专门放了这两条） |
| pptx **批注 / 隐藏幻灯片** | 未做 | 与"抽取可见内容"的语义不同（隐藏片算不算内容，是产品决定） |
| docx **文本框 / 艺术字** | **意外覆盖** | `runText` 默认下钻 ⇒ `w:txbxContent` 里的文字**会被抽到**。这是**顺带的好处而非设计**，记在此以免后人误以为"没处理"或误删那条默认分支 |
| 附件里**嵌套的其它文件** | 未做 | 属"递归抽取"，会引入深度/爆炸问题，须单独设计 |
>
> ⚠️ **一个环境坑，记下来免得后人重踩**：**happy-dom 不支持 `getElementsByTagNameNS("*", name)` 的通配**（恒返回 0 条），
> 而浏览器与 WebView 支持 ⇒ 用它会造成"测试绿、线上崩"或反过来。故 `ooxml.ts` 改为**手工遍历比 `localName`**，
> 三者行为一致且**与前缀无关**。
>
> ⚠️ **第二个坑**：`sql.js` 的 `run()` 只吃**单条**语句。故 `schema.ts` 里每条 DDL 都保证是单语句
> （原先把两条 `CREATE INDEX` 写在一个串里，靠 `exec()` 才能跑——那是个隐式依赖，已拆开）。

**为什么先做这一步**：它**一次性补上"看不见的那一半"**，且**不改 AI 工具集的形态**（只加一个读工具）。

**验收**：① 导入一份 50 页 PDF，`files.read` 能返回全文（分页）；② 搜正文第 30 页的专有名词能命中；③ 附件改动后 `src_hash` 不一致 ⇒ 重抽一次；④ 派生表不参与同步（同步往返前后行数不变）。

### P2 —— 分块 ＋ 块级嵌入 ＋ 混合检索

**交付**：`chunks` / `chunk_embeddings`；分块策略（300–800 字、带重叠、保留 `loc`）；BM25 + 向量混合与重排；`files.search` 工具。

**验收**：① 「在库里找关于 X 的条款」返回的是**块 + 定位**而不是整页；② 50 页文档里第 37 条能被语义召回（P1 之前必然失败）；③ 嵌入端点不可达时**优雅回退关键词**（沿用既有降级策略，搜索永不中断）。

> **进展（2026-09-17，P2 前半已落地，TS 侧）**
> - `src/lib/extract/chunk.ts`（分块）＋ `chunkStore.ts`（落库/读回/整体替换）。
> - **分块口径**：目标 500 字、**硬上限 800 字**、重叠 80 字、收尾碎片 <300 字时并入上一块；
>   `loc` 记本块**主体**起点（**重叠前缀不计入**）；页面路径下**标题只挂第一块**
>   （每块都挂会让标题在向量里反复出现并被摊薄）。
> - **一条被测试逼出来的修正**：我第一版让"主体 ≤ max"，然后才加重叠前缀 ——
>   最终文本 **878 > 800**，**硬上限直接被冲破**。⇒ 引入**主体预算 = `max − overlap`**：
>   硬上限是对**最终文本（含前缀）**说的，那才是被嵌入、被 AI 读到的字符串。
> - **`id = <ownerKey>#<ord>`（稳定）＋ `hash = fnv1a32(text)`**：源文本没变 ⇒ id 与 hash 都不变
>   ⇒ `chunk_embeddings` 里的向量**自然复用**；源变了 hash 变 ⇒ 重算。重切时**整体替换**，
>   新块更少会删掉多余旧行（**不留孤儿向量**，有判据）。
> - **哈希抽成了中性模块** `src/lib/hash.ts`：原先 `embedHash` 长在 `semanticEmbed.ts` 里，
>   从抽取层直接 import 它会把"含网络客户端的模块"带进抽取层的模块图 ——
>   而抽取层的隔离性正是它能在 CI/Node 跑纯函数测试的前提。抽出来后**一处实现两处用**
>   （有一条判据专门断言 `fnv1a32` 与 `embedHash` 逐字一致，防两处漂移）。
> - ⚠️ **§13 第 5 项（分块参数是否按语言区分）我按要求"按建议默认值推进"但没擅自实现**：
>   `lang` 字段**照实记录**（保守检测，认不出来返回空、**不猜**），但**策略目前不随语言变化** ——
>   中英混排要不要两套参数，得用真实语料测过才有结论，凭感觉分两套只会更难解释。
> - **仍未做**：块级嵌入（`chunk_embeddings` 的写入）、BM25+向量混合与重排、`files.search` 工具
>   —— 前两项在检索链路，**Rust 侧改动我在本机不能自验**（§12.1）。

### P3 —— 长尾模态：视频 / 音频 / 数据库块 / 绘图结构

**交付**：关键帧 → VLM、音轨 → ASR；数据库块序列化；绘图块的节点-连线结构序列化。

**验收**：① 一段 20 分钟会议视频能问出「第 12 分钟提到的截止日期」；② 数据库块能被「找出所有状态=进行中的条目」这类问题覆盖。

### P4 —— 跨库总结管线 ＋ 强制引用

**交付**：map-reduce（分批读 → 分批总结 → 归并）；**输出必须带 `att://` / `pdf://#page` / `blk-` 回链**；查不到就明确说查不到。

**验收**：① 「汇总这 20 份纪要的行动项」输出可分条溯源到具体文件与位置；② 对不存在的主题，回答"未在库中找到依据"而不是编造。

## 9. 利弊（诚实标注）

### 利
- **覆盖面从"正文文字"扩到"全部存入物"**，这是用户直接点名的缺口。
- **不新增任意文件/命令暴露**：抽取发生在已导入的附件上，附件本就是应用自己的数据（对齐 §8 IPC 最小暴露面）。
- **复用三条既有资产**（VLM 通道 / pdfium / tesseract），P1 的增量工程量主要在格式解析与落库。
- **派生表可重建、不同步** ⇒ 试错成本低：抽取器写坏了，删表重跑即可，不动用户数据。

### 弊 / 取舍
- **首次全量抽取是重活**：CPU/VLM 密集，且见下条硬件约束。
- **本机 6GB 显存放不下「文本模型 + 嵌入 + VLM」三件常驻** ⇒ 抽取阶段必须**排队错峰**。这是架构约束，不是可优化项。
- **抽取必然有损**：表格结构、扫描件错字、图表数值都会丢/错。**因此必须带引用**，并明确"派生文本可能与原件不一致，以原件为准"。
- **视频是最贵的一类**：建议**默认关、单独开关**，不进"一键全库索引"的默认路径。
- **不影响用户可见的存储体积**吗？——会占用本地磁盘（派生文本 + 向量），但**不进同步与备份** ⇒ 不放大跨设备成本。

## 10. 安全与隐私边界（红线）

- **不新增任意文件系统访问**：抽取只作用于**已导入的附件**（`attachments` 表内的内容寻址文件）。**不遍历用户磁盘**——那是另一个方向（外部网盘索引），须另起方案并重新权衡边界。
- **默认不出网**：抽取默认走本地 VLM/OCR；若用户配置了云端 provider，须在**开始索引前**明确提示"以下内容将发送到该端点"，并允许按类型关闭。
- **不在后台自动跑**：全量抽取**只在用户显式点击「开始索引」时执行**，可中断、可续跑，有进度。
- **派生文本是本地缓存**：不同步、不备份、不导出。
- **AI 写操作仍走草稿确认**：本方案不放松既有写中介（`pages.create` / `blocks.append` 的 `{draft:true}` + 用户确认）。

## 11. 测试与验收标准（总）

- [ ] P1：导入 PDF/docx/xlsx/图片各一份，`files.read` 均能返回文本；50 页 PDF 不因 6000 字截断而丢后文。
- [ ] P1：附件内容变更后 `src_hash` 不匹配 ⇒ 自动重抽；未变更 ⇒ 命中缓存不重抽。
- [ ] P1：派生表**不参与同步**（同步往返前后 `attachment_text` 行数为 0 增长）。
- [ ] P2：块级检索返回 `{att_id|page_id, loc, text}`；同一问题在 P2 前后的召回对比有可复现差异（用第 37 条那个例子）。
- [ ] P2：嵌入端点不可达时搜索可用（回退关键词），无中断。
- [ ] P3：视频时间码可定位；数据库块可被结构化问题命中。
- [ ] P4：汇总类回答**每条结论都可溯源**；无依据时显式回答"未找到"。
- [ ] 全流程：`cargo check` / `npx tsc --noEmit` / `node scripts/smoke-web.mjs` 无回归；新增的 `ai: true` 工具通过 `scripts/check-capabilities.mjs` 门禁。
- [ ] 隐私：默认配置下（无云端 provider）**抓包无出网**。

## 12. 分工与协作纪律（三台机器：Windows / macOS / AMD）

> 本条沿用仓库既有先例：[国密方案 §9 / §9.1](2026-09-16-sm-crypto-full-plan.md) 的三机分工——**按机器能力排，不按人头**。

### 12.1 一条硬前提：Windows 跑不了 `cargo test`

`docs/plans/2026-09-16-sm-crypto-full-plan.md:294` 已记录（2026-09-17 实测）：

> ⚠️ **验收纪律（硬要求）**：**Windows 跑不了 `cargo test`**（`0xc0000139`，即 `STATUS_ENTRYPOINT_NOT_FOUND`），所以 Windows 侧的改动必须由 AMD 或 Mac 复核——"在我这边编过了"不等于"测过了"，更不等于"能打开"。
> **根因**（由 `2026-09-17-division-of-labor.md` 的"发现 3"查实）：**System32 的 `libcrypto-3-x64.dll` 抢了加载**——不是配置问题，是环境层面抢 DLL，故**本机不可修**，只能靠交叉复核。

而本方案的 P1/P2 改动**主要落在 Rust 与共享层**：`db.rs`（1020 行）/ `search.rs`（737）/ `attachments.rs`（994）/ `sqliteStore.ts`（438）/ `web.ts`（3388）/ `capabilities.json`（1040）。

⇒ **不拉 AMD 或 Mac，P1 无法闭环验收。** 这不是"人多力量大"，是**这台机器做不了那件事**。

### 12.2 归属（按模块，尽量文件零重叠）

| 归属 | 范围（文件） |
|---|---|
| **抽取层（新增）** | 抽取器模块，每个格式一族、纯函数 `bytes → text`；**不碰 `db.rs` / `search.rs`** |
| **派生表与迁移** | `src-tauri/src/db.rs`、`src/lib/platform/sqliteStore.ts`（建表 + 照 `:492-499` 的 `pragma_table_info` 守卫式迁移） |
| **检索链路** | `src-tauri/src/search.rs`、`src/lib/semanticEmbed.ts`、`src/lib/platform/web.ts`（分块检索分支） |
| **能力注册** | `capabilities/capabilities.json`、`src/lib/capabilities/frontend.ts` |
| **⚠️ 交界（串行点）** | **`db.rs` 的表结构**与 **`capabilities.json` 的工具契约**是全局交界：**各自分支开发，合并时由一人统一处理冲突**（照 sm-crypto §9 的做法） |

### 12.3 可并行的两条轴（且各有兜底）

**轴 1 —— 格式抽取器分家。** 每个抽取器是纯函数、彼此零共享，是**唯一干净的并行轴**：
`OOXML 一族（docx/xlsx/pptx）` / `PDF + 扫描件一族` / `图片一族` /（P3）`视频音频一族`。

**轴 2 —— 平台同构。** `scripts/check-web-commands.mjs` 强制三向一致（Rust 有 → `web.ts` 必须实现；Rust 有 → `CommandMap` 必须声明；CommandMap 有 → 桌面必须注册，或显式登记为「Web 专属」）⇒ `files.read` / `files.search` **必须写两遍**，可分两台各写一侧，**跑偏会被门禁抓住**。

> ⚠️ **前置：接口必须先冻结，冻结之后才分。** 要冻的是：抽取器签名 / `kind` 枚举 / `loc` 格式 / 错误语义 / `extractor` 版本号。
> **接口没冻就分三份 = 三套各自能跑、但合不到一起的实现。**
>
> ⇒ **已于 2026-09-17 冻结，契约见 [§15 附录 A](#15-附录-a抽取器接口契约冻结v1)。** 分家前请以那一节为准，不要再各自发挥。

### 12.4 分工表（**2026-09-17 填实**，按机器能力，不按人头）

**三台机器的实测规格**（各自自报，2026-09-17）：

| | Windows（本机） | Mac（Mac Studio） | AMD（Strix Halo） |
|---|---|---|---|
| GPU | RTX 3060 Laptop **6 GB** | **Apple M4 Max 40 核 GPU** | **Radeon 8060S**（`gfx1151` iGPU） |
| 显存额度 | 6 GB | 统一内存 48 GB（留 ~32 GB 给模型安全） | **64 GB 级**（OS 见 63.6 GiB + 另有 64 GB 划给 iGPU）* |
| CPU | i7-12700H 14C/20T | M4 Max 16C | Ryzen AI MAX+ 395 **16C/32T** |
| 内存 | 64 GB | 48 GB 统一 | 128 GB 物理 |
| 系统盘可用 | 1403 GB | 814 GB | 683 GB（WSL2 942 GB） |
| `cargo test` | ❌ 跑不了（`0xc0000139`） | ✅ 298 passed / 0 failed / 4 ignored | ✅ 302 总数全绿 |
| 本地推理 | ❌ 未装（Ollama 未安装） | ❌ **未装**（ollama / LM Studio / Jan 全无） | ❌ **未装**；且 **Ollama 现在装不上**（见下） |

\* AMD 报的 "4GiB" 是 Windows `AdapterRAM` 这个 **32 位字段**的显示上限，不是真实额度 —— 别照着它做容量判断。

| 模块 | 谁 | 依据 | 状态 |
|---|---|---|---|
| **接口冻结** | **Windows** | 并行的前置，不能省 | ✅ **已完成**（§15） |
| **OOXML 一族**（docx/xlsx/pptx） | **Windows** | 纯解析、不吃 GPU，最适合放短板机 | ✅ **已完成**（`bce2d31`） |
| **派生表 / 存储 / 调度**（TS 侧） | **Windows** | 集成面，串行点 | ✅ **已完成**（`38a4bd3`） |
| **图片 OCR 骨架**（`image.ocr@1`） | **Windows** | 定契约与形状 | ✅ **已完成**（`a385748`） |
| **图片 + 音视频一族**（实跑/调优） | **AMD** | 唯一吃 GPU 的抽取轴，而它**显存额度最大**（64 GB 级） | ⏳ 排在 AMD 的国密 P2 之后 |
| **PDF + 扫描件一族** | **Mac**（首选）+ **AMD**（备选，若 VLM 选型未定就先接这条） | Mac 有真 PDF 阅读器与 OCR 全链路可当对照；纯 CPU、马上能动 | ⏳ 排在 Mac 的国密 P0/P1 之后 |
| **Rust 侧测试复核** | **Mac（首选）+ AMD（长期）** | **只有它们能跑 `cargo test`**（§12.1） | ✅ 随时可用 |
| **全库抽取实跑机** | **AMD 为主、Mac 为备** | 算力；Mac 亦自荐承担 | ⚠️ **取决于 §13 第 7 项**（装不装本地推理） |
| **集成 + 检索链路**（`db.rs`/`search.rs`/`web.ts`/`capabilities.json`） | **Windows** | 唯一串行点 | ⏳ 进行中 |
| **P2（分块 + 块级嵌入）** | **不分家** | 耦合最紧的地基 | ⏳ 等 P1 合并后再议 |

**两条必须写下的现实（都是对方实测，不是推测）**：

1. **AMD 那台的瓶颈不是算力，是"运行时一个都没装"**：Ollama 现在**装不上** ——
   `ollama.com/download` → 307 跳到 `github.com/.../releases/latest/download`，而**该机 GitHub 443 不通**（下载 0 字节）。
   **可达的替代路径**（均实测 http=200）：模型权重走 **hf-mirror.com**、Python 依赖走**清华 PyPI**，
   在 **WSL2 里跑 CPU 推理**（16C/32T + 63 GiB 够）；**ROCm/GPU 在 WSL 里的可行性未验**。
2. **Mac 那台也没装任何本地推理**（需装运行时 + 拉模型，几个 GB 到十几个 GB，属资源决策）。

> **不要为并行而并行**：仓库里 sm-crypto 那次敢分，是因为模块边界清楚（`crypto.rs`/`security.rs` vs `pdf_native.rs`，文件零重叠）；本方案的耦合面大得多，硬分就是三台机器轮流解冲突。

### 12.5 协作纪律（四条，必须一并生效）

- ❌ **禁止 `git add -A`** —— 本仓库有并发会话，**曾误提交他人 WIP**；✅ 只 `git add <自己的文件>`，提交前对 `git status --porcelain`。（出处：sm-crypto-full-plan §9.1 末）
- ✅ **"编过了"不等于"测过了"**：Rust 侧改动必须由**能跑 `cargo test`** 的机器复核（§12.1）。
- ⚠️ **跑 `cargo test` 不要加 `--lib`**（AMD 实测教训，2026-09-17）：`--lib` **不构建宿主二进制** ⇒
  34 条 `plugins::tests::*` 全部失败，看起来像"34 条红"，其实是命令用错。测试自己就印了正确的提示。
  **正确命令是 `cargo test`（不加 `--lib`）**。这条值得单列：它已经浪费过一轮排查（并产出了一份错误结论）。
- ✅ **同一组夹具跑三份实现**：格式抽取器分家后，三份实现共用一组夹具（同一批样张 → 期望文本），否则会退化成"三套都能跑但结果不一致"。
- ⚠️ **一个会话 = 一份 clone / worktree**（2026-09-17 事故后新增，三方已确认）：
  `reset` / `stash` / `index` 是**全局状态**，两个会话共用一份工作树 ⇒ 必出事故。
  **真实事故**：本机把 `dev` **reset 过了已推送的 `6242299`**，于是"已提交过的内容"在工作区里
  看起来像"未提交改动" —— 此时一次 `git commit -a` 就会产生重复补丁，一次 `git reset --hard` 就会**真的丢掉它**
  （本地 HEAD 已不含它，只剩 origin 上有）。
  **机器判据**（比"小心"可靠，Mac/AMD 各自提了一条，合并如下）：
  ```bash
  git status -sb            # 出现 [behind N] 且工作区同时有改动 ⇒ 先停下，不要 add/commit
  git log --oneline origin/<branch> -- $(git diff --name-only) | head
  #   有输出 ⇒ 这些改动**已经在 origin 上**了，此时**绝不要 commit**
  ```
  **destructive 操作前先把工作区差异落成仓库外的 patch**（`git diff HEAD > x.patch`）——
  本次事故没造成损失，靠的就是这一步。
  > 三方核对结果（2026-09-17）：Mac / AMD 都在**各自机器**上、都确认选 A；⇒ 那次 reset
  > **发生在本机**，即本机确实有 **≥2 个会话共用一个工作树**（`5e3bff3` 与 `0dff4e0` 两个不同身份都在本机提交过）。
  > **根治只能靠"另一个会话搬到自己的 worktree"**（AMD 那边就是 4 个 worktree 共用一个 `.git` 的做法）。

## 13. 待拍板

1. **P1 的格式优先级**：先做 OOXML（docx/xlsx/pptx，纯 Rust/TS 解析）还是先接 LibreOffice headless（一次覆盖旧格式但引入外部依赖）？
2. **图片的第二档（VLM 描述）要不要进 P1**，还是只做 OCR、描述留到 P3？
3. **派生文本是否允许用户查看/编辑**（排查抽取质量时有用，但会变成"第二份真相"）。
4. **视频/音频是否本机跑**（whisper.cpp 类）还是明确"暂不支持"。
5. **分块参数**（大小/重叠）是否要按语言区分（中英混排）。
6. ~~**三台机器的 GPU / 显存规格**~~ —— ✅ **已答（2026-09-17）**，见 §12.4 顶部的规格表。
7. **图片 / 音视频抽取走「远程 API」还是「本机推理」？**（**当前最要紧的一项**，Mac 侧提出）
   - **远程**（复用 `ocrVision.ts` 的 provider）：零部署，但全库跑是**按量付费**；
   - **本机**：一次性下载换吞吐，但**三台机器目前一个推理运行时都没装**，且 **AMD 那台 GitHub 443 不通**
     （Ollama 装不上，需走 hf-mirror + 清华 PyPI + WSL2 CPU 推理，或先解决出网）。
   - **Mac 侧明确提醒：别默认走远程。** 这是一笔要算的账，不是技术细节。
   - ⇒ **需用户拍板**（涉及采购/带宽/时间，不该由 agent 决定）。
8. **VLM / ASR 的具体选型**（4B–8B 量化 VLM；ASR 是否本机 whisper.cpp 类）——
   与第 7 项绑定；定了才能给 AMD 那台"图片 + 音视频一族"开工。

## 14. 结论

用户要的「全部纳入」**不是换一个更大的模型能解决的**——瓶颈在检索面而不是模型能力。正解是**把多模态内容降维成文本、汇进统一的可检索层**：

- **P1 补上缺失的一半**（附件/图片的文本），**不改 AI 工具集形态**，投入产出比最高；
- **P2 的分块是地基**（当前的"每页只索引前 500 字"等于只索引封面）；
- **P3/P4 是长尾与可信度**。

按本方案分步走，**7B 级本地模型也能拿到可用的全库问答**，因为每一步的输入都变短了。反过来，**跳过 P1/P2 直接做跨库总结，只会产出没有依据的漂亮话**。

---

## 15. 附录 A：抽取器接口契约（**冻结，v1**）

> 冻结日期 **2026-09-17**。依据 §12.3：**接口不冻就分家 = 三套各自能跑、但合不到一起的实现**。
> 冻结内容：**签名 / 段类型枚举 / `loc` 格式 / 错误码 / `extractor` 版本规则 / 与 DB 的映射**。
> ⚠️ 分家开工前**以本节为准**，不要各自发挥；要改契约先回本方案改这里，再动实现。

### 15.1 冻的是什么、为什么

| 冻结项 | 冻成什么 | 不冻会怎样 |
|---|---|---|
| 抽取器签名 | `extract(ExtractInput) → Promise<ExtractResult>` | 三份实现各自返回不同形状，调度器要写三套分支 |
| 段类型（`kind`） | 固定枚举（见下） | 检索侧无法统一展示与权重 |
| 定位（`loc`） | **给人看的字符串**，格式按 `kind` 约定 | 回链对不上 |
| 错误语义 | **结构化错误码，不抛异常** | 一处抛、一处吞 ⇒ 统计不出"encrypted 占比" |
| 版本 | `id = "<family>.<format>@<n>"` | 换实现后无法整批重跑，也无法判断缓存是否可信 |
| 与 DB 的映射 | 一行 = 一个段（`attachment_text`，见 §6.1） | 定位丢失，P2 分块只能靠猜 |

### 15.2 TypeScript 契约

```ts
/** 抽取器的算力档位 —— 调度器据此排队（本机 6GB 显存放不下三件常驻，见 §9）。 */
export type ExtractCost = "cpu" | "gpu";

/** 段类型：决定检索侧如何展示与加权，也决定 loc 的格式。 */
export type SegmentKind =
  | "text"        // 普通正文
  | "heading"     // 标题（docx Heading / pptx 标题占位符）
  | "table"       // 表格（text 内用 \t 分列、\n 分行）
  | "sheet"       // 工作表整表（loc = 'S<名或序号>'）
  | "slide"       // 幻灯片（loc = 'slide <n>'）
  | "ocr"         // 由图像识别得到的文字（loc = 'p.<n>' 或 ''）
  | "caption"     // 图像/图表的语义描述（VLM 产出）
  | "transcript"; // 音视频转写（loc = 'HH:MM:SS'）

export type ExtractErrorCode =
  | "unsupported"     // 本抽取器不认这个格式（调度器应换一个）
  | "encrypted"       // 加密 / 口令保护
  | "corrupt"         // 结构损坏
  | "empty"           // 合法但抽不出内容（扫描件常见）
  | "timeout"
  | "provider_error"  // VLM/ASR 端点不可达或未配置
  | "internal";

export interface ExtractDeps {
  /** 视觉模型调用（图片 / 视频关键帧）。**由调度器注入**，抽取器不自建网络客户端。
   *  未注入时，`cost: "gpu"` 的抽取器必须返回 `provider_error`，不许抛。 */
  vision?: (prompt: string, image: Uint8Array, mime: string) => Promise<string>;
}

export interface ExtractInput {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  /** 附件内容寻址哈希（attachments.rs:291）。回写 src_hash，并用于日志关联。 */
  hash: string;
  deps: ExtractDeps;
}

export interface ExtractedSegment {
  kind: SegmentKind;
  /** **纯文本**：不含 Markdown / HTML / 任何标记。检索与嵌入直接用这一份。 */
  text: string;
  /** 给人看的定位：'p.12' | 'S3!B4' | 'slide 7' | '00:03:21' | ''（无定位时）。 */
  loc: string;
}

export type ExtractResult =
  | { ok: true;  extractor: string; segments: ExtractedSegment[] }
  | { ok: false; extractor: string; code: ExtractErrorCode; message: string };

export interface Extractor {
  /** **稳定标识 + 版本**：'<family>.<format>@<n>'，例：'ooxml.docx@1'、'pdf.text@1'、'image.vlm@1'。
   *  换实现 ⇒ 升 n ⇒ 可按 extractor 整批重跑（§6.1 的 extractor 列）。 */
  readonly id: string;
  /** 认领的 MIME（小写；可用 'application/vnd.openxmlformats-officedocument.*' 这类前缀通配）。 */
  readonly mimes: readonly string[];
  /** MIME 缺失/不可信时的扩展名兜底（小写，含点）。 */
  readonly extensions: readonly string[];
  /** 算力档位：调度器按它排队错峰。 */
  readonly cost: ExtractCost;
  extract(input: ExtractInput): Promise<ExtractResult>;
}
```

### 15.3 九条不变量（实现者必须遵守，评审按这九条看）

1. **抽取器只做「格式 → 带定位的段」，不做分块。** 分块是 P2 的职责；两处都切会切两遍且边界不一致。
2. **失败返回 `{ok:false, code}`，不抛异常。** 让调度器能分类统计并决定是否换抽取器。
3. **`text` 必须是纯文本**（无标记、无转义）。表格用 `\t` 分列、`\n` 分行，不引入 HTML 表格。
4. **`loc` 是给人看的，不做机器解析。** 回链由页面侧的 `att://` / `pdf://#page` 负责，抽取器不管。
5. **确定性**：同一 `bytes` + 同一 `id` ⇒ **同一输出**。否则 §6.1 的 `src_hash` 缓存语义不成立（会反复重抽）。
6. **无副作用**：不写盘、不改全局状态；网络只经注入的 `deps.vision`。
7. **不自建网络客户端**：`cost:"gpu"` 的抽取器在 `deps.vision` 缺失时必须立刻 `provider_error`，
   不许"顺手"读个环境变量自己连——那会让"默认不出网"的承诺失效（§10 红线）。
8. **`id` 带版本**，且**同一 `family.format` 的多版本可共存**（便于灰度：新版本先跑一小批比对）。
9. **顺序稳定且从 0 递增**：`seq` 在同一 `(att_id, extractor)` 下稳定，便于增量 diff。
10. **归一化不在抽取器里做**：落库前的统一归一化由**管道层**施加一次（见 §15.9）。
    抽取器只负责"格式 → 段"，**不要在自己的 `normalizeText` 里加 NFKC 之类** ——
    一处归一化才有"下游不可能忘"的性质，两处会让人以为别处也做了。
    （原第 3 条"`text` 是纯文本"因此精确化为：**抽取器产出的 `text` 是纯文本；落库前管道层会再折一次兼容表意字**。）

### 15.4 注册与分派

```ts
/** 按 mime → 扩展名的顺序挑第一个认领的抽取器；都不认则 null（调度器记 unsupported）。 */
export function pickExtractor(
  mime: string, filename: string, registry: readonly Extractor[],
): Extractor | null;
```

- **同名冲突先到先得**，由注册表顺序决定；注册表在代码里显式列出，**不用自动扫描**（可审计）。
- 一个格式**允许多个抽取器**（例：PDF 有 `pdf.text@1` 与 `pdf.ocr@1`，前者失败/`empty` 时调度器再试后者）。
  调度策略（试谁、按什么顺序、失败几次换人）**不在契约内**，属 P1 实现细节。

### 15.5 与 DB 的映射（与 §6.1 对齐）

| 契约字段 | `attachment_text` 列 |
|---|---|
| `Extractor.id` | `extractor` |
| 段序号 | `seq`（从 0 起） |
| `ExtractedSegment.kind` | `kind` |
| `ExtractedSegment.text` | `text` |
| `ExtractedSegment.loc` | `loc` |
| `ExtractInput.hash` | `src_hash` |

**失效规则**：`(att_id)` 当前 `src_hash` 与库中不一致 ⇒ 删掉该 `att_id` 的全部行重抽（按 `att_id` 整体替换，不做逐段 diff——段序在实现变更后不稳定，逐段 diff 会留下残段）。

### 15.6 测试要求（分家的验收底线）

> ✅ **已于 2026-09-17 落地**：`src/lib/extract/fixtures.ts`（夹具集 = 期望的**单一事实源**）
> ＋ `src/lib/extract/conformance.test.ts`（跑器）。**Mac 的 PDF 实现与 AMD 的多模态实现请直接用这一套**，
> 不要再各写各的期望——那正是 §12.3 分家的头号风险（三套各自能跑、但结果不一致）。

- **三份实现共用同一组夹具**（§12.5）。**实现方式与原先设想的一处偏离**：夹具不是
  `fixtures/<format>/<sample>.<ext>` 那样的二进制样张，而是**在 TS 里现造**（`make: () => Uint8Array`）。
  理由：仓库里不留二进制、评审者能直接读到"输入到底是什么"；真样张（WPS/Office 导出的复杂文档）
  仍应作为**集成夹具**补，那属 P1 后续。
- **断言口径（刻意，别改）**：断言 `kind` 序列 + 关键子串 + `loc` 序列，
  **不断言逐字符文本**——逐字符会让"多一个空格"这种无关差异变红，最后大家学会"红了就改夹具"，夹具就废了。
- **跑器自带 5 条「防漂移」护栏**（这才是这个文件的主要价值）：
  ① 夹具 id 唯一；② 目标抽取器**要么已注册、要么显式标 `planned`**（不许有漏标记的孤儿夹具）；
  ③ **已注册的抽取器不许还标 `planned`**（否则它永远不跑）；④ 每个已注册抽取器**至少有一条夹具**；
  ⑤ **路由**：每个已实现夹具的 `(mime, filename)` 必须被 `pickExtractor` 路由到它声明的抽取器。
  > 这 5 条不是形式主义：③ 在落地当天就抓到了作者自己的一处不一致（`image/有字` 标了 `planned`，
  > 而 `image.ocr@1` 其实已注册）——**真实漂移就是这样产生的**。
- **`deps` 默认不给**：夹具不写 `deps` 时，`cost:"gpu"` 的抽取器会走 `provider_error`，
  于是"默认不出网"这条底线在夹具层面也被钉住；要覆盖 gpu 成功路径就显式给 `deps.vision`。
- **每个抽取器至少 4 条单测**：正常样本 / 空文件 / 损坏文件（期望 `corrupt`）/ 加密文件（期望 `encrypted`）。
- **确定性测**：同一夹具连续抽两次，结果必须深度相等（守 §15.3-5）。
- **`unsupported` 测**：喂一个不属于它的格式，必须返回 `unsupported` 而不是抛。
- **`provider_error` 测**（`gpu` 类）：不注入 `deps.vision` ⇒ 必须 `provider_error`。

### 15.7 本契约的变更流程

1. 先改**本节**（契约）→ 2. 再改**实现** → 3. 若改的是 `id` 的版本号，同时更新 §6.1 的重跑口径与 §13 待拍板里相关项。
**禁止**先改实现再回头补契约。

### 15.8 平台能力注入（`deps`）：**`vision` / `rasterize`**（2026-09-17 增补）

起因：Mac 侧要做 `pdf.ocr`，先做了五分钟可行性核对就发现**路是堵的** —— 扫描件要"页 → 像素"，
而契约不给它要像素的路（抽取器只有 `bytes`；平台原有的渲染入口要的是 **attachmentId**）。
**这类事早说比写完再返工便宜**，他们没直接开写，做法是对的。

**裁定（Windows 侧为契约所有者）**：

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 加不加 `deps.rasterize` | **加**。AMD 查到桌面 `pdfium_native::render_page(cache_key, bytes, page_index, scale)` **本来就是 bytes 进、RGBA 出** ⇒ 桌面侧**入口**是薄适配 |
| 1b | **返回值形状**（Mac 开工时撞出来的缺口，已修订） | **产出编码图**：`RasterizedPage = { bytes, mime, width, height }`（`mime` 用 `image/png`）。原先定的是 `{rgba,width,height}`，但那样**两侧都缺一步** —— `deps.vision` 只接受编码图（`src/lib/ai/ocrVision.ts` 要的是 `data:image/…;base64,…`），而"RGBA → 编码图"在抽取层做不了（要 canvas/编解码库，正是隔离断言禁的那类）。**选它而不是"保留裸 RGBA + 再加一个 encode 能力"**：① 少一个能力就少一处三轴漂移；② **裸 RGBA 要求三台机器对字节序 / 行 stride / 是否预乘 alpha 达成一致** —— 这是一类**不会报错、只会悄悄画错**的约定，且没有一处能把它测出来；PNG 没有这些自由度（要么解出对的图、要么解不开）；③ 生产里没有 `deps.rasterize` 的裸像素消费者（阅读器吃的是平台**驱动**的 `renderPdfPage`，**那条接口没改**）。实现：`src/lib/pngEncode.ts`（纯 JS：fflate `zlibSync` + 自带 CRC32），**Web 与桌面共用一份编码器**，不会出现"两套编码质量" |
| 2 | **谁注入** | ⚠️ **不是 `pipeline.ts`**（与 Mac、AMD **两人**的建议都不同，理由见下）。**由平台层构造**：平台层提供唯一的 `attachmentDeps(attId)` + 唯一入口 `extractAttachment(...)`；`pipeline.ts` 继续只**接收并透传** `deps` |
| 3 | Web 那道桩要不要补 | ✅ **已由 Mac 侧补完并实测**（`dev=7a6df321`）：`web.ts` 的 `renderPdfPage` 从"抛异常"改成 pdf.js + canvas 真实现，**用真 Chromium 验过**（`bytes=540000 = 宽×高×4`、非空白像素 **132340** ⇒ 真的画出来了）。**我原先的"本轮不补"被事实推翻**——我当时的理由是"本机无法验证 canvas"，**错在假定了没人能验**：Mac 有真浏览器。⇒ 撤回该条 |

**第 2 条为什么驳回"pipeline 注入"**（Mac 与 AMD 都主张它，所以这条要写清理由）：

他们的诉求**成立**：唯一注入点才守得住"未注入 ⇒ `provider_error`"这条不变量，
各调用点自己拼 deps 会导致"同一抽取器在不同路径下行为不同"。**这一点我认。**

但**落点不对**，理由与 Mac 反对"抽取器自带 pdf.js + canvas"是**同一个**：
一个把 DOM/canvas 拖进抽取层，一个把平台驱动（Tauri IPC / Web 驱动）拖进来，**代价相同**。

> ⚠️ **我核实过一条、并且它不成立，所以不拿它当理由**：`platform/index → web → sqliteStore → extract/store`
> 这条链确实存在，而 `extract/store` **并不反向 import pipeline** ⇒ **不构成运行时环**。
> 我不把"会成环"写成理由——那样是拿一个没验证的断言去压两个审阅人。

**真正的代价是"层间变双向依赖"**：`platform → extract` **已经存在**
（`sqliteStore.ts:12-13` import `extract/schema` 与 `extract/store`），
再加一条 `extract → platform` 就把它变成双向，后果是**抽取层从此拿不出去**——
CLI、服务端索引、Headless 复用这些路直接堵死，而抽取层的单测也会被迫加载平台驱动。
抽取层至今能在 Windows 上以 vitest 秒级跑 125 条纯函数测试，**靠的正是它不依赖平台**。

⇒ **唯一性由平台层保证，不由抽取层承担**：`attachmentDeps(attId)` 是唯一构造点、
`extractAttachment(...)` 是唯一入口。**这是平台层的实现义务，写进契约。**
**什么会让我改口**：谁能给出一条"应用侧无法经由平台 wrapper 构造 deps"的真实调用路径，我立刻采纳 pipeline 注入。

> ✅ **该义务已兑现**（`src/lib/platform/extractDeps.ts`）：
> - `attachmentDeps(attId, {vision?})` —— 把 `rasterize` 接到平台驱动
>   `pdfRender.renderPdfPage(attId, pageIndex, scale)` 上（**字段名映射 `bytes` → `rgba`**；
>   缩放比例**原样透传抽取器给的值**，平台不另立一套口径；**刻意忽略 `bytes` 参数**——
>   闭包里就有 attId，这与契约注释里"允许忽略 bytes"一致）；
> - `extractAttachment(attId, stores, opts)` —— 走平台命令面两步（`get_attachment` → `read_attachment_bytes`）
>   取到 meta 与字节，再调 `extractAndStore`，然后**顺手分块**（见下）。**`filename`/`mime`/`hash` 全部取自 meta，不自编**，
>   于是"内容变了要重抽"这条缓存口径**自然接上**（有判据）。
> - ⚠️ **签名在 P2 落地时改过一次**（`store` → `stores: {text, chunks}`）：本函数现在是
>   "抽取 → 落文本 → 分块"的**唯一入口**。**为什么把分块也放这里**：分块的输入是**已落库的段**
>   （要经过 §15.9 的归一化才是检索侧那一份），若让调用方各自记得在抽取后调一次分块，
>   迟早出现"文本更新了、块没更新"的漂移 —— 而那种漂移**检索侧看不出来**（搜到的是旧块，还以为是最新的）。
>   分块时机：`stored` 时切；`cached` 且**块为空**时补切一次（给"分块能力上线前就已抽好的附件"），
>   `cached` 且已有块时**不重切**（三条都有判据）。抽取失败时**不动已有块**（与"失败不毁旧数据"同一口径）。
> - **`vision` 是一个明确的洞，不是遗漏**：`Platform` 目前只有
>   `executor/dialog/opener/event/asset/webview/pdfRender/community`，**没有模型驱动这一层**，
>   而"图片/音视频走远程 API 还是本机推理"正是 **§13 待拍板第 7 项** ⇒
>   `attachmentDeps` 不带 `vision` 时**根本不设这个键**（不是设成 undefined），
>   让 `cost:"gpu"` 的抽取器按契约走 `provider_error`，**不在这里编一个假实现充数**。
> - `extractAttachment` 的 `stores` 由**调用方传入**：平台门面没有暴露 `SqliteStore`，
>   为了一个函数去扩 `Platform` 接口要同时改 web/tauri/mobile 三个实现 —— **显式依赖比扩大接口便宜**。

**两条配套（都已落地）**：
- **源码级断言** `src/lib/extract/isolated.test.ts`：生产代码**禁止** import `src/lib/platform/**`、
  `@tauri-apps/**`、`tesseract.js`、`canvas` 系。**并有"扫描器本身有效"的自证**（用合成代码验证命中）。这条断言存在，是"驳回 pipeline 注入"这个理由**可执行的形式**——否则下一个人顺手 import 一下就悄悄破了。
  > 写这条时我自己判错过一次：第一版把 **`pdfjs-dist` 也列为禁止**，跑起来发现 **Mac 的 `pdf.text@1` 正用它做文本抽取**
  > —— 它能在 Node 跑，**是可移植的库、不是平台依赖**；我真正要禁的是"**渲染**"，而渲染已由 `deps.rasterize` 收口。
  > ⇒ **改测试不改他们的实现**，并**把"允许 pdfjs"也钉成一条反例断言**，免得后人又把它加回禁止清单。
- **共享假 deps** `src/lib/extract/testing/fakeDeps.ts`（AMD 提议、三轴共用）：
  `fakeVision` / `fakeRasterize`（**确定性**；R 通道编码页号便于反查渲染了哪一页；`rejectOn` 可模拟渲染失败）
  / `depsOf`（**不传未注入项**，保住"未注入 ⇒ `provider_error`"的语义）。
  各写各的假实现会长成三种口径，而这层分歧**没有任何编译期信号**。

**`av.transcript` 将来也要走同一条路**（音频解码 → 又一个 `deps` 能力）。所以规则是通用的：
**凡是"只有平台能做"的事，都加 `deps`；一律可选、一律没注入就 `provider_error`、一律不许抽取器自己想办法。**

**能力登记表（一处定义，防漂移）**：`src/lib/extract/depsCatalog.ts`。
「哪些能力存在、叫什么、缺了报什么、谁注入」原先散在**契约注释 + `types.ts` + `isolated.test.ts`** 三处，
而"同一个口径写两遍必然漂移"今天已经反复验证过（logo 的 `?v=9→11`、备份路径文档 vs `ExecStart`、
`cargo test --lib` 用错两次）⇒ 收成一处。

⚠️ **它不是"约定"，是编译期强制的**：`depsCatalog.ts` 末尾的 `_DEP_EXHAUSTIVE` 保证
**往 `ExtractDeps` 加能力而忘了登记 ⇒ `tsc` 直接报错**（两个方向都拦）。
**这条已做变异验证**：临时加一个没登记的 `audioDecode`，`tsc` 报
`Property 'audioDecode' is missing in type '{}' but required in type 'Record<"audioDecode", never>'`，撤销后回到 0 错。

### 15.9 归一化口径（**窄口径**，2026-09-17 定）

**问题**（Mac 侧在真 PDF 上实测）：用 Chrome 打印中文 HTML 成 PDF，抽出来的字里 `第⼀段` 用的是
**U+2F00「康熙部首 ⼀」**而不是 **U+4E00「一」** ⇒ `"第⼀段".includes("第一段") === false`
⇒ **用户搜「第一段」搜不到**。这类兼容形不是 PDF 独有（PDF 的 ToUnicode 表、Office 的兼容表、
VLM 输出都可能带）⇒ 修法必须统一，否则三份抽取器各写各的。

**裁定：只在管道层折叠一次，且只折「兼容表意字」。**

| 决定 | 内容 |
|---|---|
| **落点** | **管道层**（`pipeline.ts` 落库前一次；`normalize.ts`）。**不塞进三个抽取器** —— 一处归一化才有"下游不可能忘"的性质 |
| **口径** | **窄口径**：只折 `U+2E80–U+2EFF` / `U+2F00–U+2FDF`（康熙部首）/ `U+F900–U+FAFF` / `U+2F800–U+2FA1F` |
| **查询侧** | 必须与存储侧**同一口径**（`normalizeForMatch`）—— 否则"索引归一了、查询没归一"照样搜不到 |
| **夹具** | 同一词用两种等价形各写一次，断言归一化后互相能搜到（跨轴共用） |

**为什么是窄口径、而不是直接 `normalize("NFKC")`**（我第一版就是全量 NFKC，**跑测试才发现附带影响比预想大**）：

```text
NFKC("，") === ","     ← U+FF0C 全角逗号被转成 ASCII 逗号
NFKC("。") === "。"     ← U+3002 句号不变（它不是兼容字符）
⇒ "第一段，第二段。" → "第一段,第二段。"   ← 同一句里标点风格混杂
```

对中文文档，这比"`①` → `1`"显眼得多，是**可见的质量退化**而非净收益。
⇒ **刻意不折**全角标点 / 全角字母数字 / 带圈数字（`１２３`/`①`/`㈱`/`ﬁ` 全部原样保留）。

**但这不是"永不"，而是"证据不足"** —— 写成**触发条件**（Mac 侧建议，我采纳）：

> **拿到一份真文档里确实出现全角字母数字/带圈数字，就重新评这一条。**

理由是 Mac 侧那份真样张的实测：**全角数字 0 / 全角字母 0 / 康熙部首 0**（本机唯一一份真用户 PDF），
**没有证据支持加宽折叠集**。

> ⚠️ **一条值得记的方法论教训（Mac 侧自己交代的）**：他们先前报的"兼容表意补充区 60 个"
> 是**测量脚本自己的 bug** —— `[\u2F800-\u2FA1F]` **漏了花括号**，被解析成
> `\u2F80` + `0` + 到 `\u2FA1` 的巨大区间，把 ASCII 字母数字全框进去了；改成 `\u{2F800}` 重测 = **0**。
> **测量脚本的 bug 会伪装成"数据支持你的结论"** —— 所以上面每个数字都分开写，而不是只给一个结论。

**若真要折，落点不是改可见派生文本**（Mac 侧建议，我同意）：应是**"匹配用的那一份口径"** ——
存储文本保持原样，**查询侧与匹配键同折**。这样两个方向（文档全角/查询半角、文档半角/查询全角）
都能命中，又不承担"改可见文本"的代价。⇒ 与 §15.9 的查询侧归一化（`normalizeForMatch`）合并考虑，
**现在不动实现**。

**为什么敢改派生文本**：因为它**本来就是可重建的缓存、不是事实源**（§6.1：只读、可重建、
不进同步/备份/导出，**以原件为准**）。原件字节始终在附件里，改的是我们自己的派生副本。
（这也正是 §6.1 那句"以原件为准"必须存在的原因。）

### 15.10 覆盖度：**"成功"不等于"抽全了"**（2026-09-17 增补）

**问题**（Mac 侧在混合文档上实测，**静默丢内容**）：正文是文字、中间夹了几页扫描的 PDF，
会让 `pdf.text@1` 返回 **`ok`** —— 它只是**跳过**空页、**不报告**有空页
⇒ 调度器以为"这个抽取器成功了"，于是 `pdf.ocr@1` **永远不会被调度**，
那几页**静默地没有任何内容**：不报错、不红，只是少了一块，而且**没有任何地方能看出来**。

真样张佐证：本机唯一一份真用户 PDF **17 页只抽出 105 个字符**（有文本层，但极少）
⇒ "文字页夹扫描页"在企业/教材文档里**不是边角情形**。

**裁定**：给成功结果加一个**可选**的覆盖度字段（可选 ⇒ 现有抽取器一行不用改）：

```ts
export interface ExtractCoverage {
  complete: boolean;               // false = 派生文本只是原件的一部分
  gapIndexes?: readonly number[];  // 明确没产出内容的单元序号（0 基；页式格式=页号）
  note?: string;                   // 人可读，例：'只覆盖 p.1–p.50（源 2000 页，超单次上限）'
}
// ExtractResult 的成功分支加 `coverage?: ExtractCoverage`（省略 = 完整覆盖）
```

**调度规则（`pipeline.ts`）**：**不完整 ⇒ 继续试下一个候选；谁更完整用谁；并列时留先到的**
（"顺序即优先级"不变）。落地方式是**整体替换**而不是"合并两份结果" ——
合并要定义"谁赢"，而替换的语义现成且无歧义（Mac 把合并列为最贵的那条，我同意）。
**只有不完整的结果可用时也要落库**（少而**标注清楚** > 整体失败什么都没留下）。

**它顺带解决的第二个问题**：**截断原本无处可写**。现在超过页数上限只能"静默截断"或"整体失败"；
有了覆盖度就能表达"这份派生文本只覆盖了 p.1–p.50"，而不是让下游以为抽全了。

> ⚠️ 这条与 §15.3 的九条不变量并列：**"`ok` 只表示这次抽取没出错，不表示覆盖完整"**。
> 任何会跳过内容的抽取器（跳页、截断、超上限）都必须如实带 `coverage`。
