# CRDT 混版本共存与降级策略（阶段 2 · 前置③，2026-09-29）

> **上位**：[阶段 2 开工清单](../plans/2026-09-23-crdt-stage2-kickoff.md) §2 前置③（原文：「**混版本降级策略要进设计**（不是实现细节）｜ ❌ 未写」）；
> [全量 CRDT 冲刺计划](../plans/2026-09-18-crdt-full-migration-plan.md) §3 阶段 2；[尖刺结论](../plans/2026-09-19-crdt-spike-conclusions.md)。
> **形状**：本文不是散文 —— 每条决策都写成**规则**（**判据 ／ 命令 ／ 反例 ／ 过期条件**，缺一不算 —— 见
> [`_workspace/HOW-TO-WRITE-A-RULE.md`](../../../../_workspace/HOW-TO-WRITE-A-RULE.md)）。凡标「能跑吗＝能」的，判据必须真实存在且已注册 ⇒ 由
> `scripts/check-invariants-pointers.mjs` 机械核（**含本文的 `INV-CRDT-*`**）。

## 1. 结论先写（三步说清"混版本时谁读谁"）

```text
① **权威落盘形态永远是 `pages.content_json`（TEXT，JSON）** ✓ —— 老客户端只认它，**永远读得到、永远能写** ✓
② **CRDT 状态另存旁路表**：`page_crdt(page_id, state BLOB)` ／ `page_crdt_pending(page_id, seq, state BLOB)` ✓
   —— **不塞进 `content_json`** ✓（塞进去 = 老客户端解析失败 ✗，那就没有"共存"可言了）
③ **Rust 侧不认识 CRDT**（只做字节进/出）✓；合并只在 **WebView 里那份 TS 实现**（`mergeRemotePageState`）✓
⇒ 于是"降级"不是一个开关，而是**两侧可以各自照常工作** ✓：老客户端看不到 ①②③ 的存在，新客户端额外合并 BLOB ✓
```

## 2. 降级矩阵（四象限，每格都有**期望**与**判据**）

| 写方 → 读方 | 老客户端读 | 新客户端读 |
|---|---|---|
| **老客户端写** | `content_json` 有内容 ✓ 照常 | `content_json` 有内容 ✓；`page_crdt` 可能**没有**该页状态 ⇒ **以 `content_json` 为准**、不报错 ✓ |
| **新客户端写** | `content_json` **仍是合法 JSON** ✓ ⇒ 照常读、照常写（可能丢 CRDT 元信息，**不许报错** ✗） | `content_json` ＋ `page_crdt.state` 合并 ✓ |

**反例（这是矩阵存在的理由 ✓）**：把 ydoc 的二进制塞进 `content_json` ⇒ 老客户端 `JSON.parse` 抛错 ⇒ **整页打不开** ✗
**过期条件**：若将来 `content_json` 的**列类型**不再是 TEXT（例如改成 BLOB）⇒ 本节立刻过期，必须重写 ✓

## 3. 两侧分工（各自的"不许做的事"）

```text
Rust（`src-tauri/`）：
  · **不许引入 Yjs 实现**（不认 CRDT 格式 ✓）—— 判据：`src-tauri/**/Cargo.toml` 里没有 `yjs`／`yrs`／`y-crdt` 依赖
  · 只把字节收进 `page_crdt_pending`，**不在 Rust 里合并** ✓
  · ⚠️ **按 `seq` 逐条留**（不是每页一行）：服务端 pull 不回 `device_id`，不同设备的**全量**状态互相不包含对方的编辑 ⇒
    "每页一行"会**真丢** ✓（这一条写在 `db.rs:1044` 附近的注释里，本文只是把它升成规则 ✓）
TS（`src/lib/crdt/`）：
  · `content_json` ⇄ `ydoc` 的**唯一实现**是 `yDocBridge.ts`（Slice A ✓）—— 判据：全仓只有它导出/调用
    `contentJsonToYDoc` / `yDocToContentJson`
  · 合并的**唯一实现**是 `mergeRemotePageState` ✓（不许在别处长出第二份合并 ✗）
```

## 4. `INV-CRDT-*`（本文的不变式表；**「能跑吗」那一格是承诺，不是愿望** ✓）

| # | 口径（不变式） | 判据（会红的那个） | 会红证据 | 今天能跑吗 | 渠道 |
|---|---|---|---|---|---|
| **INV-CRDT-json-authoritative** | 权威落盘形态是 `content_json`（**TEXT**，JSON），CRDT 状态**只**进 `page_crdt`／`page_crdt_pending`（**BLOB**） | `check-crdt-plane` | 见账本 | **能**（`check-crdt-plane.mjs`） | contract 组 |
| **INV-CRDT-rust-agnostic** | Rust 侧不引入 Yjs 实现（不认 CRDT 格式） | `check-crdt-plane` | 见账本 | **能**（`check-crdt-plane.mjs`） | contract 组 |
| **INV-CRDT-single-converter** | `content_json` ⇄ `ydoc` 的转换**只有一份实现**（`yDocBridge.ts`） | `check-crdt-plane` | 见账本 | **能**（`check-crdt-plane.mjs`） | contract 组 |
| **INV-CRDT-pending-per-seq** | 待并的远端状态**按 `seq` 逐条留**（不是每页一行 —— 否则丢编辑） | 无（**待立**：需要一条会红的判据，形状是"同一 page 两条 seq 都留"） | — | **待立** | — |
| **INV-CRDT-old-client-reads** | 老客户端读到**新客户端写过的**页必须成功（不许因缺字段/多字段而失败） | 无（**待立**：需要真机或 e2e 通道；本机只能写"矩阵"） | — | **待立** | — |

## 5. 未决（照实写，别假装策略是完整的 ✗）

```text
① **`yjs` 的依赖口径不一致**（本文写作当天实测）：
   `package.json` 把 `yjs@13.6.32` / `@lexical/yjs@0.50.0` 放在 **`dependencies`** ✓，
   而 `src/lib/crdt/yDocBridge.ts:22` 的注释写着「钉死在 **devDep**」✗，
   阶段 2 计划 §47 也写着「**不升格为生产依赖**」✗ ⇒ 三者不一致 ✓（已记台账 **R71**，**待拍板**）
② **`page_crdt` 与 `content_json` 的优先级**：现在写的是"新客户端合并"✓，但**合并后是否回写 `content_json`** ✗
   —— 关系到"老客户端下一次保存会不会把新内容覆盖掉"✗ ⇒ 这是**真问题**，本文不给答案（没有读数 ✓），
   **必须在 Slice B（保存/加载能选走 ydoc）之前定** ✓
③ 真机双设备验收（S7-3）与 E2EE 加密快照**不在本文范围** ✓（各有上位件 ✓）
```
