# 血统冲突的「可裁决」那一半：方案稿（2026-09-23，**留痕 ＋ 另存为新页已实现**）

> ★ **已实现（2026-09-23 第 49 轮）**：按 **B 的骨架 ＋ C 的动作**落地（owner 在"自动救援 vs 显式按钮"
> 里选了**显式按钮**）——
> · 新表 `page_lineage_conflicts`（页级、本地；**含对端那一版的投影快照** `remote_doc`）＋ 三条命令
>   `record/list/resolve_lineage_conflict`（两侧同形）；
> · 两处记录点：web 当场合并（`mergeRemotePageState`）与桌面端口（`PageStatePort.recordLineageConflict`），
>   **共用同一份指纹口径** `lineageFingerprint`；去重（**同一对指纹只提一次**）在存储那一层；
> · 小横幅 `components/LineageConflictBanner.tsx`（挂在 `App.tsx`，与块级 `ConflictBanner` 并列）：
>   **「另存为新页」**（＝③ 的第一步）与**「保留本机」**（＝① 的显式确认）。
> 读数与判据见 §9。**②「用对端」仍未做**（要动本机血统的取舍），见 §9 末尾。
>
> 起因：冲刺 §13.3 第 2 条。2026-09-23 第 49 轮已经把「**可见 + 有痕**」那一半接上了
> （`src/lib/crdt/lineageNotice.ts` 一处措辞、pull 与"打开页面"两条路共用，`Editor.tsx` 真的读了
> `pendingSkipped` ⇒ toast ＋ 日志）。**本文只谈剩下那一半**：用户**能不能选**。
>
> 上位：[CRDT 全上线冲刺](2026-09-23-crdt-full-launch-sprint.md) §13.3；
> 相关：[S1 实测红线](2026-09-23-crdt-full-launch-sprint.md) §1（"一块变两块"）、
> [阶段 1 裁决与留痕](2026-09-22-block-rev-write-layer.md)。

## 1. 为什么要"裁决"，而不是"再合一次"

S1 的实测红线已经定死：**两条独立创建的血统在 Yjs 结构上就不是同一棵树**，硬合的结果是
顶层块变成 `["paragraph#blk-1","paragraph#blk-1"]`（一块变两块、`blockId` 重复）。
⇒ 这不是"再想想办法就能合"的问题，**"可裁决"的真实选项只有三个**：

| 选项 | 含义 | 数据后果 |
|---|---|---|
| ① 留本机 | 本机这条血统继续；对端那一版**不进这一页** | 对端那版仍**在服务端**（它的状态在服务端，也有别的设备持有它）——但**这台设备**看不到它 |
| ② 用对端 | 放弃本机这条血统、改接对端那条（本机这一页的内容换成对端的） | 本机这条血统在本页的编辑**从这一页消失**（仍在本机版本历史里） |
| ③ 两个都要 | **一页变两页**：本页保留一条，另一条**另存成一个新页** | 谁都不丢（代价＝多一个页面，用户要自己收拾） |

★ **③ 是唯一"不丢数据"的选项**，而且它正好与"不许合出'一块变两块'"同一精神：**合并做不到时，
把"变两块"这件事交给用户明示地做**（生成两个真页面），而不是让 Yjs 悄悄在同一个页面里出两份块。

## 2. 事实清单（都可在仓里复核，2026-09-23）

| 事实 | 出处 |
|---|---|
| 拒绝合并发生在 **TS** 侧（要 Yjs 判血统）：pull 那条路在 `mergeRemotePageState` ⇒ 回 `lineageConflict`；打开页面那条路在 `bindPageToEditorViaPort` ⇒ 记 `pendingSkipped` | `src/lib/crdt/pageBinding.ts`（护栏在 ~L192-201 与 ~L300-314） |
| **Rust 没有 Yjs** ⇒ 血统关系**只有 TS 判得出来**；Rust 只能存"待并状态"字节 | `src-tauri/src/page_crdt.rs`、`commands.rs::read_pending_page_states` |
| 被拒的待并状态**现在会被清掉**（合并完 `clearPending` 一把清），所以裁决需要的"对端那一版"事后**已经不在**了 | `src/lib/crdt/pageBinding.ts` ~L320-322 |
| 现成的冲突面是**块级**的：表 `page_conflicts`（`page_id`/`block_id`/`reason`/`local_json`/`remote_json`/`detected_at`/`resolved_at`/`resolved_choice`，**本机证据、不同步**） | `src-tauri/src/db.rs` ~L926-942（附"这张表是本机证据"的注释） |
| 裁决入口是**块级**的：`resolve_page_conflict` 内部走 `replace_block_content(page.json, block_id, chosen)` ⇒ 页级冲突**没有**可走的路径 | `src-tauri/src/doc_content.rs` ~L839-875；TS 镜像 `src/lib/docContent.ts` ~L774-798 |
| 冲突 UI 是**块级**的：每行显示"块片段文本 ＋ 定位到那一块"，并把冲突块 id 发给编辑器画角标 | `src/components/ConflictBanner.tsx` |
| 两平面都已有这套命令（web 侧字段名与 Rust 的 snake_case **逐字对齐**） | `web.ts` ~L3339-3362、`commands.ts` ~L801-816 |
| **页级**的现成原语：`takeRemoteWholePage`（整页采用远端：写内容、`dirty` 硬写 0、顺手把未决块级冲突一次标掉）＋ `writeContentProjection` ＋ `markTextStale` | `src/lib/docContent.ts` ~L1097-1103 / L822 / L879 |
| 纪律（别误用）：`page_conflicts` 是"**要人裁决**"的表，往里塞别的标记会让"**未决数量**"失去意义 | `src-tauri/src/doc_content.rs` ~L116-118（原文是给"正文自动修复"定的，理由同一族） |
| 同步摘要里已经有一格页数：`block_conflict_pages`（逐块判不了 ⇒ 已留痕，只需告知用户） | `src-tauri/src/sync.rs` ~L152 与 ~L469-470 |

## 3. 三条路（选一条）

### A. 复用 `page_conflicts`：哨兵 `block_id=''` ＋ 新 `reason='lineage-independent'`

- ✅ 表/两条命令/横幅/刷新时机（"一次同步结束"）全部现成，两平面都有实现。
- ❌ **语义污染**：`block_id=''` 的哨兵行会让"未决块数"这类读数变含糊；`ConflictBanner` 的每行 UI
  （块片段、定位到块）对页级**根本不成立**；`resolve_page_conflict` 必须分叉出"页级写回"分支，
  两条语义挤在一个命令里。
- ❌ 与上面那条纪律**正面冲突**（同一条理由：塞进去 = "未决数量"失去意义）。
- **结论：❌ 不选。**

### B. 新表 `page_lineage_conflicts`（页级、本地、可裁决）

字段（草案）：`id` / `page_id` / `detected_at` / `mine_fp` / `remote_fp`（两条血统的 client id 指纹）/
`remote_snapshot_json`（**对端那一版的整页投影**，裁决要用它）/ `remote_state`（可选：对端的 CRDT 状态字节，
选 ②/③ 时要落成新页的血统）/ `resolved_at` / `resolved_choice`。
`UNIQUE(page_id) WHERE resolved_at IS NULL`（同一页**只留一条未决**：反复相撞不堆行 —— 与
`record_page_conflicts` "先删旧未决再插"同一纪律）。

- ✅ 语义干净、与既有"本地状态、不同步、不进导出"一族（`page_conflicts` / `text_stale` / `page_crdt_pending`）一致。
- ✅ 裁决接口自成一格：`resolve_page_lineage_conflict(id, choice)`，`choice ∈ {local, use-remote, save-remote-as-new}`，
  **只认这三个字面量、其余报错**（与 `resolve_page_conflict` 同一纪律：不默认选边）。
- ❌ 新表 ＋ 两侧命令（契约 / Rust / web）＋ 第二块 UI ＋ 文案（zh/en）。工作量最大。

### C. 不做"裁决"，只给一个动作：**把对端那一版另存成新页**（最省）

- ✅ 改动最小：不需要"记录未决状态"的完整机器 —— 只需要在拒绝合并那一刻**做一次导出**：
  把 `projectStateToJson(对端状态)` 交给现成的「新建页面」入口（`api.createPage({content_json, content_text})`）
  ⇒ 用户既没丢本页，又拿回了对端那版，而且**他知道**（toast 里说清"已另存为《…》"）。
- ✅ 顺手解决"裁决需要的对端那一版事后不在了"这条：它在**这一刻**就被落成一个真页面，
  不依赖任何新表。
- ❌ 少一个"我只想用对端那一版"（②）和"我知道，别管它"（① 的显式确认）——但这两个都可以后补，
  而且 ① 的默认行为**今天就是**"留本机"。
- ❌ 会**自动**产生一个新页面：如果只是网络抖动导致重复相撞，用户可能莫名多出几页（要有去重口径：
  同一对指纹只救一次）。

## 4. 建议（分两步，推荐 B 的骨架走法）

**推荐：先做 C，再按 B 补"另存为/用对端/留本机"三个显式选项。**

理由：C 是**唯一能在"没有新表"的前提下把数据救回来**的动作，而且它把"裁决时还需要那一版"这个
最难的问题**在发生的那一刻就地解决**（落地成页面，而不是留在待并队列里等 UI 来读）。
B 补齐后，C 就退化成 ③ 的一个实现方式（`save-remote-as-new`），两条路不冲突。

**若直接上 B（不做 C）**：必须先把"对端那一版"留住（要么不 `clearPending` 被拒的那些行、
要么把投影快照写进 `page_lineage_conflicts.remote_snapshot_json`）——否则"裁决"到时候**无从下手**
（只能"留本机"，那就不叫裁决了）。

## 5. 承重判据（草案；实现时逐条落成测试）

| # | 判据 | 手段 |
|---|---|---|
| 1 | **记录**：两条血统无关被拒 ⇒ 落一行（含两条指纹 ＋ 对端快照）；**同一页重复相撞不堆行** | Rust 单测（表）＋ TS 纯函数（同一对指纹的去重） |
| 2 | **幂等**：服务端把同一笔待并状态又推一次 ⇒ 不产生第二行、不第二次"另存为" | 单测（对端指纹/seq 去重） |
| 3 | **不静默也不吵**：有未决 ⇒ 看得见；`skipped=0`/无冲突 ⇒ **一次写库都不做**、不弹 | 沿用第 49 轮 `lineageNotice.test.ts` 的**反方向**那条形态 |
| 4 | **不默认选边**：`choice` 只认白名单字面量，其余**报错**（不是"随便挑一个"） | Rust 单测 ＋ TS 单测（与 `resolve_page_conflict` 同一形态） |
| 5 | **谁都不丢**：无论选哪一支，另一边都能找回（① 本机那版在版本历史；② 对端那版在快照/新页；③ 两边都在）——**判据要写清"靠什么保"** | 端到端（临时库）：裁决后逐条断言"另一边仍可读" |
| 6 | **裁决后不再重复报**：裁决完对应的 pending/标记被清，重新打开这一页**不再弹** | 端到端（重开页面断言不再报） |
| 7 | **两平面一致**：Rust 与 web 同一套字段名与语义（web 侧 `list_page_conflicts` 已有先例） | `check-web-commands` ＋ 两侧同名单测 |
| 8 | **数据库页排除**：`kind='database'` 的页**不许**被投影/快照写回（行文本会被抹掉 —— 这是 `mark_text_stale` 实测撞过的坑） | Rust 单测（照 `mark_text_stale` 的判据形态） |

## 6. 风险与边界（写清，别到时候当 bug 查）

1. **快照体积**：`remote_snapshot_json` 是本地表（不进同步、不进导出），但整页 JSON 可能不小 ⇒
   只存**一条未决**（不按 seq 堆）；上限与页面大小同量级（实测：页 JSON 与 CRDT 状态同量级，
   200 块 ≈ 31.6 KB 状态 / 51.1 KB JSON，见 [S5 决策稿](2026-09-23-s5-server-merge-decision.md) §体积）。
2. **裁决动作要不要推上去**：两个先例并存 —— `takeRemoteWholePage` **不标脏**（采用远端 ≠ 本机编辑），
   `resolve_page_conflict` **标脏**（裁决是一次本地编辑）。本稿建议：①/② 采用远端 / 留本机 **不标脏**；
   ③"另存为新页"当然要落盘并推送（它是新页面）。**这条要 owner 拍**（我倾向"不标脏"，
   因为血统选择是**设备侧**的决定，不是内容编辑）。
3. **反复相撞**：不裁决就一直相撞（每次拉取都可能再来一条）⇒ 去重靠"指纹对"，不靠时间。
4. **③ 的页面归属**：救回来的新页放哪个工作空间/父页面？默认放**同一工作空间、无父**（与"新建页面"一致），
   标题加后缀（如「（另一条编辑历史）」）——**别自动合并标题**。
5. **web 侧也有这条路**：web 在 `applyChange` 里当场合并 ⇒ 它同样会撞血统冲突（`lineageConflict`），
   但**没有** `page_crdt_pending`（那是桌面独有的"先收后合"路径）⇒ C/B 的实现要在 web 侧走
   "当场记录 + 当场另存"的路径，不能假设 pending 存在。

## 7. 明确**不做**的

- ❌ 不做"把两条血统**合并**成一个页面"（S1 红线：结构上做不到，硬做就是"一块变两块"）。
- ❌ 不做"服务端裁决"（S5 阶段 2 已建议暂缓；血统判定要 Yjs，服务端今天没有）。
- ❌ 不把页级行塞进 `page_conflicts`（见 §3-A）。
- ❌ 不在读路径上惰性生成快照（与 `text_stale` 那条"不许在读路径上重建"同一纪律）。

## 8. 动手顺序（若按"先 C 后 B"）

1. **C**：拒绝合并那一刻 → `projectStateToJson(对端)` → 新建页面（＋ toast 说清）；
   去掉"被拒的待并状态一把清掉"里对**被拒**那些的清理（或明确保留，留痕在下一轮用）。
   判据 2/3/5/8 ＋ 去重口径。
2. **B**：新表 ＋ 两侧命令 ＋ 裁决 UI（放在 `ConflictBanner` **上方**，不复用它的块级行）＋ 三个选项；
   判据 1/4/6/7。
3. 文档：设计稿 §5 的判据表补一行"页级裁决"，`SHUYONOTE_STATE.md` 缺口 ② 收口。

## 9. ★ 落地读数（2026-09-23 第 49 轮，本机实跑）

**实装了什么**（owner 拍了**显式按钮**，所以走"B 的骨架 ＋ C 的动作"）：

| 层 | 改动 |
|---|---|
| 存储 | 新表 `page_lineage_conflicts`（**本地、不同步、不进导出**；与块级 `page_conflicts` 同族但**不同表**）：`id/page_id/mine_fp/remote_fp/**remote_doc**/detected_at/resolved_at/resolved_choice`。两侧各一份 schema（Rust `db.rs` / web `sqliteStore.ts`，字段名逐字一致） |
| Rust | 新模块 `src-tauri/src/lineage_conflict.rs`：`record`（**去重**：同一对指纹未决 ⇒ 只刷新快照；已裁决 ⇒ **不再提**；否则删掉这一页别的未决行再插）/ `unresolved`（至多一条）/ `resolve`（**只认 `local` / `saved-as-new`**，已裁决再裁决**报错**）＋ 3 条命令 |
| TS 层 | `docContent.ts` 同语义镜像（Web 的三条命令**直接调它**，不在平台层写第二份判定）＋ 契约/api/web 分派 |
| 记录点 | ① web 当场合并（`mergeRemotePageState` 的护栏命中处，直接落库）；② 桌面端口（`PageStatePort.recordLineageConflict` → 命令）。两处**共用** `lineageFingerprint()` 算去重键；`docJson` 都是 `projectStateToJson(对端状态)` ⇒ **快照就是救援时唯一还在的那一份**（`clearPending` 随后会清掉待并状态） |
| UI | `components/LineageConflictBanner.tsx`（挂在 `App.tsx`，与块级 `ConflictBanner` **并列**、样式复用 `.conflict-banner`）：「另存为新页」（建页 ＋ 标题加后缀「（另一条编辑历史）」＋ 内容用快照 ＋ 正文按编辑器语义 `deriveContentText` 派生 ＋ 记 `saved-as-new`）／「保留本机」（记 `local`）。刷新时机与块级那条**同两处**：挂载/换页 ＋ 一次同步结束 |

**判据（全绿）**：

```
Rust lineage_conflict::tests（4 条）：同一对只记一次 + 快照刷新 ／ 已裁决过不再提（换新血统则要提）
                                    ／ 只认两个字面量 + 已裁决再裁报错 ／ 冲突只落在那一页
TS docContent.test.ts（4 条）：同上去重的四条语义（Web 侧的全部语义）
TS crdt/pageBinding.test.ts（1 条 ㉑）：独立血统被拒 ⇒ 当场留痕（两条指纹 ＋ **对端那版快照**）；同血统合并 ⇒ 不留痕
TS components/LineageConflictBanner.test.ts（5 条，happy-dom）：无未决不渲染 ／ 只有两个按钮 ／
                                    「另存为新页」真的建页（标题后缀＋内容是快照＋正文派生）＋ 记 saved-as-new
                                    ／ 「保留本机」记 local 且**不建页** ／ 裁决后整条消失
TS crdt/lineageNotice.wiring.test.ts（+1 条，文本级）：App 里**挂上了**横幅 ＋ 两处记录点都在 ＋ 指纹口径同一份
```

**变异实测**：把 TS 侧去重闸门短路（`if (false && existing)`）⇒「同一对指纹只提一次」**红**；还原 ⇒ 全绿。

**当轮 tip 读数**：Rust 全量 **573 tests / 555 passed / 0 failed / 18 ignored**；
vitest 全量 **213 files passed（2194 passed / 12 skipped）**；
`tsc` 0；`pnpm run build` 0；`build:web` ＋ `check:web-build` 9/0；`test:sync-verify` 84/0；
`check-web-commands` 绿（**Rust 251 / web 249 / 契约 253**）；`check-doc-content-access` 562（基线 562）。

⚠️ **这一轮撞到一次负载假红，如实记**：把 vitest 全量与 Rust 全量**并行**跑时，五个 **spawn 外部进程**的
脚本测试一起报 `Test timed out in 5000ms`（`plugin-fragment` / `sm-library-patch` / `check-sys-deps` /
`check-changelog-version-parity` / `yrsInterop.spike`）；**隔离复跑 16/16 全绿**、**串行**全量也全绿。
同批里 `lineageGuard.test.ts` ② 是**真红**（新加的留痕 SQL 没被那个测试的假库认识）⇒ 已修。
判读纪律已写进 `docs/TESTING.md` 的「计时类判据」那条。

⚠️ **仍未做的（如实）**：
1. **② 「用对端」**（放弃本机这条血统、改接对端那条）没做 —— 它要动**本机血统的取舍**，
   而且必须先有"本机这版也不丢"的去处（否则就是把本机的编辑丢掉换一份）。今天用户可以走 ③（另存为新页）
   达到"两边都在"，所以 ② 的边际价值低于它的风险。
2. **救援是"另存一份"，不是"合并"** —— 这与 S1 红线一致（结构上合不了），不是偷懒。
3. 页级行**不进同步、不进导出**（与 `page_conflicts` 同族）：别的设备看不到这一页在这台机器上撞过车。
