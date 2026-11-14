# A1 影子比对 `equal=0` 根因定位（2026-11-14，只读诊断）

状态：**已定位（只读诊断）**；修法**待 owner 拍**（A/B/C 三选一）；⛔ 在修好前 7 天观察数据**不可用于 A1 灰度判定**
上位：[A1 影子观察 runbook](2026-11-13-a1-shadow-observation-runbook.md) ／ [需求 §13 A1](2026-11-08-personal-sync-2.0-requirements.md)
证据：代码路径 `../../src/lib/crdtShadow.ts`（canonicalJson 比对口径）＋ `../../src/lib/crdt/yDocBridge.ts`（`projectStateToJson` 投影实现）；
临时诊断（已删除的临时 vitest，只读、不打印正文）—— 取我方个人空间 0ea903fc（运营）**12 页**，
逐页比较 `canonicalJson(落盘 content_json)` vs `canonicalJson(projectStateToJson(page_crdt.state))`：
12/12 `equal=false`；所有页 `storedLen` 比 `projectedLen` 大数百字节；结构摘要显示**唯一系统性差异**：
落盘 block 带 `blockRev` 键，而 **CRDT 投影不带 `blockRev`**（其余键相同、`rootKids` 数相同、首块文本相同）。

## 1. 结论

```text
影子比对的"相等"是把**落盘元数据 `blockRev`** 也算进内容差异里：
  · 落盘 content_json：每个 block 有 `blockRev`
  · CRDT 投影 projectStateToJson：**不产出 `blockRev`**
⇒ canonical 字符串必然不同 ⇒ **equal 永远 0、differ 永远≈全部**
⇒ 近 6 天历史（11-09…11-14）里 equal=0 / differ≈49 不是"内容真的都不一致"，
   而是**口径系统性偏差**；`differUnexplained` 也因此不可信。
⇒ **7 天影子观察窗口目前是无效数据**，A1 不能据此开灰度（11-18 不能收口）。
```

## 2. 修法选项（owner 拍）

```text
A. **比对前归一化掉元数据键**（白名单排除 CRDT 不携带的字段，如 `blockRev`），只比内容结构。
   改动最小、立刻可用；代价：会掩盖"rev 不一致"这类差异 → 可另设一条单独读数（推荐先做这个）。
B. **把 `blockRev` 纳入 CRDT 投影**（投影也带 rev）。更彻底，但改投影/同步语义，风险大，需要 ADR。
C. **重定义"内容等价"**（结构＋文本＋属性，忽略 rev 元数据），同时另开"rev 一致性"读数。
⇒ 我建议 A（或 A+C 组合）：先让影子读数恢复意义，再把 rev 差异作为独立读数单列。
```

## 3. 判据（修好后要能看到的读数）

```text
· 修好后日读数里应出现 **equal > 0**（或至少 differ 只来自真实内容差异，且能给出原因分类）
· 归一时**只允许**排除明确列举的元数据键（写死在纯函数里 + 判据钉住），⛔ 不许"整体模糊匹配"
· 重跑 7 天窗口后再谈 A1 灰度；⛔ 旧数据作废（已在 runbook 里标注）
```

## 4. 附录：诊断读数（12/12 页，节选）

```text
page fb127857: storedLen=173931 projectedLen=173912 equal=false；首块键差：落盘有 blockRev / 投影无
page 45aeb5c3: storedLen=60678  projectedLen=60660  equal=false；同上
page af80f6a0: storedLen=53280  projectedLen=52006  equal=false；同上
page dc01dad2: storedLen=150410 projectedLen=148646 equal=false；同上
（其余页同形；所有页 rootKids 数相同、首块文本相同 ⇒ 差异只在元数据）
```
