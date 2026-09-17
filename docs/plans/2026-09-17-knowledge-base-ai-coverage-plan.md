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
-- ② 派生文本：一份附件 × 一种抽取产物
CREATE TABLE IF NOT EXISTS attachment_text (
  att_id     TEXT    NOT NULL,          -- attachments.id
  kind       TEXT    NOT NULL,          -- 'pdf-text'|'pdf-ocr'|'docx'|'xlsx'|'image-ocr'|'image-vlm'|'av-asr'|...
  text       TEXT    NOT NULL DEFAULT '',
  loc_hint   TEXT    NOT NULL DEFAULT '', -- 定位提示（'p.'|'sheet'|'tc'|'…'，具体格式随 kind）
  src_hash   TEXT    NOT NULL,          -- 抽取时附件的哈希（内容寻址哈希，见 attachments.rs:291）
  extractor  TEXT    NOT NULL,          -- 抽取器标识 + 版本；换实现 ⇒ 可按 extractor 整批重跑
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (att_id, kind)
);

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

## 8. 分步落地（每步独立交付价值，顺序不可颠倒）

### P1 —— 附件文本抽取 ＋ 派生表 ＋ 接进现有检索与工具

**交付**：docx / xlsx / pptx / PDF / txt / 图片(OCR) 的文本抽取；`attachment_text` 落库；`pages.search` 与嵌入链同时命中派生文本；新增 `files.read` 工具。

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

> ⚠️ **验收纪律（硬要求）**：**Windows 跑不了 `cargo test`**（`0xc0000139`），所以 Windows 侧的改动必须由 AMD 或 Mac 复核——"在我这边编过了"不等于"测过了"，更不等于"能打开"。

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

> ⚠️ **前置：接口必须先冻结，冻结之后才分。** 要冻的是：抽取器签名 / `kind` 枚举 / `loc_hint` 格式 / 错误语义 / `extractor` 版本号。
> **接口没冻就分三份 = 三套各自能跑、但合不到一起的实现。**

### 12.4 分工表（**待机器规格确认后填空**）

| 模块 | 谁 | 依据 | 依赖 |
|---|---|---|---|
| **接口冻结** | 一台独占 | 并行的前置，**不能省** | 无 —— 立刻能动 |
| **格式抽取器** | 分家（§12.3 轴 1） | 纯函数、零共享 | 接口冻结 |
| **平台同构**（Rust 侧 / `web.ts` 侧） | 两台各一侧 | `check-web-commands.mjs` 兜底 | 接口冻结 |
| **集成 + 检索链路** | **一台独占串行** | 唯一的串行点（`db.rs` / `search.rs` / `web.ts` / `capabilities.json` 全在此） | 抽取器就绪 |
| **Rust 侧测试复核** | **AMD 或 Mac（硬需求）** | 见 §12.1 | 随时 |
| **全库抽取实跑** | **⚠️ 待 GPU 规格确认** | VLM 抽图 + ASR 抽音轨是**算力活**；Windows 本机仅 6GB 显存，是全链最弱一环 | 接口冻结 |

> **P2（分块 + 块级嵌入）不分家**：它是耦合最紧的地基（同时改 `db.rs` / `search.rs` / `semanticEmbed.ts` / `web.ts`），**等 P1 合并落地后再议**。
> **不要为并行而并行**：仓库里 sm-crypto 那次敢分，是因为模块边界清楚（`crypto.rs`/`security.rs` vs `pdf_native.rs`，文件零重叠）；本方案的耦合面大得多，硬分就是三台机器轮流解冲突。

### 12.5 协作纪律（三条，必须一并生效）

- ❌ **禁止 `git add -A`** —— 本仓库有并发会话，**曾误提交他人 WIP**；✅ 只 `git add <自己的文件>`，提交前对 `git status --porcelain`。（出处：sm-crypto-full-plan §9.1 末）
- ✅ **"编过了"不等于"测过了"**：Rust 侧改动必须由**能跑 `cargo test`** 的机器复核（§12.1）。
- ✅ **同一组夹具跑三份实现**：格式抽取器分家后，三份实现共用一组夹具（同一批样张 → 期望文本），否则会退化成"三套都能跑但结果不一致"。

## 13. 待拍板

1. **P1 的格式优先级**：先做 OOXML（docx/xlsx/pptx，纯 Rust/TS 解析）还是先接 LibreOffice headless（一次覆盖旧格式但引入外部依赖）？
2. **图片的第二档（VLM 描述）要不要进 P1**，还是只做 OCR、描述留到 P3？
3. **派生文本是否允许用户查看/编辑**（排查抽取质量时有用，但会变成"第二份真相"）。
4. **视频/音频是否本机跑**（whisper.cpp 类）还是明确"暂不支持"。
5. **分块参数**（大小/重叠）是否要按语言区分（中英混排）。
6. **三台机器的 GPU / 显存规格** —— 决定"全库抽取"这项**算力劳动**放哪台机器跑（见 §12.4）。这是部署决策，不是分工偏好。

## 14. 结论

用户要的「全部纳入」**不是换一个更大的模型能解决的**——瓶颈在检索面而不是模型能力。正解是**把多模态内容降维成文本、汇进统一的可检索层**：

- **P1 补上缺失的一半**（附件/图片的文本），**不改 AI 工具集形态**，投入产出比最高；
- **P2 的分块是地基**（当前的"每页只索引前 500 字"等于只索引封面）；
- **P3/P4 是长尾与可信度**。

按本方案分步走，**7B 级本地模型也能拿到可用的全库问答**，因为每一步的输入都变短了。反过来，**跳过 P1/P2 直接做跨库总结，只会产出没有依据的漂亮话**。
