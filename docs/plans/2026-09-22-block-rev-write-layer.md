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
那不是"静默丢更新"（对方确实改过、本地确实没改）。

★ **owner 已拍板（2026-09-22）：接受这条口径**（"新客户端保存时给没改过的块盖 `0`、`0` 按最老算：
输给任何明确编号、但**不提示**"）。两边评审的意见同向：macOS 要的就是"把 `0` 的语义钉成判据"
（`identical_content_with_divergent_revs_converges_to_max` / `legacy_zero_rev_block_loses_to_explicit_remote_rev`），
AMD 认"缺 `rev` 只剩老客户端产物一种含义"。⇒ **这一格结项**，此后改动它要重新走拍板。
另一件事没变：**唯一残留的不确定**是"两侧都是 `0` 而内容不同"⇒ 走 `SameRevDifferentContent` 提示（不猜）。

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

## 9. 正文文本"滞后一拍"的收口（第八段）

**问题**（前面几节一直挂着的那条已知边界）：合并 / 裁决产物是**拼出来**的（服务端拼的、或本地按块拼的），
而 `content_text` 仍是**页级胜方那一份** ⇒ 那一页的 FTS 会有一段时间"搜不到刚合并进来的字"，
要等**下一次保存**才重建。

**修法（关键是"不引第二份派生实现"）**：派生文本要编辑器语义，而 `contentText.ts::deriveContentText`
会把整张节点表拖进打包图（`docs/development.md` 记过的那条坑，同步路径不能用）。
⇒ 换方向：**有编辑器的那一侧**在打开页面时顺手算一遍（编辑器已经把文档解析好了），
与库里那份不同就写回去。

| 件事 | 落点 |
|---|---|
| 判断（纯函数） | `src/lib/pageTextRepair.ts::repairPageTextIfStale` —— 三条边界：**拿不到库里那份 ⇒ 不修**（不猜）／两边相同 ⇒ **一次写库都没有**（绝大多数页面）／空页两边都是空串 ⇒ 不修 |
| 算 | `Editor.tsx` 的新插件 `PageTextRepairPlugin`（在 composer 内）：`$getRoot().getTextContent()` —— **与保存路径同一句**（所以这不是"第二份派生实现"）→ `api.refreshPageText(pageId, derived)` |
| 比 + 写（**都在层里**） | `doc_content::refresh_page_text_if_stale` / `docContent.refreshPageTextIfStale`：读库里那份 → 不同才写 → 返回"是否修了"。⚠️ 第一版把"库里那份"传到界面层去比较 ⇒ **收口门禁当场红**（`App.tsx` / `Editor.tsx` 那类文件的计数只许减不许增）⇒ 比较挪进层里就对了 |
| 写什么 | **只动正文文本**：不动内容 JSON、**不动 `dirty`**、不动 `updated_at` —— 它不是用户编辑，标脏会被当成本地改动推上去 |

⇒ 窗口从"下次**保存**"缩到"下次**打开**该页"（打开时编辑器本来就会解析一遍，判据是零成本的字符串比较）。

判据：Rust `write_text_touches_only_the_text`（真表：内容/dirty/updated_at 一个都没动）↔
TS `writeContentText` 的同款一条 ↔ `src/lib/pageTextRepair.test.ts` **4 条**（不同 ⇒ 写回并报"修了"／相同 ⇒
不写／`undefined` ⇒ 不写／空页与无 id ⇒ 不写）。

⚠️ **仍然存在的窗口（如实）**：**从没被打开过**的那一页，正文不会被修 —— 窗口 = **直到那一页被打开**
（只读浏览的场景里可能永远不关）。**裁决路径同样留下 stale**：`resolve_page_conflict` 把选中那一块写回、
JSON 变了，而正文列仍是写回前那一份（两个平台都是：Rust `DocContent{ text: page.text }`、TS `text: page.text`）。
**用户可读的措辞**（macOS 要求别只留在方案里）：**"合并进来的内容，要打开过那一页才能被搜索到。"**

⚠️ **更正我自己（2026-09-22）**：本节早先写过"**Web 侧搜索是按内容 JSON 现算的、不读那一列 ⇒ 那边没有这个窗口**"
—— **这句是错的**：Web 的搜索就是 `SELECT id, title, content_text, updated_at FROM pages` 之后再按那一列打分
（`platform/web.ts::rankPagesForSearch` 与它 1744 行的调用点），所以**那边有同一个窗口**。
（已同步更正给两边评审：`2026-09-22-page-text-repair.reply-4.md`。教训与 macOS 当天那条"更正我自己"同款：
**别拿"我记得它是这么实现的"当结论，去读那一行 SQL**。）

**关闭它需要两件东西（分开看，别混成一件）**：

| 件 | 现状 | 说明 |
|---|---|---|
| ① **算**（谁来派生） | **早就是现成的** | `src/lib/contentText.ts::deriveContentText` 是**唯一派生实现**：一个**不需要 DOM** 的探测编辑器解析 JSON 再取 `$getRoot().getTextContent()`（判据 `contentText.test.ts` 钉住"与编辑器路径逐字相同"）。⇒ 后台补算**可行**，且不需要第二份实现 |
| ② **知道哪些页要补**（这才是要拍板的那件） | 没有 | 见下面 B1 / B2 |

第 ① 件今天不能放进层里，**不是**因为算不出来，而是**分层纪律**：那个文件拖着整张节点表，而 `docContent.ts`
会被 **node 侧** `smoke-web` 打进去（`scripts/smoke-web.mjs` 的 entryPoint 就是 `platform/web.ts`，
`docs/development.md` 记过这条坑）⇒ 层里与 `web.ts` 里**都不能引**它；补算只能由**只在浏览器包里**的界面侧驱动
（今天的 `PageTextRepairPlugin` 正是这个位置）。

第 ② 件的两个形态（**owner 2026-09-22 拍板选 B1**，落地见 §11）：

- **B1（耐久队列）**：`pages` 加一列本地标志 `text_stale`（**不同步、不进导出**，与 `page_conflicts` 同族）；
  合并/裁决落库那一步置 1、补算写完清 0。好处：跨重启记得住、能报"**还有 N 页正文待重建**"。
- **B2（不加存储）**：同步报告里带"本轮**合并过 / 裁决过**的页面 id"，界面收到就立刻补算。
  好处：零 schema 改动；代价：**进程一关就丢**（没补完的要等下次打开、或下次合并）。
- **A（现状）**：只写这一节，等阶段 2（正文 Yjs）自然消掉。

⚠️ macOS 那条禁令继续有效：**不许在"读"路径上惰性重建**（每次读都算 ⇒ 索引与库内容最容易不一致，且慢）
—— 补算只能是**写路径**上的动作（合并/裁决落库之后、或打开页面时）。

## 11. B1 已落地（第十段）：正文"待重建"标记 ＋ **补算器**（2026-09-22，owner 拍板）

### 11.1 落点

| 件 | 落点 |
|---|---|
| schema（两处） | Rust `db.rs`（`pragma_table_info` 检查 ＋ `ALTER TABLE pages ADD COLUMN text_stale INTEGER NOT NULL DEFAULT 0`）、Web `sqliteStore.ts`（DDL ＋ 同一个 ALTER） |
| 层（两处，逐条对应） | Rust `doc_content.rs`：`text_stale` / `mark_text_stale` / `clear_text_stale` / `stale_text_queue`；TS `docContent.ts`：`textStale` / `markTextStale` / `clearTextStale` / `staleTextQueue` |
| 打标记 | ① `apply_remote_page` / `applyRemoteContent` 的合并支（**且只在产物里留下了远端没有的本地块时**，见 §11.3）；② `resolve_page_conflict` / `resolvePageConflict`（裁决换了内容） |
| 清标记 | `refresh_page_text_if_stale` / `refreshPageTextIfStale` 的**两条出口**：真的修了；或算出来与库里相同（§11.3 的假账） |
| 队列读出口 | 命令 `list_stale_text_pages`（Rust `commands::list_stale_text_pages` ＋ `web.ts` 同名分支 ＋ `CommandMap` ＋ `api.listStaleTextPages`），返回 `{ total, pages: [{ page_id, title, doc_json }] }` |
| 补算驱动（**界面侧**） | `src/components/TextRepairRunner.tsx`：`runTextRepairPass` 问队列 → 用**唯一派生实现**（`contentText.ts::deriveContentText`，探测编辑器、不需要 DOM）算文本 → `api.refreshPageText` 写回；挂载在 `App.tsx` 的根部浮层里，**应用启动 ＋ 每次同步结束**各跑一趟，`TEXT_REPAIR_BUDGET = 20` 页/趟，补不完就 `toast` **"还有 N 页正文待重建"**（i18n `textRepair.pending`） |
| 日志 | 每补一页 `console.info("[doc-content] 正文补算：page=…")`（Rust 侧同款 `eprintln!`），与 AMD 那条"不许完全静默"一致；**不写 `page_conflicts`** |

**为什么驱动在界面侧**：`contentText.ts` 拖着整张节点表，而 `docContent.ts` 会被 **node 侧** smoke 打进去
（`scripts/smoke-web.mjs` 的 entryPoint 就是 `platform/web.ts`）⇒ 层里与 `web.ts` 里都不能引它。

### 11.2 判据（Rust ＋ TS ＋ 脚本 ＋ 组件，四层）

- Rust `only_a_real_merge_marks_the_text_as_stale`（四支：合并留下本地块 ⇒ 打；冲突回落／没什么可合／
  **两端逐字相同** ⇒ 都不打）、`resolving_a_conflict_marks_the_text_as_stale_and_the_queue_lists_it`、
  `repairing_clears_the_flag_even_when_the_derived_text_matches`；
- TS `docContent.test.ts` 同名三条（逐条对应，含 `limit` 夹到 ≥1、页面不存在 ⇒ `undefined`）；
- 脚本**场景 N**（`verify-two-device-sync.mjs`，真 `applyChange`）：吃下远端本身**不打** → 合并**打** →
  此刻正文列还是**远端那一版**的文本（b2 写着"原始"、内容里已是 B 改的）→ 队列交得出来 →
  补算后正文一致、标记清掉、队列空 → 相同文本再补一次不写（脚本断言 64 → **76**）；
- 组件 `TextRepairRunner.test.ts` 五条：队列空 ⇒ 一次都不调／喂的是**唯一派生实现**的输出（且**不是**老算法
  的空格拼接）／**预算**被真的尊重（第二批只问 2 页）／补不完回报 `remaining > 0`／同步中不跑、同步结束跑一趟并弹提示。

### 11.3 落地时被抓住的两件事（都值得记）

1. **"产物字符串 != 远端字符串"是错的判据** —— 物化会重排键序、剥掉嵌层同名键、写回 `blockRev`
   ⇒ **内容逐字相同的两端也会得到不同的字符串** ⇒ 每一页同步都会被误打标记（假账）。
   脚本场景 N 当场抓住 ⇒ 改成看**产物里有没有远端没有的本地块**（`kept_local` / `keptLocal`，
   由 `merge_blocks` 的 `Local`/`OnlyLocal` 判定），并把它作为 `RemoteMerge::Merged` 的**字段**交出来
   （返回值先说清"发生了什么"，与 §5 那条纪律同源）。
2. **"相同也要清标记"**：合并/裁决可能**并没有**改动这一页的正文 ⇒ 不清就会永远挂着几页假账，
   "还有 N 页待重建"就变成噪声（正是 macO 说的"提示变噪声等于没有提示"）。判据单独钉住。

### 11.4 仍然存在的边界（如实）

- 补算要有**应用在跑**：同步完立刻关掉应用 ⇒ 标记留着，下一次启动/同步继续补（这正是 B1 比 B2 强的地方：
  **跨进程记得住**）；
- 补算是**有预算**的（20 页/趟）：积压很多时一轮补不完，界面会说"还有 N 页"，而不是假装补完了；
- Web 侧 `resolvePageConflict` 也打标记 ✓（那边搜索读正文列，见 §9 的更正）；
- **阶段 2（正文 Yjs）落地后**这一列与补算器应当一起退场（那时正文由 CRDT 直接描述，没有"派生滞后"这件事）。

## 10. 回信那一轮（第九段：macOS / AMD 抓到的四条 ＋ 两个回答）

四位评审的原文在信箱里（`2026-09-22-*.reply-*.md`）。这一段只记**落进代码的那几条**与**不改的那几条**。

### 10.1 ★ 真 bug：`identical` 那一支的 rev 必须取 **max**（macOS 抓到）

老写法 `l.rev.or(r.rev)`（TS `l.rev ?? r.rev`）是"本地优先"。**内容逐字节相同 ≠ 两边一样新**：
留下更旧的那个 rev ⇒ 本地下一次编辑从这个更低的基线加一 ⇒ 编号追不上远端**已经见过**的编号
⇒ 远端那笔更旧的编辑会在随后一次合并里**静默赢过**本地的新编辑（丢更新）。

macOS 给的 trace（现在就是判据）：A 的 `b1` 已到 `4`、B 只有 `2`（内容相同）；B 收到远端后必须把 `4` 记下来；
之后 A、B 各改这块 ⇒ 两边都盖 `5` ⇒ 下一次合并落进"同 rev 不同内容"⇒ **提示**（看得见），而不是静默。

判据：Rust `identical_content_with_divergent_revs_converges_to_max`
＋ 承重那条 `max_rev_keeps_the_next_local_edit_visible_instead_of_losing_it`（端到端把"静默丢"跑成"提示"）
↔ TS `docContent.test.ts` 同名一条。

⚠️ **不为此把行标脏**（AMD 建议过）：内容逐字相同 ⇒ 没有可推的信息（rev 不参与同步，§6）；
标脏会凭空多出一笔"本地改动"，把 `dirty`-优先本地那条推开 —— 副作用比收益大。抬升的 rev 只作为**本地后续编辑的基线**。

### 10.2 `rev === 0` 的三条语义（macOS §二 要求钉在一起）

| 语义 | 落点 |
|---|---|
| `0` = **"老到不能再老"**（比较时**小于**任何明确 rev） | `merge_blocks` 的 `(Some(lr), Some(rr)) if rr > lr` ⇒ 远端赢；不是"判不了" |
| `0` **不是**"新版本" | `assign_block_revs`：改过的块一定拿 `maxSeen + 1 ≥ 1`，本层不写出新的 `0` |
| 比较发生在**两侧各自读到的 `blockRev`** 上（同一把尺子），**服务端不参与**（服务端不读 rev，只搬 JSON） | 本文件的层边界 ＋ `docs/plans/2026-09-19-stage1-block-lww-readiness.md` §6 |

判据：Rust `legacy_zero_rev_block_loses_to_explicit_remote_rev` ↔ TS 同名一条（内容取远端、rev 抬到 `3`、**不提示**）。

★ **owner 已拍板（2026-09-22）：接受**（详见 §3 末尾那一格）。三条语义与两个反判据都不改；
**"缺 `rev`" 与 "`rev = 0`" 是两件不同的事**这条区分被固化：前者（老客户端产物）一律提示，后者可比较、可让远端赢。

### 10.3 正文文本与 **FTS 索引必须一起动**（macOS §三 的警告，`page-text-repair.reply-2` 里**实测抓到**）

`refresh_page_text_if_stale` 原来只 `write_text`：**列对了、搜索结果还是旧的**。桌面的搜索是**按查词形态分流**的
（单词 ≥3 字走 `page_fts`、多词/<3 字走 `content_text`）⇒ 症状是"**有时候搜得到、有时候搜不到**"，
比全搜不到更难被当成 bug 报上来。⇒ 现在顺手 `derive_fts` 一次（派生仍只从这一层出，§4 规则 1）。

判据：Rust `refreshing_the_text_also_refreshes_the_search_index`（macOS 给的名字）—— 真表、**先证伪**
（修复前 `MATCH "刚合并进来的字"` = 0）、修完 ① 层里读出口与算出来的那一份逐字节一致（AMD 的形状）
② `MATCH` 到新文本、`MATCH` 不到旧文本 ③ 相同 ⇒ 一次写库都不做。
另加**边界判据** `merged_write_leaves_the_text_column_on_the_remote_side`：合并成功那一刻正文列**仍是远端那一份**
（它不是合并产物的派生文本）—— 钉住，免得有人以为它是一致的。

**"自动修复"的两条口径**（`page-text-repair.reply-1`，AMD）：
① **不写 `page_conflicts`**（那是"要人裁决"的表，塞进去会让"未决数量"失去意义 —— 角标 UI 正靠它计数）；
② 但**不许完全静默** ⇒ 修完留一行日志（Rust `eprintln!("[doc-content] 正文修复：page=…")`，
与既有 `[sync]` 那几条同形态；Web 侧由编辑器插件 `console.info` 同一句话），**不做第二个冲突 UI**。

### 10.4 嵌层的同名字段：**写进文档**（macOS §四 (d)）

`canonical_content` **递归**剥 `blockRev`（哪一层都不是内容）⇒ 物化产物里**嵌层的同名键会消失**。
今天选"写进文档 + 钉成判据"而不是"改成只剥顶层"：改成只剥顶层会让**一次纯管道差异**（嵌层 rev 的增删）
被判成"内容变了"⇒ 那一块白涨一个 rev ⇒ 反过来又制造"本地旧内容赢过远端真编辑"的口子。
代价如实写：嵌层同名键消失 ⇒ 若那一块将来**被提升为顶层块**，它的 rev 从 `0`/新盖章重新开始（丢的是 rev 记忆，不是内容）。
判据：Rust `materialization_drops_nested_block_rev_and_keeps_content` ↔ TS 同名一条（嵌层的 `blockId`/文字一个字节不许动）。

### 10.5 "留痕 ≠ 已裁决"：apply 的**返回值**必须说出来（AMD）

- 层：`apply_remote_page` 返回 `RemoteMerge`（Rust）／`applyRemoteContent` 返回 `AppliedRemoteContent`（TS）——
  调用方不必"再去查一次表"才知道这次有没有留下未裁决的冲突。
- 同步报告：`SyncReport` / `WorkspaceSyncResult` 新增 `block_conflict_pages`（**页面数**，按页去重）。
  ⚠️ 与既有的 `conflicts`（页级 dirty ⇒ **要用户选**保留本地/采用远端）**分开报**：合成一个值就是"静默"的另一种长相。
- Web 侧同步报告**今天根本没有** conflicts 字段（历史遗留）⇒ 那一侧只在**层返回值**上暴露；界面靠 `pageConflictsOf` 直接读表。

判据：Rust `sync::tests::apply_upsert_reports_unresolved_block_conflicts`（回报 1 ＋ 表里正好 1 行；内容相同时回报 0）
＋ `doc_content::tests::apply_remote_page_reports_unresolved_conflicts` ↔ TS 两条 `applyRemoteContent` 用例（`{merged, unresolved}`）。

### 10.6 角标的**负判据**（macOS §一）

"打一次就完事"是错的：Lexical 结构一变就**重建 DOM**，类名跟着没。
⇒ 把 Editor 里那段形状抽成 `installConflictBadges(editor, apply)`（**立刻先打一次 ＋ 每次 update 再打**），
判据：`blockConflictBadge.test.ts` 最后一条（挂载先打 ⇒ 模拟 DOM 重建 ⇒ 触发 update ⇒ 类名回来 ⇒ 解绑后登记被摘掉）。

### 10.7 这一轮**不做**的：部分合并（macOS §四 明确"现在不做"）

理由（他们的，我照抄）：可解释（第三种状态"半页合并了"要 UI 解释）／可测（今天的判据面短）／失败面小。
⇒ 保持**整页回落 ＋ 留痕 ＋ 可裁决**；`merge_remote_content` 里那条"有冲突就整页回落"的语义**一个字没改**。
前置条件（将来单独立项时）：① 块级 rev 覆盖完整（18 类声明字段已就位）② **真机双设备验收通过**。
代价如实记：整页回落那一支里，"非冲突块本该合并进来的收益"一并放弃（同页并发仍会丢更新），
而 `page_conflicts` 只记了**冲突块**，被放弃的**非冲突本地块**今天没有痕迹。
