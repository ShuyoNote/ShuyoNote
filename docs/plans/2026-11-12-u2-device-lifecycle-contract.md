# U2 设备生命周期（撤销）—— 契约草案（2026-11-12）

状态：**契约已拍板**（owner 2026-11-12：①A 撤销**立刻生效** / ②A 首刀**只做移出、不换空间密钥** / ③A 被移出方**如实说** / ④A 同名空间**不自动合并**，与既有 DEC-D=A 一致）；**片 1（文案＋被移出提示）已落地**
证据：既有实现 `../../src-tauri/src/sync.rs`（`device_unpair` / `device_unpair_at` / `device_unpair_served`）＋
`../../src/components/SyncPanel.tsx`（「不再信任」二次确认 ＋ `duUnpair`）＋
`../../src-tauri/src/mesh.rs`（撤销后拒绝的判据：`unpairing_one_device_only_stops_that_device` 等）
片 1（2026-11-12）：`../../src/lib/peerRemovedHint.ts`（「被移出 / 没配对」两种说法；⚠️ 名单为空时**两种都说**，
因为撤销会通知对端删卡）＋ `../../src/lib/peerRemovedHint.test.ts`（4 条）＋
`../../src/components/syncPanelRevokedHint.wiring.test.ts`（3 条）；
`tsc --noEmit` 0；全量 vitest 门禁 ✓；`check-hook-order` / `check-store-subscriptions` / `check-overlay-registry` 全绿
上位：[个人同步 2.0 需求](2026-11-08-personal-sync-2.0-requirements.md) §13.5 U2（"撤销后该设备**再也拉不到**新数据（有判据）"）
前置：[U1 邀请式配对](2026-11-12-u1-invite-pairing-contract.md) 已完成（撤销后要重新加入 ⇒ 走邀请/配对）

## 1. 目标与非目标

**目标**：把「移出设备」这条**人可见的保障**做成有判据、说得清楚的一条路：
撤销后该设备**再也拉不到新数据**；本机数据一个字节不删；界面如实说出**哪些做不到**。

**非目标**（本轮明确不做，别在实现里偷偷加）：
- ⛔ **密钥轮换**（换空间密钥、之后数据用新钥）—— 复杂度高（要处理其它设备取新钥、离线设备回来），
  owner 拍 ②A **只做移出**；换机迁移的"旧空间继续同步"仍走 U1 邀请到新设备，再撤旧设备。
- ⛔ **远程擦除**：已同步到对方设备上的副本**无法远程删除**（这是事实，必须在界面写明）。
- ⛔ 撤销要通服务器 / 撤销要对方同意（离线设备也照样撤，本机名单生效即可）。

## 2. 现状盘点（只复用，不造第二套）

| 能力 | 现状 | 判据（机器可核） |
|---|---|---|
| 撤销命令 | `device_unpair(workspace_id: Option, peer_device_id)`：删本机名单那一行 ＋ 从运行窗口摘卡 | `sync.rs`：`unpairing_a_personal_card_is_machine_wide_and_a_team_card_is_per_space` |
| **撤销通知对端**（真机 2026-11-12 查实） | 撤销时入队 `pending revoke`（`unpairing_records_a_pending_revoke_for_the_peer`）；对端在线 ⇒ 发 `GET /mesh/revoked`，对端 `handle_revoked` 把**本机那张卡也删掉**（所以被撤方本地名单会变空） | `mesh.rs`：`retry_pending_revokes`（72h 上限、老版本 404 如实放弃）、`handle_revoked` |
| 撤销后拒绝新连接 | 该设备下次请求 ⇒ 401（"没有登记过这台设备的公钥"） | `mesh.rs`：`unpairing_one_device_only_stops_that_device`、`merge_gate_d1_unpaired_device_is_refused` |
| 只撤一台、别人不受影响 | ✅ | 同上 ＋ `unpairing_records_a_pending_revoke_for_the_peer` |
| 撤销后不被迁移带回 | ✅ | `sync.rs`：`a_migration_never_resurrects_a_device_the_user_unpaired` |
| 界面入口 | 「附近的设备」已信任卡上「不再信任」（`nearby-unpair`）＋ 二次确认 | `syncPanelDeviceUnpair.wiring.test.ts`、`SyncPanel.trustDevicePanel.wiring.test.tsx` |
| 文案口径 | 现行："不再信任后，这一台拉不动你的内容了；笔记和附件一个字节都不会删。想再连要重新配对一次。" | `syncPanelDeviceUnpair.wiring.test.ts` ②（钉"重新配对"） |

## 3. 契约条目

- **C1（立刻生效）** 点确认后**当场**生效：命令成功 ⇒ 该设备**下一次**请求即 401；⛔ 不设宽限期；
  ⛔ 不"先停后用"；二次确认未通过 ⇒ **一个字节都不发**（现状已如此）。
- **C2（只做移出）** 撤销**不改空间密钥**：已同步到对方的旧数据**不可回溯保护**；
  想保护"之后的数据"需换密钥（本轮非目标，界面如实说）。
- **C3（代价说明）** 二次确认文案必须**同时**含三句：
  ① 它拉不动你的内容了；② **笔记和附件一个字节都不会删**；③ 想再连要**重新配对/邀请**；
  ④ ⭐ 新增（本轮补）**已同步到它上面的副本删不掉，本机也无法远程擦除**。
  ⛔ 不许用 Markdown `**`（纯文本确认框里会显示星号）；⛔ 不许出现裸设备号。
- **C4（被移出方如实说）** 被撤设备再拉取失败时，界面必须**说清楚**这是"不再被信任"，
  ⛔ 不许只说"同步失败/网络错误"（那会让人反复排查网络）。⚠️ 真机 2026-11-12 查实：
  撤销**会通知对端并删掉对端的卡** ⇒ 被撤方本地名单变空 ⇒ **"名单里没有它"分不出"没配对过"与"被移出"**；
  ⇒ 文案必须**同时覆盖两种**（"可能从没配对过，也可能对方已把这台设备移出；如果之前配对过 ⇒ 对方已撤销"），
  并在"本机名单里还有它"时用更确定的"已被移出"那句。判据：源码级＋真机（见 §4）。
- **C5（重新加入必须邀请）** 被撤设备要回来 ⇒ 必须**重新配对/邀请**；⛔ 不许自动恢复；
  迁移/换机不得把已撤设备带回（现状判据已钉，保持）。
- **C6（不留材料）** 撤销只动名单/卡；⛔ 不写密钥材料、⛔ 不改 `space_uid`、⛔ 不删本机数据。
- **C7（幂等）** 重复撤销同一台 ⇒ 如实回"这一台本来就不在名单里"（现状已有），⛔ 不报错炸掉。

## 4. 本轮的缺口（要做的三件）

```text
① 文案：二次确认补上「已同步副本删不掉 / 无法远程擦除 / 本轮不换密钥」——只有 C3 的 ④（②③已写）
② 被移出方提示：拉取 401 时区分「从未配对」与「曾被信任但已被移出」，后者给可执行的下一步（重新邀请/配对）
   落点：`src/lib/` 的同步失败文案 ＋ `src/components/SyncPanel.tsx` 附近读数；⛔ 不新造同步路
   判据：源码级 wiring（禁止只写"同步失败"）＋ 真机（§5 片 2）
③ 真机验收：Windows 移出 AMD ⇒ AMD 再拉取 **401**；AMD 侧提示如实；重新加入必须走邀请
```

## 5. 施工切片

| 片 | 内容 | 判据 |
|---|---|---|
| 1 ✅ | 文案补 C3④ ＋ 被移出方提示（C4） | 新增 `peerRemovedHint.test.ts` 4/4 ＋ `syncPanelRevokedHint.wiring.test.ts` 3/3（源码级）；`tsc --noEmit` 0；全量 vitest 门禁 ✓；`check-hook-order` / `check-store-subscriptions` / `check-overlay-registry` 全绿 |
| 2✅ | 真机：Windows「不再信任」AMD ⇒ 日志/读数（AMD 拉取 401；AMD 侧提示；重新邀请后恢复） | 两侧日志原文 ＋ 时间线（≤1 分钟为提示出现目标） |
| 2a ✅ | 真机第一半（2026-11-12 14:38:20.965）：`device_unpair` ⇒ 对端拉取**立刻 401**（原文："没有登记过这台设备的公钥（没被信任过，或已被逐台解除）"）；对端侧 `peer-removed-hint` **真机出现**（但走了"没配对过"文案 ⇒ 见 2b） | 两侧日志原文（我方 `入站拉取 ⇒ 401`；AMD reply-3 侧 401 原文） |
| 2b ✅ | 真机抓到并修复的方案漏洞：撤销**会通知对端并删对端的卡**（`pending revoke` → `GET /mesh/revoked` → `handle_revoked` → `device_unpair_served`）⇒ 被撤方名单变空 ⇒ "名单里没有它"分不出"没配对/被移出"；文案改成两种都说（`747fe90f`），判据 7/7、tsc 0、全量 vitest ✓ | `mesh.rs` 代码链 ＋ AMD reply-3 的 DOM 原文 |
| 2c ✅ | 真机第二半 —— **恢复**（2026-11-12 15:20）：双方各用**方法 A**（生成时 peer 绑定）写回对方卡；我方 `mesh.paired` 含 `4b345a0a`（addedAtMs 15:00:40.841）⇒ 我拉对端 `ok fetched=0 applied=0 cursor=185`（不再是 401）；对端拉我方 `since=254/255 ⇒ 200`、`pk_for_dev=true`；我方保存 marker `U2-RESTORE-1794468054501`（15:20:54.501）。对端 applied 读数由 AMD 在 reply-7 报 ⇒ 见交接单/信件 | 我方日志原文 ＋ mailbox reply-6（`b75d3c57`） |
| 3 | 收口：契约状态/交接单/implementation-status 记录 | `check-plan-status`、`check-doc-links` |

## 6. 风险与回滚

- 风险：把 401 的"从未配对"与"被移出"混成一句 ⇒ 用户被误导（这正是 C4 要防的）。
- 回滚：本刀只动文案与提示（不改命令/不加密钥操作）；出问题改回文案即可，**没有数据迁移**。

## 7. owner 拍板记录（2026-11-12）

```text
① 撤销生效方式：**A 立刻生效**（B 24h 宽限 / C 两步走 未选）
② 首刀范围：**A 只做移出、不换空间密钥**（B 移出+换钥 未选）
③ 被移出方界面：**A 如实说"已被移除，需要重新邀请"**（B 只说同步失败 未选）
④ 同名空间：**A 不自动合并**（与既有 DEC-D=A 同向；本项不改代码，只记口径）
```

## 8. 判据清单（落地时逐条核）

```text
· cargo test --lib（过滤 unpair/revoke）≥ 现有条数、全绿（不允许减断言）
· 撤销后 401：既有 mesh 判据保持绿（unpairing_one_device_only_stops_that_device 等）
· 新增：被移出提示的源码级判据（禁止"只写同步失败"；必须给"重新邀请/配对"）
· 新增：二次确认文案含 C3 四句（纯文本、无 **、无裸设备号）
· 真机：Windows 移出 AMD ⇒ AMD 拉取 401 ＋ AMD 侧如实提示 ＋ 重新邀请后恢复
· 文档：本契约状态/证据可核（check-plan-status）、交接单同步
```
