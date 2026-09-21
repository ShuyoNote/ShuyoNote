# 块版本（`blockRev`）这一层：**rev 从哪来、什么时候涨**（2026-09-22）

> 上位：`docs/plans/2026-09-19-stage1-block-lww-readiness.md` §6（裁定）/§7（实现口径）
> —— 本文件只补"rev 这个量**本身**怎么产生"，**不含判定**（判定在块级合并那一层：
> `doc_content::merge_blocks` ↔ `docContent.mergeBlocks`）。
> ⚠️ 那份阶段 1 文档**不在本分支上**（它在 `feat/stage1-block-merge` / `feat/doc-content-layer` 线上），
> 所以这里写成普通引用而不是链接 —— 两边合并时它会自然接上。
> 分支：`feat/stage1-block-rev`（基线 `feat/block-id-model` —— "写 rev"要一个能带**声明字段**的块级节点模型）。
> ⚠️ **第三段已把两条 stage-1 线并成 `feat/stage1-block-lww`**（本文件 ＋ 块级合并那一份判定）并**接线**，
> 见 §4；本文件其余部分保留当时的落地记录。

---

## 1. 这一层做三件事（纯函数，JSON → JSON）

| 函数 | 作用 |
|---|---|
| `read_top_level_block_revs` ↔ `readTopLevelBlockRevs` | 读顶层块的 `(blockId, rev)` |
| `max_block_rev` ↔ `maxBlockRev` | 这一页**见过的**最大 rev（裁定 §7 的 `max(整页见过的 rev)`） |
| **`assign_block_revs` ↔ `assignBlockRevs`** | ★ **rev 的写入口**：拿"上一版"（baseline）与"这一版"比一遍，给每个有身份的顶层块写上 rev |

| 侧 | 文件 | 判据 |
|---|---|---|
| Rust | `src-tauri/src/block_rev.rs` | **14 条** |
| TS | `src/lib/blockRev.ts` ＋ `src/lib/blockRev.test.ts` | **15 条**（多一条"与两形态转换配合"） |

读数（2026-09-22，本机 Windows）：`vitest run src/lib/blockRev.test.ts` **15/15**；
`cargo test --lib block_rev` **14/14**（Windows 按 `win-cargo-test.ps1` 同样的四步手跑，见前一封信）；
节点级 `src/editor/nodes/blockRevDeclared.test.ts`（§5）**5/5**。

**逐块判定**（`baseline` = 这一页上一次保存/加载的那份 JSON）：

| 情形 | 写什么 |
|---|---|
| 有身份、且与 baseline 里同 id 的块**内容相同** | baseline 已有的 rev；baseline 里**没见过** rev（老块）⇒ `0` |
| 有身份、但内容变了 / baseline 里没有这个 id（新块） | `maxSeen + 1` |
| **没有身份**（`blockId` 空/缺失） | **不写**（不猜、不造身份） |
| baseline 有、这一版没有的块 | 它就不在产物里（**本层不写墓碑**） |

## 2. ★ 两条"**不是内容**"（判错就是静默丢更新）

比"这一块变没变"时，`canonicalContent` 会 ①**去掉 `blockRev` 字段**（任意层级）②**把键排序**：

- **不去 rev** ⇒ 还没带声明字段的节点类序列化时把这个字段丢掉 ⇒ 每次保存都被判成"改过了" ⇒ rev 无脑上涨；
- **不管键序** ⇒ 编辑器重排一次键序就被判成"改过" ⇒ **本地那份旧内容会被当成"更新的"赢过远端真实的新编辑**
  —— 这正是本冲刺要消灭的那种静默丢更新。

两条各有一条判据钉住（`rev_field_is_not_content` / `key_order_is_not_content`，两侧同款）。
键序无关**只用于比较**：产物仍是原始键序（落盘形态不变）。

## 3. ★ 一条裁定没写、但**阶段 1 的承诺要求它成立**的口径：未改的块也要有 rev

裁定只说了"编辑一块 ⇒ `rev = max(整页见过的 rev) + 1`"，**没说没改过的块怎么办**。两种做法：

| 做法 | 后果 |
|---|---|
| 未改的块**不写** rev | 两台设备各改**不同块**后：A 的块 X=1、B 的 X 没有 rev ⇒ 合并时 X 落进"缺 rev ⇒ 冲突" ⇒ **每一页都弹提示**（正是阶段 1 要消灭的场景） |
| **未改的块写回已知 rev；从没见过 rev 的老块写 `0`（采用）** | A 的 X=1 vs B 的 X=0 ⇒ 取 A（对）；B 的 Y=1 vs A 的 Y=0 ⇒ 取 B（对）⇒ **两边编辑都保留、且不弹提示** |

⇒ 采用第二种：**有身份 ⇒ 一定有 rev**。于是"缺 `rev`"这一行在合并表里**只剩"老客户端产物"**
这一种真实含义（它保存时会把字段剥掉），与裁定 (iii) 的本意一致。

**代价（如实写）**：老块被盖上 `0` = 声明"它老到不能再老" ⇒ 对方只要**真的**改过那一块，就取对方那一版。
那不是"静默丢更新"（对方确实改过、本地确实没改），但**这条要 owner / 两边点头**（已写进协同信）。

判据 `stage1_promise_holds_at_this_layer` / `★ 阶段 1 的承诺在本层成立` 把整条走一遍：
两台设备各改不同块 ⇒ 两边每个块都有 rev、各改的那块更大（⇒ 判定层不会落进"缺 rev ⇒ 冲突"）。

## 4. 接线：**已落地**（2026-09-22，第三段）

| 位置 | 做了什么 |
|---|---|
| 桌面临 `commands::save_page` | 盖 rev：`doc_content::stamp_block_revs(&c, page_id, 这一版)`（baseline = 库里这一行）—— **先盖章，再落库/进版本历史** |
| Web 端 `platform/web.ts::save_page` | 同一份语义：`assignBlockRevs(cur.json, next.json)`（`cur` 就是同一行的读出口） |
| 桌面远端应用 `sync::apply_upsert` | 页级说"用远端"之后调**唯一入口** `doc_content::apply_remote_page`（逐块合并 + 落库 + 刷 FTS） |
| Web 远端应用 `platform/web.ts::applyChange` | 同一个入口的 TS 版：`docContent.applyRemoteContent` |
| `restore_version`（两侧） | **已接（第四段）**：恢复也是一次**本地编辑** ⇒ 同样盖章（baseline = 当前页内容）。不盖的后果与 `dirty = 1` 那条同族：恢复回来的块带着**旧 rev** ⇒ 下一次合并判错胜负，极端情况下这次恢复被远端**静默盖掉**。判据：Rust `restore_version_stamps_block_revs` ↔ `two-device-sync` **场景 J** |

**逐处决定过、结论是"不需要单独接"的**（写下来，免得下次有人以为漏了）：

| 位置 | 结论与理由 |
|---|---|
| `commands::create_page` / Web `create_page` / 模板中心 | **不盖**。新建**没有 baseline** ⇒ 第一次保存时 baseline 就是它自己的内容 ⇒ 未改的块盖 `0`、改过的 `max+1`；合并语义照样成立（各改不同块仍可合） |
| 插件写页路径 | **已覆盖**：`pages.create` / `blocks.append` 都是 `mediate: "draft"` —— 插件只**产生草稿**，真正落库走前端的保存路径（= 上面已盖章那一处）；`plugins.rs` 里那几处直接 `INSERT INTO pages` 都在 `#[cfg(test)]` 夹具里 |
| 分栏子编辑器 `ColumnEditor` | **已覆盖**：它只把内容回写给**父编辑器**（`onChange`），自己不碰库；落库走父编辑器的保存路径 |
| PDF 批注 / `emailRichNote` / AI 应用块 | **已覆盖**：都是"生成 JSON → 调 `save_page`"，走上面那一处 |

**合并失败/冲突时的行为**：`merge_remote_content` / `mergeRemoteContent` 返回 `None`/`undefined` ⇒
**回落成"远端原样"**，与接线前**逐字相同**（老内容、脏 JSON、有冲突三种情况都走这条）。
⇒ 这一步**不引入任何新的静默行为**：有冲突的页面行为与接线前一致，等提示 UI 那一片再接管。

⚠️ **为什么这两半必须同时上线**（第三段就是按这条做的）：只写 rev 没人读 = 往 JSON 里加一个没人用的
字段（混版本期还会被老客户端剥掉）；只接判定不盖章 = 每一页都因为缺 rev 而回落 ⇒ 判定等于白接。

读数（第三/四段，Windows 本机）：`two-device-sync` **36/36**（场景 H **走真 `applyChange`**：
"两端改不同块 ⇒ 合并后两边的编辑都在、rev 也写回"；场景 I 验**保存路径盖章**；场景 J 验**恢复盖章**）；
Rust `doc_content` **25/25**（含适配器 7 条 ＋ 盖章 2 条）、`versions::` **3/3**、`block_rev` 14/14；
`pnpm verify` **23/23**；`check-doc-content-access` 反而**又降了一档**（`sync.rs` 1 → 0：
远端应用整条收进那一层了）。

## 5. 节点上的**声明字段**（内存 / CRDT 平面那半）：**18 类全部接入**
与"写 rev"分开落地（互不阻塞）：rev 由保存时的**差分**产生，不依赖节点字段；节点字段是为
**阶段 2/3**（Yjs 只同步节点模型）与"不经 baseline 的重序列化路径"准备的保险。

| 进度 | 类 |
|---|---|
| ✅ 内建镜像 7 类 | `BlockParagraphNode` / `BlockHeadingNode` / `BlockQuoteNode` / `BlockListNode` / `BlockCodeNode` / `BlockHorizontalRuleNode` / `BlockTableNode` |
| ✅ 自有节点 11 类 | `callout`（`CalloutNode`）/ `formula` / `mermaid` / `imageRow` / `image` / `video` / `blockembed` / `webbookmark` / `attachment-ref` / `drawing` / `columnsBlock` |

每类都是同一套四处改动：**声明字段** ＋ `clone`/`afterCloneFrom`（两条克隆路径都不许丢）＋
`exportJSON`/`importJSON`（CRDT 绑定就靠这两个）＋ `getBlockRev`/`setBlockRev`。
`blockembed` 那类注意：它的 `__blockId` **已被"引用目标"占用**，身份字段叫 `__selfBlockId` ⇒ rev 是**新加**的
`__blockRev`（不与任何既有字段撞名）。

判据：`src/editor/nodes/blockRevDeclared.test.ts` **5 条**（表格驱动，`MODEL_NODE_TABLE` 里 **18 行**逐类验，
与块身份那边"清单与判据共用一份"同一做法）——
① 有值才写（`null` ⇒ 落盘 JSON 里**不许有**这个字段，缺字段 ≠ 0）；
② 老形态兼容（没有字段 ⇒ 读成"没有"，再写出去仍不写）；③ `exportJSON → importJSON` 往返；
④ 克隆路径（精确 `markDirty()` 被测节点）；⑤ 声明字段进的是节点模型（`toJSON()` 同一条路）。

✓ 与 `src/lib/blockRev.ts` 的 `blockRevOf` **共用一份口径**（`blockIdHelpers` 转出去，不重写第二份）。

**三条踩过的坑**（都写进判据文件头了）：
- 任何节点工厂必须在 `editor.update()` 里调（外面调抛 `Unable to find an active editor`）；
- **别用"空根 + 装饰节点"验块身份**：formula 这类 DecoratorNode 单独 append 进空根会被 Lexical 的
  **根规范化包进一个段落**（`paragraph` 是内建类型、没有块身份）⇒ 读 `root.children[0]` 会读到包装段落，
  看上去像"rev 没写出去"。判据改成**递归找目标 type**，并先放一个内建段落打底（第 ①/② 条干脆不挂根、
  直接读 `exportJSON()`）。—— 与块身份那边记的"判据别用空根+装饰节点"同一条纪律，这次又踩了一遍；
- 装饰节点被包进段落之后，`markDirty()` 要**精确标到被测那一个节点**（只标根的直接子节点会变成空转）。
