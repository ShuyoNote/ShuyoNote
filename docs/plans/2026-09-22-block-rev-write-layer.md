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

## 6. 冲突**留痕与裁决**（第五段：提示 UI 的**数据层**）

裁定 (iii) 说的是"缺 `rev` / 同 rev 不同内容 ⇒ **不静默选边**"。到第四段为止这条只做到了一半：
合并报出冲突后**回落页级 LWW**（覆盖语义与接线前逐字相同），但**没有留下任何痕迹** ⇒ 对用户仍是静默的。
这一段把"静默"变成"有痕"：

| 件事 | 落点 |
|---|---|
| **新表 `page_conflicts`**（本地、**不同步 / 不进备份导出**） | 桌面 `db.rs::migrate` ＋ Web `sqliteStore.ts`（两边列名逐字一致）：`id / page_id / block_id / reason / local_json / remote_json / detected_at / resolved_at / resolved_choice` |
| **三种合并结果分开** | `RemoteMerge`（Rust）/ `RemoteMerge` 联合类型（TS）：`NotApplicable`（老内容 / 脏 JSON）／**`Conflicted`（要留痕）**／`Merged`。⚠️ 以前用 `Option`/`undefined` 一个值表示两件事 —— **那正是"静默"的来源** |
| **落表** | `apply_remote_page` / `applyRemoteContent` 在 `Conflicted` 时先 `record_page_conflicts`，**仍然用远端原样落库**（覆盖语义不变）；同一 (页, 块) 的未决记录**覆盖不堆积** |
| **读** | `unresolved_page_conflicts` / `pageConflictsOf`（提示 UI 就用它：一条 = 一处待裁决） |
| **裁决** | `resolve_page_conflict` / `resolvePageConflict(id, "local" \| "remote")`：把选中那一版写回该块（`replace_block_content`）、**盖新 rev**（baseline = 当前页）、落库（`write`/`writeContent` 置 `dirty = 1` ⇒ **这次裁决会被推上去**）、标记已决；已决的再裁决**报错**（不静默成功） |

判据：Rust `doc_content` **28/28**（新增 `replace_block_content_swaps_one_block_only`、
`conflicts_are_recorded_listed_and_deduped`、`resolving_a_conflict_writes_the_chosen_side_with_a_new_rev`，
并把"有冲突"与"没什么可合"分成两条）↔ TS `docContent.test.ts` **47 条**（表驱动那 5 条新的）↔
端到端 `two-device-sync` **42/42**（场景 H 里那段冲突现在走**真 `applyChange`**：落表 ⇒ 两侧原文都在 ⇒
裁决「留本地」⇒ 内容换回 + rev `3,1` + `dirty=1` + 不再未决）。

## 7. 冲突提示条（第六段：界面）

数据层（§6）之上加了一条**看得见**的提示：`src/components/ConflictBanner.tsx`，挂在页面视图
（`App.tsx` 的 `NoteEditor`，`.main` 的直接子元素、工具条之上）。

- **触发**：① 挂载 / 换页；② **一次同步结束**（`useSyncStatus.syncing` 变回 false —— 冲突只可能在 pull 时出现）
  ③ 自己裁决之后。**不做轮询**；**没有冲突时整条不渲染**（不在每页顶部挂空条）。
  ⚠️ 只留**一个** effect：挂载时它本来就会跑一次 —— 另写一个"挂载时读"的 effect 会**每次开页查两遍**
  （第一版就是这样，判据 ④ 顺带发现的）。
- **两侧都对用户露出**：每条显示「本机那一版 / 远端那一版」的正文（取块片段里的 text，读不出来就如实说
  "（读不出来）"，不编），两个按钮 = `留本地` / `用远端`。文案走 i18n（`zh`/`en` 各一组 `conflicts.*`）。
- **入口**：命令面 `list_page_conflicts` / `resolve_page_conflict`（Rust `commands.rs` 注册进
  `generate_handler!`；Web 侧同一套命令名在 `platform/web.ts`；`CommandMap` 与 `api.ts` 各加一条 ——
  `check-web-commands` 这个三方契约门禁会盯着这三处别漏）。
- **样式**：`App.css` 新增 `.conflict-banner*`（用全仓变量，窄屏**只换行不裁**，按钮 44px 触摸目标）。

判据：`src/components/ConflictBanner.test.ts` **4 条**（happy-dom；打桩 `api` 与 `react-i18next`）——
① 没有冲突 ⇒ 什么都不渲染；② 有冲突 ⇒ 两侧原文 + 两个按钮都在；③ 点「留本地」⇒
`resolvePageConflict(id, "local")`（**参数就是它，不猜**）；④ 裁决后重新读 ⇒ 未决没了整条消失。
> ⚠️ 本仓 vitest 的 `include` 只有 `src/**/*.test.ts` + `scripts/**/*.test.mjs` ⇒ 组件判据**写成 `.test.ts`**、
> 用 `createElement`（`.test.tsx` 根本不会被跑到）；React 18 的 `act` 还要手动开
> `IS_REACT_ACT_ENVIRONMENT`（happy-dom 下默认没开 ⇒ 只有警告、刷新时机不受控）。

⚠️ **仍没做**：块级角标（指出"冲突就在这一块"）；真机双设备验收（要人手）。

## 8. 块级角标 ＋ 定位（第七段）

提示条只说"这一页有几处冲突"，用户还得自己找那一块。这一段补上"看得见是哪一块 + 一键跳过去"：

| 件事 | 落点 |
|---|---|
| **发布** | 提示条把 `rows.map(r => r.block_id)` 写进 `useEditorStore.conflictBlockIds`（离开这一页时清空）；**同一份表重复发布不产生新状态**（否则每轮同步都会让编辑器重挂一次 update listener） |
| **打角标** | `src/editor/blockConflictBadge.ts::applyConflictBadges(ids, root)`：按 `data-block-id`（编辑器给顶层块的 DOM 打的标记，与块引用跳转**同一套**）加/摘 `block-conflict` 类；**不在表里的要摘掉**，空表 = 全清 |
| **调用时机** | `Editor.tsx` 里与"跳转到块"相邻的一个 effect：没有冲突就只清一次、**不挂 listener**；有冲突则**每次 editor update 之后再打一遍**（Lexical 结构一变会重建 DOM，类名会跟着没） |
| **定位** | 提示条每条加一个「定位」按钮 ⇒ `setFocusBlockId(block_id)` —— 与 BacklinksPanel / 块嵌入**同一条路**：`Editor` 会滚到它并闪一下 |
| **样式** | `.block-conflict` **只用一条内阴影**（不动背景：正文里的背景属于主题/引用/代码块，改它会把格式吃掉） |

判据：`src/editor/blockConflictBadge.test.ts` **3 条**（加类名＋**摘掉**不在表里的／空表全清／没打标记的块匹配不到）
＋ `src/components/ConflictBanner.test.ts` 扩到 **6 条**（新增：把 id 发布给编辑器；「定位」设 `focusBlockId`；
卸载后清空角标）。两条坑与 §7 同款（`.test.ts` 而非 `.test.tsx`；React 18 的 `act` 要手动开开关）。