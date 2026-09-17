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

> ⚠️ **一条集成期的实测成本（2026-09-17 接线时发现，量产前必须处理）**：
> Web 平台的 `SqliteStore.run()` **每写一条就走一次 `db.export()` 全库快照**（`persist()`）。
> 而派生文本的落库是"一次 DELETE + N 次 INSERT"（§15.5 的整体替换），
> ⇒ **一份抽出 500 段的文档 = 501 次全库快照**，全库抽取时是**平方级**开销。
> **必须先把 `replace()` 变成一次提交**（包成一个区间写、或给 store 加"延迟 persist"），再接到"开始索引"的批处理里。
> 现状：`SqliteStore.derivedTextStore()` 的文档注释里已写明"**目前只用于小规模与测试**"。

## 8. 分步落地（每步独立交付价值，顺序不可颠倒）

### P1 —— 附件文本抽取 ＋ 派生表 ＋ 接进现有检索与工具

**交付**：docx / xlsx / pptx / PDF / txt / 图片(OCR) 的文本抽取；`attachment_text` 落库；`pages.search` 与嵌入链同时命中派生文本；新增 `files.read` 工具。

> **进展（2026-09-17）**
> - **接口已冻结**（§15）。
> - **OOXML 一族的抽取器已实现**：`src/lib/extract/ooxml.ts`（docx/xlsx/pptx），`cost: cpu`。
> - **图片 OCR 抽取器已实现**：`src/lib/extract/image.ts`（`image.ocr@1`），`cost: gpu` ——
>   它同时是契约 **§15.3-7**「未注入 `deps.vision` 必须立刻 `provider_error`、不许自建网络」的活样板
>   （该条此前既无实现也无测试，等于空头承诺）。**第二档（VLM 语义描述 → `caption`）按 §13 待拍板第 2 项
>   的默认值留到 P3**，不在 P1。
> - **派生表与落库已实现（TS 侧）**：`src/lib/extract/schema.ts`（DDL 单一事实源）、
>   `store.ts`（读写 + 按 `src_hash` 失效 + 整体替换）、`pipeline.ts`（候选调度与结果归类）。
> - 五个测试文件共 **70 条**用例；**全量回归 79 文件 / 768 用例全绿**，`npx tsc --noEmit` 0 错。
> - **仍未做**：接进 `sqliteStore.ts` / `db.rs` 的真实建表与调用（**Rust 侧需 AMD 或 Mac 复核**）、
>   `files.read` 工具、PDF / 旧格式 / 音视频抽取器（见 §12.4 分工表）。
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
