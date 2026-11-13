# U4 冲突裁决引导 —— 契约草案（2026-11-13）

状态：**契约已拍板**（owner 2026-11-13：D1=B 摘要＋短片段 / D2=A 只自动安全情形 / D3=A 一页内批量 / D4=A 给推荐＋理由）；**片 1–3 已落地**（纯函数＋数据面＋界面），**片 4 未完成（待人工窗口，见下表）**
上位：[个人同步 2.0 需求](2026-11-08-personal-sync-2.0-requirements.md) §13.5 U4（"diff 摘要、批量裁决、推荐项；只在真两难时问人；冲突页有可读差异（⛔ 不回正文原文）；可批量；默认项有理由"）
证据：现状盘点（代码为证）—— `../../src/components/ConflictBanner.tsx`（块级提示条：`page_conflicts` 两选一「留本地/用远端」，用 `fragmentText` 取纯文本片段做识别）＋
片 1（2026-11-13）：`../../src/lib/conflictAdvice.ts`（`conflictAdvice` / `conflictSummary` / `clipSnippet` 纯函数）＋
`../../src/lib/conflictAdvice.test.ts`（8 条：推荐真值表 / 两难 ask / 片段上限 / 摘要含块类型与量级 /
**正文反例：第 41 字之后不许出现在摘要里**）；`tsc --noEmit` 0；全量 vitest 门禁 ✓
片 2（2026-11-13）：`../../src/lib/conflictShape.ts`（`blockTextFromJson` / `blockTypeFromJson` /
`conflictShapeFromRow` / `conflictRowAdvice` 纯函数；块级表只在真冲突时落行 ⇒ 两侧都算改过、**不猜"一边没改"**；
唯一安全推荐 = 一侧是另一侧前缀（含全部内容）；其余 `ask`）＋ `../../src/lib/conflictShape.test.ts`（8 条，含"形状里不放整段正文"反例）
片 3（2026-11-13）：`../../src/components/ConflictBanner.tsx`（摘要行 `data-testid="conflict-summary"`、建议/两难行
`conflict-advice`、推荐按钮主样式、一页内批量 `conflict-batch` 走 `confirmDialog`＋逐块 `resolvePageConflict`）＋
`../../src/components/conflictGuidance.wiring.test.ts`（4/4）＋ `../../src/components/ConflictBanner.U4.test.ts`（2/2：批量确认路径
`confirmDialog` 带块数＋逐块既有命令；推荐按钮主样式／真两难不高亮）＋ `src/i18n/locales/{zh,en}.ts` 新词条；
`tsc --noEmit` 0；全量 vitest 门禁 ✓
`../../src-tauri/src/db.rs` 的 `page_conflicts`（块级，可逐块裁决）＋
`../../src-tauri/src/sync.rs` 的 `list_page_conflicts` / `resolve_page_conflict`（local/remote）＋
页级三选一（`list_pending_remote_pages` / `resolve_pending_remote_page`：merge / take_remote / keep_local —— 见 `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md`）

## 1. 目标与非目标

**目标**：把冲突裁决从「逐块两选一、没有差异、没有建议」升级为：
1. **看得懂**：给**可读差异摘要**（哪边改了什么、多大、是不是纯追加），⛔ 不回正文原文；
2. **有建议**：每块给一个**推荐项 ＋ 一句理由**；只有**真两难**才让人选；
3. **能批量**：一页/一次同步里的同类冲突可以**一次裁定**（带"将影响 N 块"的二次确认）。

**非目标**：
- ⛔ 不做自动合并算法升级（块级 LWW/CRDT 是 A1 的事，不在本刀）。
- ⛔ 不删任何一版：本地那一版进版本历史、远端那一版留在服务端历史（沿用现状）。
- ⛔ 不把正文/附件内容带进冲突列表/日志（沿用 `INV-UI-copy-no-internal-ids` 与数据边界）。

## 2. 现状盘点（只复用，不造第二套）

| 能力 | 现状 | 位置 |
|---|---|---|
| 块级冲突表 | `page_conflicts`（同块两版；可逐块判） | `db.rs` |
| 读/裁命令 | `list_page_conflicts` / `resolve_page_conflict(local\|remote)` | `sync.rs` |
| 界面 | `ConflictBanner` 提示条：逐块「留本地 / 用远端」，`fragmentText` 片段识别 | `ConflictBanner.tsx` |
| 页级三选一 | merge / take_remote / keep_local（另有一套待取回远端页） | `sync.rs` + 待取回面板 |
| 静默选边 | 已禁止（落表 + 提示条） | 现状判据 |

## 3. 契约条目（待拍板后细化）

- **C1（差异＝摘要＋短片段，不回正文）** 每块至少给出：① 改的是**哪类块**（段落/标题/列表/代码…）；② **哪边改过**；③ **改动量级**（字符数/行数，区间即可）；④ 是否**纯追加/纯删除**。另给**≤40 字短片段**仅作识别（owner D1=B），⛔ **不回整段正文**；片段上限写死、超出截断并注明。
- **C2（推荐项＋理由）** 每块给**推荐**与**一句理由**（owner D4=A），理由必须是规则推出的（例："只有远端改过 ⇒ 用远端"／"两边都改、且都是追加 ⇒ 合并"／"两边都改且互相覆盖 ⇒ 两难，请你选"）。
- **C3（自动裁决边界）** 只对**安全规则**自动（owner D2=A）：① 一边没改；② 纯追加且不重叠。其余一律问人。自动裁决必须**留痕**（冲突记录/HISTORY 可回退），⛔ 不许静默。
  ⚠️ **实现边界（2026-11-13 片 2 落地时记）**：块级 `page_conflicts` **只在真冲突时落行**（`ConflictReason`：同 rev 不同内容 / 任一侧缺 rev）
  ⇒ 本刀**没有**可自动裁决的输入（一侧必改、且互相覆盖或至少都改过）⇒ 界面只给**推荐**，C3 的"自动执行"分支**不触发**；
  自动分支留给**页级/带 base 版本**的将来（不允许把"建议"偷偷当"已裁决"）。
- **C4（批量）** 允许「本页全部按同一策略」（owner D3=A：**仅一页内**，⛔ 不做跨页/跨空间批量）；执行前必须显示**将影响多少块**并二次确认；操作可回退（各自版本都在历史）。
- **C5（只在真两难问人）** "真两难"＝同一块两边都改且无法安全合并；其余交给 C2/C3。
- **C6（不丢数据）** 任何裁决不删对方版本（现状口径不变）。
- **C7（端一致）** 桌面（本地 SQLite）与 Web/移动（API）看到同一套摘要与推荐；读不到差异 ⇒ **如实说读不到**，⛔ 不编。

## 4. 判据（落地时逐条核）

```text
① 纯函数 `conflictAdvice(localChanged, remoteChanged, appendOnly, overlap)` 真值表：
   · 只有一边改 ⇒ 推荐那一边 ＋ 理由；· 两边纯追加不重叠 ⇒ 推荐合并；· 两边都改且重叠 ⇒ 两难（无推荐）
② 摘要函数 `conflictSummary(row)`（纯函数）：必须含块类型/哪边改/量级/追加或删除；
   ⛔ 断言输出里**不含正文原文**（用夹具正文做反例：摘要里不许出现夹具正文的整句）
③ 界面 wiring：提示条显示摘要＋推荐＋理由；有「批量」入口且带"影响 N 块"确认；⛔ 不新造同步路
④ 真机：两机改同一块 ⇒ 摘要正确、推荐有理由、批量一次生效；两难场景 ⇒ 不自动裁、明确问人
```

## 5. 切片

| 片 | 内容 | 判据 |
|---|---|---|
| 1 ✅ | 纯函数 `conflictAdvice` ＋ `conflictSummary`（唯一实现） | 真值表 ＋ "摘要不含正文"反例断言（`conflictAdvice.test.ts` 8/8） |
| 2 ✅ | 数据面：块级 row 已够则前端算摘要；不够则给命令加只读字段（⛔ 不扩语义） | `conflictShape.test.ts` 8/8（表只在真冲突时落行 ⇒ 不猜"一边没改"；唯一安全推荐＝前缀包含；其余 ask） |
| 3 ✅ | 界面：摘要＋推荐＋理由＋批量（带确认） | `conflictGuidance.wiring.test.ts` 4/4 ＋ `ConflictBanner.test.ts` 6/6 不回归（摘要里仍能看到两侧片段、按钮顺序不变） |
| 4 ⏳ | 真机：两机同块冲突一次；两难一次 | **未完成（2026-11-13 两次尝试均失败，如实记）**：① 第一次：AMD 10:19:37 断网→10:20:05 保存 `AMD-U4-B-101800`（离线 200 s）→10:23:25 回网；我方未在轮询窗口、CDP `save_page` 绕过编辑器 rev 语义（base 回 `this is amd v2`/rev19）⇒ 未形成冲突。② 第二次：13:53 双方 base 对齐（`U4-BASE-103852`/rev21）→ 13:55:39–14:16 离线；但 AMD 侧 owner 的编辑器编辑**没落上**（回读 text=`this is amd v2`/rev22/updated 13:51:50，旧缓冲回写），我方也因未读到窗口未改 A2；`page_conflicts` 空；随后 AMD 换网（SXJMZBYXGS/172.16.174.37）⇒ 互不可见。⚠️ 结论：**CDP 造冲突不可靠**（不得冒充真机读数）；真机验收需**同网 + 双方 owner 在编辑器前**；下次窗口必须**改完用 `get_page` 自证内容已变**再交给对方。判据已就绪，待一次人工窗口 |

## 6. 风险与回滚

- 风险：摘要里**漏出正文**（C1 的红线）⇒ 用"夹具正文反例"的机器断言挡住；批量误裁 ⇒ 二次确认 ＋ 版本历史可回退。
  ⚠️ **真机风险（2026-11-13 实测）**：用 **CDP 直接 `save_page`** 造冲突**不可靠** —— 它绕过编辑器 rev 递增/冲突判定语义，
  实测我方编辑被 LWW 覆盖、base 回到原文本 ⇒ ⛔ 不许用脚本化编辑冒充真机读数；真机验收必须**编辑器 UI 操作**。
- 回滚：只改界面/只读摘要与推荐；回滚＝撤掉提示条增强（裁决命令与数据不动）。

## 7. 拍板记录（owner 2026-11-13）

```text
D1 差异展示：**B 摘要 ＋ ≤40 字短片段**（A 只结构化摘要 / C 现状片段 未选）
D2 自动裁决：**A 只自动「一边没改 / 纯追加不重叠」**（B 全问人 / C 尽量自动 未选）
D3 批量粒度：**A 仅一页内**（B 跨页 / C 只逐块 未选）
D4 推荐项：**A 给推荐 ＋ 一句理由**（B 不给推荐 未选）
```

## 8. 判据清单（落地时逐条核）

```text
· conflictAdvice 真值表（5 类输入）
· conflictSummary 反例断言（正文不出现在摘要里）
· 界面 wiring（摘要/推荐/理由/批量确认）＋ 无新同步路
· 真机：同块冲突与两难各一次；批量生效且可回退
· 不回归：ConflictBanner 既有「不许静默选边」判据保持绿
```
