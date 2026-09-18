# 阶段 0 · **接口收口**：现状盘点与那一层的边界（2026-09-18）

> 状态：**施工准备**（不含代码改动）。上位：[全量 CRDT 冲刺计划](2026-09-18-crdt-full-migration-plan.md) §3 阶段 0 第 2 条。
> 目标：把「**文档内容的读取 / 写入 / 合并 / 派生**」收成**一层**，让未来换 CRDT（或做块级 LWW）**只改一层**，
> 而不是全仓改。冲刺计划里这条被标为「**不做它，C 会变成无法收尾的重构**」。

---

## 1. 盘点（2026-09-18 实测，按命中数）

**口径**（= 门禁 `scripts/check-doc-content-access.mjs` 的口径，**唯一权威**）：扫
`src/**/*.{ts,tsx}` 与 `src-tauri/src/**/*.rs`，数子串 `content_json` / `content_text` / `contentJson` 的出现次数。

**合计：前端 538 处 / Rust 208 处 = 746 处，分布在 80 个文件（前端 64 / Rust 16）。**

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
> `scripts/doc-content-access-baseline.json`（**80 文件 / 746 处**），已登记进 `scripts/lib/gates.mjs`（contract 组）。
> 三条规则：出现**新文件**直接引用 ⇒ 红；某文件计数**超过**基线 ⇒ 红；计数**低于**基线 ⇒ 提示下调基线
> （`--update`，**只允许变小**；首次创建基线豁免——门禁第一次跑时正是它自己把"创建基线即上涨"抓出来的）。
> 豁免名单（本该直接访问的那一层）在脚本的 `LAYER_FILES`：`src/lib/docContent.ts`、`src-tauri/src/doc_content.rs`。

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

**白名单**：746 → **728 处**（已 `--update` 下调，**只减不增**这条机器上是硬的）。

**⏳ 还没做**（别当成收口已完成）：

- **前端一侧的壳未开始**（`src/lib/docContent.ts`）；
- **远端写路径**：`sync::apply_upsert` 的 `INSERT … ON CONFLICT` 与 `fetch_page` 的整行 SELECT 仍在原处
  （前者要 `PageDetail` 的 11 个字段、后者属"页面元数据"，各值得单独一次提交）；
- **SQL 层内联子查询**（`list_block_backlinks` 的 `(SELECT content_json …)`）加一层函数收不了。

**🐛 门禁自身修了一处**（这一条是壳落地时**门禁自己抓出来的**）：豁免层原先只在**校验**分支生效，
`--update` 不认它 ⇒ 壳一落地就再也下调不了基线（`doc_content.rs` 被判成"0 → 9 的新增文件直接引用"）。
现在 `counts`（原始读数，含豁免层）与 `regulated`（受约束/入库，摘掉豁免层）分开。
