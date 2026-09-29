# 规格层复查结论：近三天 19 份文档（2026-09-27 ~ 09-29）

> 复查范围：14 份 spec ＋ 5 份 plan｜**只读**，未改任何文件｜行号以 HEAD `b354ac5f` 为准
> 结论：**9 🔴 / 11 🟡 / 6 🔵**
> ⚠️ **本文件是"发现台账"，修一条划一条**；它不是规格，别拿它当口径。

---

## 1. 总评（复查原话）

> 「这 19 份文档的**自我诚实机制**（待查表、变异证据配方、边界、留白）比绝大多数仓库好，
> 但它们的【**时态**】是坏的 —— 文档停在 09-29 13:35，而代码在同一天 13:47–15:11
> 把文档的**核心前提**改掉了，且几乎没有任何一份回头钉过一次行号或口径。」

三条理由：
1. **引用大面积漂移**：逐条核了 ~118 组 `文件:行号` ⇒ **约 70 条在 HEAD 上指不到它声称的东西**（40 条正确）。
   根因可复述：09-29 的实现提交（`daac8e1e`/`b354ac5f`）往 `sync.rs`／`lan.rs`／`lan_state.rs`／
   `mesh.rs`／`SyncPanel.tsx` 里**插进了代码**（例 `lan_state.rs:138`→`:245`、`sync.rs:3274`→`:3483`、
   `SyncPanel.tsx:1402`→`:1527`）。
2. **有一处不是"过期"而是"事实错误"**：`realtime-body` 三份建立在「局域网档默认 5 分钟、R-2 不成立」上，
   而 `d021948c`（**比文档晚 12 分钟**）已把局域网档改成 **5 秒**。
3. **判据层与文档层已分叉**：代码里长出 8 条新 Rust 判据 ＋ 3 条接线判据，而 spec 仍写「❌ 无（要立）」；
   反向，spec §12.3 要求"写进任务验收清单"的几何量测，**任务里不存在**。

---

## 2. 🔴 九条（会误导实现）

| # | 一句话 | 处置 |
|---|---|---|
| **R1** | ★ `realtime-body` 三份的核心前提**已被代码推翻**（文档说"默认 5 分钟／R-2 不成立／T3 等 owner 给数"，而 `PULL_INTERVAL_DEFAULT_MS = 5_000`） | 三处各加"⚠️ 2026-09-29 13:47 起已作废"；T3 删"等 owner 给数" |
| **R2** | `density-spec §2`「≥1280×800 **不该滚**」与 `nearby-spec §12.2`「**允许滚**」**直接对撞且未标**（代码注释已写"旧口径作废"） | density-spec §2 改成"允许滚、只许不增（基线 31）"＋加指向 |
| **R3** | `desktop-no-scroll` 的"实测值"三处不一致：文档 **141** ↔ 另一套桩 **116** ↔ **committed baseline 31**；且 §12.2 说"值从 0 改"，实为**新增键** | §12 三行几何换成 `b354ac5f` 提交信息那张表（547/547、637/606=31、779/606=173、610/606=4）＋标"门禁桩" |
| **R4** | "桌面 1280×800 要滚多少" **四份文档四个数**：density-req **111**／density-spec **711>606**／nearby-spec **141**／baseline **31** | 三处统一引用 `scripts/mobile-views-baseline.json` 的键值 |
| **R5** | `realtime-body-tasks` T0 要修的"既存红"**已经修好了**，却仍列在"先做、不修完全绿都是假的" | T0 降级为"✅ 已关（`d021948c`）"并摘出"先做" |
| **R6** | `LanStatus` 的契约已与实现不一致 —— 多出 `invites: Vec<LanInvite>`，而规格明写"不许扩张"（Rust 注释**自承**不在 §3.1 里；`LanInvite` 在 11 份文档里**零命中**） | spec §3.1/§3.2 补 `LanInvite` 逐字段，删与之冲突的"不许扩张" |
| **R7** | ★ 四份文档把 `scripts/criteria-mutations.json` 当"变异证据入账通道"，而**本仓没有这个文件**（只在 `repos/shuyo-community/scripts/`）；`INVARIANTS.md` 32 条一条都没用它 | 统一改成"本仓暂无此账"或**把文件建起来**（需定归属） |
| **R8** | `mcp-host-spec §2` 用了需求明文否定的字段名 `isWrite`（同批 kn-req 三处说"没有这个字段，看 `kind === 'write'`"，`TESTING.md:75` 把它列为门禁来由） | 那行改成 `kind === 'write'`（与已实现判据一致） |
| **R9** | `nearby-spec §12.3` 强制要求"写进任务验收清单"的几何量测，**任务文档里不存在**（`tasks` 全文 `Tauri`／`注入` 零命中） | tasks 补一条（T3 或新增 T8）；spec §12.3 改"已写进 T8" |

---

## 3. 🟡 十一条（会误导读者）—— 摘要

```text
Y1 §8.2 的订正确实消解了冲突（代码已核：`nearby_invite.rs:32`／`decode` 先按形状再查 v／
   `record_datagram` 先试邀请 ⇒ 三条断言逐条成立）；但 ① spec §5.2 无指向 ② §5.2 的【理由】已被推翻
   ③ 「分类不许靠 v」只住在需求里，应进 spec §2 的不变式表
Y2 spec 开头"只有两条有载体"与它自己的表矛盾（表里 4 行 ❌无），且 HEAD 上已全面过期 ——
   实况 one-source／invite-has-no-keyring／mesh-gate **三条都有能红的判据**（`sync.rs:6751`／
   `nearby_invite.rs:233`／`syncPanelMesh.wiring.test.ts:44-50`）
Y3 §6 待查 R1（"那 5 条接线判据住哪"）的答案就在本仓 ⇒ 划掉
Y4 需求 §9（"不做"表）里混了一条"✅ 已完成"；另一处出处指错（D3 在需求 §7，不在规格 §6）
Y5 tasks §1 说"方案 §2 顺序 A→B→C→E 必须串行"，漏了 D；而方案说 **D 独立**
Y6 spec §2 的变异配方有 2 条在 HEAD 指不到位（one-source 的 `sync.rs:3257`→`:3466`；
   反向保护那条被实现者**逐字否掉**，改用逐字节快照 `the_three_existing_readings_are_byte_identical`）
Y7 ★ "不许显示 0 台"这条纪律被两条**已发布**字符串违反：`SyncPanel.tsx:927` hero ⇒「本网段 0 台可用」；
   `web.ts:1558` 的 line ⇒「本网段发现 0 台」；`b354ac5f` 提交信息点名过但**没进文档**
Y8 `knowledge-and-agent-access-spec §2`「能跑 5 条」与它自己的表（9 行）、`docs/README.md:154`（0 条）三个数不一致
Y9 `mcp-host-spec §3` 的"六条/七条"混用（评审补已写在同一文件里，**未落地**）
Y10 `crdt-mixed-version-degradation §5①` 在 HEAD 上已不成立（"三者不一致、待拍板"——
    实况 `yDocBridge.ts:23-24` 与 kickoff:49 都已订正；且订正提交 `4dbd9ef2` **早于**本文档提交）
Y11 `realtime-body-req §5.1` 的 R-1 行自相矛盾（用**非默认档**去证明**默认档**；同节自己的注就否掉了）
```

## 4. 🔵 六条（文字瑕疵）—— 摘要
```text
B1 广播间隔：需求里"约 45 秒"与"30s／真机≈45s"并存；rb-req 只写 30s ⇒ 建议三处统一"不写数字"
B2 rb-req「sync_stream.rs（872 行）✅ 一致」⇒ HEAD **882**（"已验证"的读数也会过期）
B3 density-req 的行号双重过期（`SyncPanel.tsx:1243`→`:1531`；"网格设置块"已被 §9.1 改名为「局域网直连」）；
   `App.css:21911`→窄屏段实际 ~`:22148`
B4 `INV-CRDT-rust-agnostic` 只列三个名字（yjs/yrs/y-crdt），判据 `check-crdt-plane.mjs:64` 扫**四个**（多 `y_rs`）
B5 `INVARIANTS.md` 头"34 条" vs `specs/README.md:45`"28 条"；README 的 `INV-*` 27 vs 现 32
B6 `INV-NEARBY-mesh-gate` 口径写"复用同一条门槛"，实现是**靠嵌套**；`toContain` 咬不到"把子块挪出门槛外"；
   改名后 `SyncPanel.tsx:1524` 注释仍写「**网格**不需要服务端地址」
```

---

## 5. ⚠️ 复查**没跑**什么（不许读强）
```text
· **无 cargo** ⇒ 所有 `cargo test` 读数只是"测试名与代码文本在岗"，**没跑**
· `vitest` 因缺 `@rolldown` binding 起不来 ⇒ 所有 `.wiring.test.ts`／`syncMode.test.ts` **没跑**
· 真 Chromium（mobile 组）**没跑**
· `_workspace/mutation-evidence.json` 的 D2 证据**未逐条比 sha**
⇒ 唯一真跑的是 `node scripts/check-invariants-pointers.mjs` ⇒ **exit 0**
```

## 6. ⭐ 复查推荐"最该先修的三件"
```text
1 ★ **给 A 组八份的 `文件:行号` 加"钉在哪个提交"的抬头，并把已漂的机械重钉**（≈70 条）
   理由：**唯一会持续复发**的问题（实现每越过一次就再漂），且它同时污染另外三类。
   `sync.rs:3274`(→3483)、`lan_state.rs:138`(→245)、`SyncPanel.tsx:1402`(→1527) 这三条一错，
   `INV-NEARBY-one-source`／需求 §4.4／`INV-NEARBY-mesh-gate` 的判据就全都指不到位。
2 ★ **修 `realtime-body` 的「5 分钟 vs 5 秒」（R1）并就地作废 R-2 的结论**
   理由：**唯一会让执行者做错事**的错 —— 按现文档会去实现一条已落地的片，并漏掉真正缺的那半。
3 ★ **把 `INV-NEARBY-*` 五行按 HEAD 实况重打**（`❌ 无（要立）` → 已有/仍无）
   ＋ 把 `INV-UI-sync-panel-scroll-reachable` **从注释变成判据或从文档删掉**
   理由：判据层与文档层分叉的现场；4 条不变式其实**已有能红的判据**却因一行"❌ 无"进不了 `INVARIANTS.md`。
```

## 7. ⚠️ 复查**修正了本文件作者（macOS 侧）先前几处描述**（如实记）
```text
① 「门禁桩 116px」**只在折叠前成立** —— 改后是 **31**，而 31 才是 committed baseline
② ★ `scroll-reachable` 的真相比我说的**更坏**：不是"本仓脚本里根本没有"，
   而是**门禁自己的注释在声称它跑着**（`verify-mobile-views.mjs:1485`/`:1559` 写着"两条要一起跑"），
   却没有断言函数、没有基线键 ⇒ 这是 §12.3/§12.7 那一族（"它在注释里存在"）
③ `realtime-body` 三份不只"诊断旧"，是**前提被推翻**（见 R1）
④ 引用漂移量级：不是"两处"，是**约 70 条**（我估小了）
⑤ §8.2 的订正确实消解了冲突（复查核了代码），但还有 §3-Y1 那三件我没提
```
