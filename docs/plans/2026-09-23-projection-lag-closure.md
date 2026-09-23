# 投影与派生滞后：方案稿（2026-09-23，**只出稿、未实现**）

> 起因：冲刺 §13.3 第 1 条 —— 「打开页面时合并/承接**只写状态**，`pages` 那两列要等**下一次保存**
> 才跟上 ⇒ 在那之前这一台的 FTS/反链看不到刚并进来的字」。
>
> 上位：[CRDT 全上线冲刺](2026-09-23-crdt-full-launch-sprint.md) §13.3；
> 相邻口径：`mark_text_stale` 那三条纪律（[块 rev 写层](2026-09-22-block-rev-write-layer.md) §225）、
> [S5 决策稿](2026-09-23-s5-server-merge-decision.md) 的体积读数。

## 1. 事实清单（都可在仓里复核，2026-09-23）

| 事实 | 出处 |
|---|---|
| **桌面**"打开页面"走端口版绑定：读状态 → 收下的待并状态合并/承接 → `port.save(pageId, exportState())` | `src/lib/crdt/pageBinding.ts` ~L276-334 |
| 端口那条 `save` 在桌面＝`save_page_state`，**只写 `page_crdt` 一张表**（不写 `pages.content_json`、不打 `text_stale`、不重建块图） | `commands.rs::save_page_state` ~L396-400 → `page_crdt::write_page_crdt_state` |
| 对照：**web 当场合并**那条路（`mergeRemotePageState`）**会**写投影列 ＋ 打 `text_stale` | `src/lib/crdt/pageBinding.ts` ~L183-185 / L215-216 |
| 对照：裁决与保存路径都会 `derive`（FTS ＋ **块图/反链**） | `commands.rs::save_page` ~L450 → `doc_content::derive` ~L237-240；`resolve_page_conflict` ~L866-868 |
| **两平面的反链实现不同**：桌面是**物化表**（`rebuild_block_graph`）；web 是**按需扫描 `content_json`/`content_text`** | `src-tauri/src/blocks.rs::rebuild_block_graph` ~L183；`web.ts` 的 `get_backlinks` ~L2078 / `list_block_backlinks` ~L2105（注释：直接扫列） |
| 正文那半已有收口机制：「待重建」标记 ＋ 补算器（编辑器按语义算一遍 → `refresh_page_text_if_stale` 写回 ＋ 刷 FTS） | `doc_content.rs` ~L105-121 ＋ `Editor.tsx::PageTextRepairPlugin`（~L600 起） |
| 补算器**不重建块图**（只 `write_text` ＋ `derive_fts`） | `doc_content.rs::refresh_page_text_if_stale` ~L105-121 |
| 投影写回有一条**现成的口径**（只动那一列：不改别的列、**不动 `dirty`**、不盖章、不快照） | `src/lib/docContent.ts::writeContentProjection` ~L812-824 |
| 数据库页有一个**实测撞过的坑**：投影/正文写回会**抹掉行文本** ⇒ `mark_text_stale` 明确排除 `kind='database'` | `doc_content.rs::mark_text_stale` ~L147-165（理由写在注释里） |

⇒ 一句话：**这不是"没实现"，而是"桌面这条路少走了 web 那一步"**，而且因为两平面反链的实现方式不同，
"只把投影列补上"在桌面上**还不够**（web 是按需扫列、桌面是物化表）。

## 2. 三条路（选一条）

### A. 合并之后由 UI 触发一次「保存」

- ✅ 一次到位：`content_json` ＋ 正文 ＋ FTS ＋ **块图** ＋ rev 全部跟上（走的是现成的保存路径）。
- ❌ **假账**：保存路径会 `dirty = 1`、盖 rev、进版本历史 ⇒ 把"**刚收下的对端内容**"当成本机改动**推回服务端**；
  与"采用远端 ≠ 本机编辑"（`takeRemoteWholePage` 不标脏）直接冲突。
- ❌ 依赖 hydration 完成时序（编辑器还没载完就触发保存 ⇒ 存的是旧 JSON）。
- **结论：❌ 不选。**

### B. 新增一条「写投影」的平台命令，由端口在合并那一刻调它（**推荐**）

草案：`write_page_projection({ page_id, content_json })`
- **桌面**：`UPDATE pages SET content_json = ?` ＋ `mark_text_stale`（排除数据库页）＋ **`rebuild_block_graph`**；
- **web**：走它已有的 `writeContentProjection` ＋ `markTextStale`（反链按需扫描，不需要重建）。

调用点：`bindPageToEditorViaPort` 里"合并过（`merged`）或承接了（`adopted`）"**且内容真的变了**那一刻
（"变了没"的判据**复用** `projectStateToJson(mine) !== projectStateToJson(merged)` —— 与 `mergeRemotePageState`
逐字同一纪律：**没变就一次写库都不做**）。

- ✅ 只动投影与派生，**不动 `dirty`**、不盖章、不进版本历史（与 `writeContentProjection` 的既有口径逐字一致）。
- ✅ 让桌面的"打开页面"这条路**与 web 当场合并那条路同义**（web 反链按需、桌面物化 ⇒ 桌面多一步块图重建）。
- ✅ 两平面同名同义 ⇒ 共享代码里**不需要**平台分支（与 `read_page_state` / `save_page_state` 同一形态）。
- ❌ 新命令（契约 + Rust + web + `api` + 端口）＋ 一条新判据族。

**两条子路**（实现时可分批）：
- **B1**：只写 `content_json` ＋ 打 `text_stale`（最小、与 web 当场路径逐字同义）；
- **B2**：B1 ＋ **重建块图/反链**（桌面才需要的那一步）。⇒ **建议直接做 B2**：只做 B1 会留下
  "**桌面独有**的反链滞后"（web 按需扫列，天然没有这个问题）。

### C. 把投影写回下沉进桌面 `save_page_state`（Rust 自己算）

- ❌ **Rust 没有 Yjs** ⇒ 它算不出"状态 ⇒ JSON 投影"；唯一的办法是让 TS 把 JSON 传进来 —— 那就**等于 B**。
- **结论：❌ 不选（它是 B 的一种伪装）。**

### D. 什么都不做，只把"投影滞后"钉进已知边界

- ❌ 用户可见的后果是"刚同步过来的字搜不到 / 反链里看不到"（且容易报成"同步坏了"）。
  这条**今天确实存在**，但它是"少走一步"，不是"设计取舍"。
- **结论：❌ 不选（作为 B 落地前的**过渡**可以接受，但要把边界写进文档）。**

## 3. 承重判据（草案）

| # | 判据 | 手段 |
|---|---|---|
| 1 | **当场跟上**：桌面打开一页、有待并状态、合并**改变了内容** ⇒ `pages.content_json` **立刻**等于合并状态的投影（不必等下一次保存） | 端到端（临时库 ＋ 真编辑器）：`read_content` 断言 |
| 2 | **反链当场跟上**（B2）：合并后新并进来的块引用**立刻**能查到（`list_block_backlinks`）| 端到端（照 §11.4 那批判据的形态） |
| 3 | **正文那半有痕**：同一场景 ⇒ `text_stale = 1`；补算器跑完 ⇒ FTS **能搜到**新并进来的字 | 端到端（补算器那两条出口都要断电：真的修了 / 算出来相同也清标记） |
| 4 | **没变就不写**（假账纪律）：合并产物与库里那份**相同** ⇒ 投影列与块图**一次写库都不做** | 单测（同一份状态合两次，第二次零写库） |
| 5 | **不碰 `dirty`/版本历史/rev**：投影写回后 `dirty` 不变、`page_versions` 不增条目 | 端到端断言三样 |
| 6 | **数据库页排除**：`kind='database'` 的页**不写投影**（写回会抹掉行文本 —— `mark_text_stale` 那条实测坑） | 单测（照 `mark_text_stale` 的判据形态） |
| 7 | **两平面一致**：web 侧同一读数（或：明确 web 走它自己那条当场路径，命令同义） | `check-web-commands` ＋ 两侧单测 |
| 8 | **零回归**：本机有状态但**没有**待并状态（今天最常见）⇒ 行为与改动前**逐字相同**（零写库、零额外查询） | 单测（同一批断言在改动前后一致） |

## 4. 风险与边界（写清，别到时候当 bug 查）

1. **时序**：写回发生在"打开页面、hydration 之后"；若用户此刻已经输入了未保存的内容，投影写回会把库里
   那一列改成"状态那一版"（可能与编辑器里那版不同）。缓解：只在**合并确实改变内容**时写，且**下一次保存会覆盖**；
   本稿**不**为此引入"看编辑器状态"的分支（那会把派生耦合到 UI 状态，与 `doc_content.rs` 里那条
   "比较放在这一层而不是调用方"的口径相反）。
2. **块图重建用的正文是库里那一列**（可能仍是旧的）⇒ 与 `resolve_page_conflict` **同一已知边界**
   （那段注释写了"正文这一次不重算"）。所以"`[[标题]]` 这一类**依赖正文**的引用"仍可能滞后到补算器跑完；
   **块级引用**（来自 JSON）当场就对。要把这条写进文档，别让人以为"全同步了"。
3. **成本**：打开页面多一次块图重建（每页 O(块数)），与保存路径同量级；只在**真的合并过**时才跑。
4. **writer 交叉**：投影列今天有两个 writer（合并路径 / 保存路径），补算器写的是正文列 ⇒ 不新增冲突；
   但**块图**将来若也进补算器，要先定"谁后写"（本稿不动补算器）。
5. **不是桌面独有的问题**：web 侧同一场景的**正文/FTS** 也滞后（只有反链因为按需扫描天然不滞后）
   ⇒ 别把这条描述成"桌面才有的 bug"。

## 5. 明确**不做**的

- ❌ 不在同步/打开路径上**现算正文**（S6 口径：派生要编辑器语义 ⇒ 正文归补算器；这一条不许顺手破坏）。
- ❌ 不让 Rust 自己算投影（没有 Yjs）。
- ❌ 不用"触发一次保存"当修法（§2-A 的假账）。
- ❌ 不动 RAG/embedding 那条链的派生（它有自己的入口，不在本片）。

## 6. 动手顺序

1. 平台命令 `write_page_projection`（两侧）＋ `api` 包装 ＋ 契约与 `check-web-commands` 口径；
   Rust 侧实现 = 写列 ＋ `mark_text_stale`（排除数据库页）＋ `rebuild_block_graph`。
2. 端口（`PageStatePort`）加 `writeProjection?`／或在端口版绑定里直接调 `api`；调用点带"内容变了"判据。
3. 判据 **1 / 4 / 5 / 6 / 8**（决定性的那五条）→ 绿；再补 **2 / 3 / 7** 的读数。
4. 文档：冲刺 §13.3 第 1 条收口；`SHUYONOTE_STATE.md` 缺口 ② 里删掉"投影列要等下一次保存"这半句；
   把 §4.2 那条"依赖正文的引用仍可能滞后"如实例外记一笔。
