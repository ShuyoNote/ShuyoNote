# 冗余代码盘点：「个人版 ＋ 服务器同步」这条已废的路
> 状态：**已收口**（诊断）；**其 A 类已施工**。证据：`851c1a7b` 删 A-3/A-4；`0c7ad349` 撤邀请（见 `../specs/2026-09-29-nearby-devices-spec.md`）


> 依据：owner 重申「同步服务器不提供个人版」＋「没有真实用户，不用向后兼容；清理代价大就重新建库」
> ⇒ 本文件是**只读盘点**（未改任何文件），目的是**先定代价与边界，再决定删什么**。
> ⚠️ 落仓理由：盘点报告原本只在对话里 ⇒ **唯一副本风险**。

---

## 1. 一句话总评
```text
**这条已废的路在代码里占得很小** —— 约 **400~600 行**生产代码／删除面散布在 ~12 个文件
＋ ~20 份文档的文案面。**清理代价是「小」，不该用「重建」。**

★ 最关键的判断：**「个人空间 + 加密 + 绑服务器」在代码里从来不是一条独立的实现路径。**
  服务器那条路只有**一条**实现（`sync_workspace` / `do_push` / `do_pull` / `sync_profiles`），
  个人与团队的分歧**只落在一道闸门的其中一个分支**上。
  ⇒ 所以"废掉个人版走服务器" ＝ **删几个分支 ＋ 一个 UI 块**，**不是拆一条路**。
```

## 2. ⚠️ 四条必须先知道（其中两条纠正了我/裁定的转述）
```text
★① ⚠️⚠️ **`space_crypto.rs`（1406 行）不是"服务器同步加密"，是【按空间静态加密】**
     （SQLCipher 整库 ＋ 钥匙袋）。owner 的裁定**明文要保留**它
     （`virtual-lan-requirements-spec.md:202-209` 逐字：「**不是"个人版不加密"**，
       而是"个人版根本不经过服务器"」）
     ⇒ ⇒ **若不澄清这条，第一个被误删的就是它** —— 连同 18＋36 条判据与**个人空间的数据安全**。

★② ⚠️ **`sync_bind_gate` 不只管"绑服务器" —— 它长在【设备直连】的接受邀请那条路上**
     （`sync.rs:3273`，在 `nearby_invite_accept` 里）
     ⇒ ⇒ **这是本次最尖锐的矛盾**：裁定后个人版的**唯一**远程路径就是设备直连，
        而这道闸门会把"**未加密的个人空间**"拦在设备直连之外 ⇒ **与裁定直接冲突**
     ⇒ **要 owner 拍**（两个方向：撤掉那道闸门 ／ 或"个人版走设备直连也必须先加密"）
     ⚠️ 而它是**规格里点名的承重判据**（`nearby-devices-approach.md:72`
        「变异：把接受路径的 `sync_bind_gate` 调用去掉 ⇒ 必须红」）⇒ 撤它 = 撤一条判据 ⇒ 规格要同改。

★③ **服务器那条路【已经】按团队空间收口了**
     `sync_workspace`（`sync.rs:3764-3772`）在 **2026-09-02 的 `4d7c552b`** 就写死
     「**需绑定团队空间才能同步**（多设备同步不支持留空）」
     ⇒ ⇒ **owner 担心的"既有个人用户走服务器"可能并不存在**。
     ⚠️ 但要查真实存量只能查 `sync_profiles` 表并对照 `meta.workspaces.kind`（盘点者无权限）。

★④ **`SpacePrivacySection.tsx`（489 行）不能整删** —— 同期还有三件非本次的东西：
     ① **静态加密的唯一 UI 入口**（开启/关闭加密 ＋「我已保管好主口令」**勾选前置**；⚠️ 原先那行红字提醒 `PASSPHRASE_NO_RECOVERY` 已按 owner 2026-10-08 的要求删掉 ✓）
     ② **不经服务器的配对码换设备**（`:362-489`，与"经服务器搬钥匙袋"是两条不同的路）
     ③ 空间分类
     ⇒ 被废的只有"闸门裁决"那一支。
```

## 3. 四张清单（摘要；每条都带 `文件:行号` 证据）
### A. 确定可删（约 400~600 行）
```text
A-1 `space_crypto.rs:316-333` 的 `SpaceKind::Personal` 分支 ＋ `SyncGate::Blocked` 变体
    （真正消费 `Blocked` 的只有 3 个调用点；团队走 `Team => Allowed`，根本不进这个分支）
A-2 `sync.rs:1136-1154` `sync_bind_gate` 整个函数（2 个生产调用点 ＋ 1 条四支判据）
    ⚠️ 但 `sync.rs:3273` 那个调用点在【设备直连】上 ⇒ 见 §2-②（**不是清理的副产品，是显式决定**）
A-3 `sync.rs:2023-2100` `http_put_keyring` ＋ `:2063-2140` `http_get_keyring`（团队完全不用）
A-4 `push_space_keyring` / `pull_space_keyring` 两条命令 ＋ `commands.ts` 两个 CommandMap
    ＋ `api.ts` 两个包装 ＋ `SpacePrivacySection.tsx:327-360` 那一块
    ★ **最干净的第一刀**：删掉后"换设备"仍有别的路（`pairing_export`/`pairing_import`）⇒ **不留功能缺口**
    ⚠️ `check-web-commands` 双向校验 ⇒ Rust 与 CommandMap 必须同改
A-5 `docs/sync-server-data-boundary.md` 的 §0.5-2／§3.1 整张表（**隐私口径的唯一权威** ⇒ 改它一处，四份是指针）
A-6 `docs/plans/2026-09-23-encryption-scope-decision.md:20` 决定 3 的立项依据
```

### B. 要改不能删
```text
B-1 ★ 见 §2-②（`sync.rs:3271-3276` ＋ 两份规格里的承重判据）—— **要 owner 拍**
B-2 `invite_caveat`（`sync.rs:3213-3239`）：团队那支保留；"会被闸门拦住"那支随 B-1
B-3 `SpacePrivacySection.tsx:226/:250/:271` 三处文案 ＋ 两条断言
B-4 `workspaces.rs:203-266` ＋ `PageTree.tsx:805-830` 的"创建时问个人/团队"
    ⇒ 其**存在理由**（"sync_gate 对未分类一律放行 ⇒ 点两下就可能把该加密的空间同步上去"）消失了
    ⇒ 但 `kind` 列还有用 ⇒ **倾向保留 kind、只改文案**（拿不准）
```

### C. 要保留（★ 这张表防误删）
```text
★C-1 `space_crypto.rs`(1406) ＋ `keyring.rs`(493) ＋ `security.rs` 的载荷加解密
     ⇒ **按空间静态加密**，不是服务器同步加密；裁定明文保留（见 §2-①）
★C-2 `sync_profiles` 表 ⇒ 团队空间**与设备直连的 `mesh_scope`** 双向复用 ⇒ 删它同时打断两条路
★C-3 `useSyncStream.ts` / `sync_stream.rs`(882) / `syncMode` 档位 ⇒ 团队空间专有
★C-4 `SpacePrivacySection.tsx` 整个组件（见 §2-④）
C-5 `sync.rs:3755-3800` `sync_workspace` 的"需绑定团队空间才能同步" ⇒ **已经在执行裁定了**
C-6 `INV-AWARE-e2ee-not-applicable`（加密空间不发不收光标帧）⇒ 是**防位置泄漏**的隐私不变式，与是否上服务器无关
C-7 `mesh_*` / `lan_*` / `pairing.rs` ⇒ 设备直连本身（裁定把它推成个人版唯一远程路径，长期还要加）
C-8 `scripts/lib/gates.mjs` 的 `rust-no-sm-crypto` / `check-crypto-backend` ⇒ 守的是静态加密的构建通道
```

### D. 判据与文档的连带
```text
D-1 `sync_gate` 纯函数四支（`encryption-scope-decision.md:102` 状态 ✅）⇒ 收档后 `Blocked` 与 UI 那支一起删
D-2 `the_sync_bind_gate_blocks_only_personal_spaces_without_encryption`（`sync.rs:5936-5973`）⇒ **作废**
D-3 `the_invite_says_out_loud_...`（`sync.rs:5976-6012`）⇒ 改口径（依赖 B-1）
D-4 ★ 规格里那条"删掉接受路径的 `sync_bind_gate` ⇒ 必须红"（`nearby-devices-tasks.md:112` ＋
    `-approach.md:72`）⇒ **撤 B-1 就是撤它 ⇒ 规格必须同改，否则规格在说谎**
D-5 `INV-NEARBY-invite-has-no-keyring` ⇒ **不受影响**（A-4 删的是"经服务器搬钥匙袋"）
D-6 `INV-IPC-web-commands` ⇒ 删 A-4 两条命令必须同改 `CommandMap`（**机器会挡，安全**）
D-7 `check-doc-links` / `check-plan-status` / `check-doc-facts` ⇒ 文档改动会打到（A-6 要同步状态行）
D-8 §0.5「总口径」的下游四份 ⇒ **该文件自称唯一权威、其余只指过来** ⇒ 改一处即可；但逐字命中的**19 份文档**里
    `docs/SHUYONOTE_STATE.md`(3) 与 `README.md`(1) 是**用户可见**面，要单列
D-9 `check-invariants-pointers` ⇒ 若规格里**删掉** D-4 的描述则无事；若保留措辞而不换判据，它会红
```

## 4. 「如果重建」→ **我的判断：不需要**
```text
A 那批总代价「小」（~400-600 行、2 个命令、1 个 UI 块、3 条判据、~6 份文档实质改写），
远低于"重建 schema"的门槛 ⇒ owner 那句「代价大就重新建库」**这轮不该动用**。

若仍要重建，边界必须画成：
✅ **可以重建的**：`sync_gate`/`SyncGate`/`SyncGateView` 这整套**闸门抽象**（只剩一档 ⇒ 这层抽象不该存在）；
   `SpaceKind`/`kind` 列（若"创建时问个人/团队"也一并撤）。
❌ **不该重建的**：`sync_profiles` schema（团队 ＋ mesh_scope 双向复用）；
   `space_crypto`/`keyring`/`security` 的载荷加解密（静态加密地基）；`sync.rs` 的 do_push/do_pull/apply_pulled_changes。

⚠️ 「重建会不会顺手弄坏团队那条路」——**会，三个具体入口**：
   ① 重建 `sync_profiles` ⇒ 同时断 `mesh_scope`；② 重建 `space_crypto` ⇒ 断 `security::wire_keys_for_conn`
   （~~团队空间虽明文~~ **明文档虽明文**也要走它才拿到 `Ok(None)`）；③ 重建 `sync_gate` ⇒ 断 `invite_caveat`（在设备直连路径上）。
```

## 5. ⚠️ 最容易被误删的三处（点名）
```text
① **`space_crypto.rs` 整模块** —— 名字里有 crypto、注释大量写着"个人空间""服务端只落密文"，
   但它是**静态加密** ⇒ 删它 = 删掉个人空间的数据安全 ＋ 54 条判据。
② **`sync.rs:3273` 那次 `sync_bind_gate`** —— 容易被当成"闸门的第二个副本"顺手删；
   但它在**设备直连**路径上，是规格点名的承重判据 ⇒ 删它**确实是裁定想要的方向，但必须是显式决定**。
③ **`SpacePrivacySection.tsx` 整个组件** —— 它还有静态加密的唯一入口 ＋ 不经服务器的换设备。
（第 4 个：**`sync_profiles` 表**看着最像残留，其实设备直连的 `mesh_scope` 也在读它。）
```

## 6. ⚠️ 盘点者核不出来的（如实）
```text
① **"今天是否真有『个人空间＋加密＋绑服务器』的用户"核不出来** —— ⚠️ **这一格今天（2026-10-01）性质变了** ✓：
   ⭐ **owner 2026-10-01 一锤定音**：「**个人空间不绑服务器**」✓ ⇒ **口径已定，不再是未决** ✓；
   ⛔ 但**实现侧仍然没有拦** ✗ —— 代码里**没有任何东西强制**个人空间不能绑服务器
   （唯一运行期约束在服务端）；UI 只提供组织空间，但 `set_sync_profile`
   接受任意 `space_id` ⇒ ⭐ 所以现在要记的是「**口径已定、代码未拦**」这**一格待补** ✓，
   ⛔ 不是"两个答案" ✗（那句已废 ✓）。
   ⇒ **要查真实存量必须查 `sync_profiles` 表**并对照 `meta.workspaces.kind`（盘点者无权限）✗ —— **至今未查** ✓。
   ⚠️ 但 §2-③ 说这条路**已经在 2026-09-02 收口** ⇒ 实际可能已无此用户。
② `sync_gate` 的 `Blocked` 文案今天还会不会在 UI 上出现 ⇒ 依赖 ①。
③ `INV-AWARE-e2ee-not-applicable` **未实现**（规格自己写「❌ 无（要立）」）⇒ C-6 是按**规格意图**列保守项。
④ ⚠️ **闸门这块【没有注册门禁】** —— `gates.mjs` 的 46 条 id 里没有一条盯着 `sync_gate`/`sync_bind_gate`；
   承重**全靠 Rust 单测**（`sync.rs:5936`/`:5976`）
   ⇒ ⇒ **删 A-1/A-2 不会让任何门禁变红，只会让测试变红** ⇒「机器判据在这块是薄的」，owner 该知道。
⑤ `page_crdt` **不是**字段级密文（普通 BLOB）；个人空间的密文形态来自**整库 SQLCipher** ⇒ `page_crdt` 不用改。
⑥ `SpacePrivacySection` 里"不经服务器的配对码"在团队空间下是否仍该出现 ⇒ 规格没写，**拿不准**，倾向保留。
```

## 7. 行动建议（盘点者给）
```text
① **不要动 `space_crypto.rs` / `keyring.rs`**（C-1）
② **A-4（keyring 推送）是最干净的第一刀**（删后不留功能缺口 —— 已核）
③ ⚠️ **B-1 必须 owner 拍**再动 —— 它决定"个人版走设备直连要不要先加密"
④ 若只想**低成本兑现裁定**：**改 `sync_gate` 的 Personal 分支 ＋ 文档口径**就够了，**不必重建任何 schema**
```
