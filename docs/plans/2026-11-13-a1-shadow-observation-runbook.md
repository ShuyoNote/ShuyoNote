# A1 CRDT 灰度 —— 影子观察 runbook（2026-11-13 准备，2026-11-18 起可判）

状态：**待执行**（观察窗口未满；⛔ 现在不能拍灰度默认值）
> ⚠️ **2026-11-14 更正**：`equal=0` 的根因已定位 —— 落盘 block 带 `blockRev`、CRDT 投影不带 ⇒ 比对口径系统性偏差，
> **旧观察数据（11-09…11-14）作废**。**修法 A 已落地（2026-11-14）**：比对前忽略 `blockRev` 元数据键
> （见 [根因定位](2026-11-14-a1-shadow-equal-zero-rootcause.md)）⇒ **7 天窗口从 2026-11-14 重新起算，最早 2026-11-21 收口**。
上位：[个人同步 2.0 需求](2026-11-08-personal-sync-2.0-requirements.md) §13.3 A1（"7 天影子观察后，再决定 CRDT 默认灰度"）＋
[交接单](2026-11-12-personal-sync2-handoff.md) §3「A1 必须等 7 天影子观察，最早 2026-11-18 收口」
证据（现状机制，代码为证）：`../../src/lib/crdtShadowHistory.ts`（`SHADOW_HISTORY_KEY = "shuyonote:crdt-shadow-history"`；
每天一条 `{total, withState, equal, differ, differPending, differUnexplained, uncomparable}`；只留最近 7 天）＋
`../../src/lib/crdtShadowScan.ts`（只读扫描：`listWorkspacePages` → 每页 `getPage` ＋ `readPageState`；只回计数与 differPageIds，⛔ 正文一个字节都不带）＋
`../../src/components/SyncPanel.tsx`（同步面板里的影子观测入口与「复制影子观测摘要」）

## 1. 目的与不做的事

**目的**：用**真实使用**的数据回答一个问题 —— 「投影内容（落盘正文）与 CRDT 状态是否一致」，
为 owner 拍「CRDT 默认灰度（分批/可回退）」提供读数。

**不做**：⛔ 不在这份 runbook 里改默认值；⛔ 不把正文/页面内容抄进记录（只留计数与 id）。

## 2. 每天要做的（约 2 分钟/天，连续 7 天）

```text
① 打开 dev/安装版（同一份数据）→ 同步面板
② 对**每一个**常用空间点一次「影子观测」（只读扫描，不写库）
③ 点「复制影子观测摘要」→ 粘到本文件 §4 的记录表（或 _tmp/acceptance/a1-shadow-observations.md）
④ 若某天没开机/没数据 ⇒ 如实空着（⛔ 不补造）
```

CDP 备选（dev 开着、想批量读历史时）：

```js
// 只读：把最近 7 天的影子观测历史倒出来（⛔ 不含正文）
JSON.parse(localStorage.getItem("shuyonote:crdt-shadow-history") || "[]")
```

## 3. 判定口径（owner 拍板时用；待拍）

```text
必要条件（缺一不可）：
  · 连续 ≥7 天有记录（每天至少一次扫描；少于 7 天 ⇒ 不判）
  · 这 7 天的 **differUnexplained 合计 = 0**（"没有待合并、却投影≠CRDT" = 真正未知差异）
  · **uncomparable** 只允许来自"读失败"且已记录原因（读不到 ≠ 不一致，但也不许当 0 糊弄）

参考值（待 owner 拍）：
  · differ 允许来自 **differPending > 0**（已知噪声：有远端状态待合并）
  · 若 differUnexplained > 0 ⇒ **先查再谈灰度**（不许带着未知差异开默认）
```

## 4. 记录表（每天一行；判据按此核）

| 日期 | 空间/运行次数 | total | withState | equal | differ | differPending | differUnexplained | uncomparable | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-__ | | | | | | | | | |

## 5. 到期后的动作（2026-11-18 起）

```text
1) 汇总 §4：天数、differUnexplained 合计、uncomparable 合计/原因
2) 若 §3 的必要条件全满足 ⇒ 写一份「A1 灰度建议」给 owner（分批＋可回退，默认值由 owner 拍）
3) 若有未知差异 ⇒ 先把 differPageIds 逐页查清（只读），再重开 7 天窗口
4) ⛔ 任何"默认值改动"必须 owner 明确拍板 + 单独提交 + 可回退
```

## 6. 判据（这份 runbook 自己也要可核）

```text
· 记录表 ≥7 行且日期连续；每行的计数来自真实扫描（⛔ 不手填假数）
· 摘要里不出现任何正文/页面标题（只允许计数与 id）
· 到期建议里必须引用本表读数（⛔ 空口说"观察过了"）
```
