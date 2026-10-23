# 锁定态同步：把「同步要读空间库」换成「同步读一份密封副本」

状态：**施工中**（S1＝**不需要重构**（生产只有 1 个写入点）；S2「密封镜像」✅；S3a「一个打不开的空间不许把整扇门按死」✅ 真机验过；**S3b 的形状已定**（§7.1 能力协商 `caps=sealed1`，⛔ 不靠"旧对端自动忽略"）；S4 未开工）
证据：`../../src-tauri/src/sync.rs`（`record_change` / `mirror_change_to_mesh_outbox` / `prune_mesh_outbox` ／ 判据 `every_local_change_is_mirrored_into_the_mesh_outbox`）· `../../src-tauri/src/db.rs`（`mesh_outbox` 建表 ＋ `idx_mesh_outbox_age`）· `../../src-tauri/src/mesh.rs`（`ensure_window` 逐空间跳过 ＋ `window_serves` ／ 判据 `a_space_that_cannot_open_does_not_take_the_whole_window_down`）· `../../src-tauri/src/lan_state.rs`（公告按 `window_serves` 过滤）· `../../src-tauri/src/security.rs`（`encrypt_payload` `117` / `wire_keys_for_conn` `142` / `startup_needs_unlock` `312`）· `../../src-tauri/src/keyring.rs`（`wrap` `214` / `unwrap_key` `226`）· `../../src-tauri/src/space_crypto.rs`（`251` 那条「会话未解锁」）· `architecture.md` §同步（「锁定会话时拒绝同步」）· `2026-09-23-encryption-scope-decision.md` §3.3③

---

## 0. 一句话

同步今天**必须先开空间库**（库是 SQLCipher，钥匙由主口令派生、只在内存）。所以「锁定也能同步」不是补一个 `if`，
而是**换掉"同步从哪读"**：写入时（解锁态）就把变更**封好**放进明文库的旁路日志，锁定态只搬运密封包、
不产生也不消费明文，解锁后再应用。

## 1. 现状（读数与代码，都是可核的）

```text
· 空间库文件级加密：`PRAGMA key`（security.rs:254/316）；钥匙在钥匙袋里、由主密钥包着（keyring.rs:214/226）；
  主密钥只在内存 ⇒ 锁定 = 没有钥匙（space_crypto.rs:251 的报错文案就是它）
· 网格窗口**按空间开库**（mesh.rs:1595-1600），任一失败 ⇒ **整扇门这一轮不起**（lan_state.rs:793）
  2026-10-23 真机：保险柜未解锁 ⇒ 连报 5 次「窗口起不来…都不宣告」；输入口令后 18:16:15 才「网格窗口已启动」
· 同步载荷是**行级**的：空间库 `changes(seq, device_id, device_seq, entity, entity_id, op, payload, updated_at)`
  `payload` 是**明文 JSON**、躺在加密库里（实测：运营库 280 行，单条最大 156,714 字节）；**到 wire 上才封**
  （security.rs:117 `encrypt_payload`）
· 锁定态拒同步是**写明的安全闸**，不是漏做：
  architecture.md:132「定时：… 锁定会话时拒绝同步」
  2026-09-23-encryption-scope-decision §3.3③「袋里有它但锁着 ⇒ 报错 —— 没有钥匙若被写成原样放行，锁着就会明文上云」
```

⇒ 这两条（**同步要读库** ＋ **锁着不许产生明文**）合起来才是"锁定不能同步"的真因。要动，只能动前者。

## 2. 三个候选（含为什么否掉两个）

```text
甲  OS 钥匙串托管主密钥（DPAPI / Keychain / libsecret）
    · 锁定退化成"只锁 UI"，同步照常 ✓ · 改动最小 ✓
    · ⛔ 保护从「口令」降到「OS 登录账户」：同一台机器上任何能跑代码的进程都能拿
    · ⛔ 三条平台分支 ＋ 无头环境（本仓 2026-10-11 §3 丙 已否过一次，理由相同）

乙  给设备私钥再包一份「同步钥匙」
    · 零平台分支，最省事
    · ⛔ 设备私钥今天是**明文在 meta.db**（2026-10-11 甲 的既定选择）⇒ 能读 meta.db 就能解
    · ⛔ 等于把「加密空间」降级成「明文空间」—— 不接受

丙 ⭐ 密封外挂日志 ＋ 盲搬运（**推荐**）
    · 不动钥匙、不动钥匙袋、不动库格式；只改「同步从哪读写」
    · 锁定态**不需要**任何钥匙 ⇒ 安全性质不降级（见 §4）
```

## 3. 丙 怎么走（机制）

```text
写入（解锁态）
  ├─ 照旧写空间库 `changes`（payload 明文，库本身加密）
  └─ ⭐ 追加一条到 `mesh_outbox`（在 **meta.db**，明文库）：
       (space_id, device_id, device_seq, entity, entity_id, op, updated_at,
        sealed_payload, kdf_ver)
       sealed_payload = crypto::encrypt_str(payload, 该空间自己的钥匙)

锁定态（网格窗口）
  ├─ ⛔ **不打开任何空间库**（于是"一个锁着的空间把整扇门按死"这条一起消失）
  ├─ 服务：读 `mesh_outbox`，把同一批记录发出去（字节＝将来解锁后能应用的那些）
  └─ 收下：只写 `mesh_inbox`（meta.db，密封），⛔ 不应用、⛔ 不解密

解锁态（下一轮）
  ├─ drain `mesh_inbox` → `decrypt_payload` → 走**现有** apply / CRDT 路径（不新开合并语义）
  └─ 确认水位 → 裁掉 outbox/inbox 里已确认的条目（保留期见 §5）
```

要点：**outbox 是 `changes` 的镜像，不是第二份真相**。解锁后按 `(device_id, device_seq)` 去重（与 `changes`
的 `UNIQUE(device_id, device_seq)` 同一把尺）⇒ 重复应用幂等，崩溃后重来也安全。

## 4. 为什么不降级（安全性质，逐条）

```text
① wire 上仍是密文 —— 今天 already（security.rs:117）
② 盘上多出来的 `mesh_outbox` **只有密文**；明文 JSON 仍只在加密库里
③ 锁定态**不产生明文、不解密** ⇒ 「锁着不许明文上云」那条性质**一个字节没松**
④ 攻击面变化：多了一份"密文副本在明文库里"。它没有钥匙打不开 ⇒ 与今天的 wire 载荷同级
⚠️ 真正新增的是**元数据**：entity_id / op / 时间戳 / 载荷大小 / 变更频率会以明文落在 meta.db ⇒ 见 §6-①
```

## 5. 代价（不粉饰）

```text
· 写入路径：`INSERT INTO changes` 今天有 **7 处**（db.rs:2094 / mesh.rs:6257 / mesh_wire_bytes.rs:118 /
  sync.rs:346,8153,9064 / workspace_io.rs:914）⇒ 必须收敛成 1 个 helper，否则"有一条路忘了镜像"
  就是"那条路的东西永远同步不出去"（这类静默缺陷本仓吃过太多次）
· 磁盘：每条变更的载荷存两份（库内明文 ＋ 库外密文）⇒ 需定上限。基准：运营库 280 行 / 单条最大 157 KB
· 语义：锁定态是**搬运**，不是"能看见新内容"。UI 与文档必须写死这一条，否则用户会把"同步了"读成"能看"
· 合并时机推到解锁 ⇒ 长期锁着的机器会积压；必须有上限与"超限即响亮失败"，⛔ 不许静默丢
```

## 6. 已拍（2026-10-23，owner「照你的办」）

```text
① 元数据 —— 按建议收口：**封的是整条记录**（entity/entity_id/op/payload 一起），
   明文只留 `space_id / device_id / device_seq / updated_at / mirrored_at`
   ⇒ 明文库里没有页 id、没有 op。⛔ 不再需要"忍元数据"这个选项。
② 保留期 —— **7 天（已落地）** ＋ 体积上限 64 MB 与**水位裁剪**留给 S4。
   口径不变：它是搬运缓存不是备份 ⇒ 裁掉不丢数据；超限要**响亮**报，不静默。
③ 语义 —— **接受**「锁定＝搬运，解锁才应用」。要"锁定也能看内容"只有 甲（OS 钥匙串），代价见 §2。
```

## 7. 切片与判据（每片独立验收、可独立回退）

| 片 | 做什么 | 判据（先红后绿） | 状态 |
|---|---|---|---|
| **S1** | 把 7 处 `INSERT INTO changes` 收敛成 1 个 helper | —— | ✅ **结论：不需要做**（见下） |
| **S2** | 写入时封一份到 `mesh_outbox`（＋ 保留期按 7 天关掉） | `sync::tests::every_local_change_is_mirrored_into_the_mesh_outbox`：两次 upsert 同一页 ⇒ 镜像只剩 1 行、`device_seq` ＝ `changes.seq`、解回来是最新那份 ✓（明文空间原样过；密文空间"封得上"那一半归 S3 的真机判据） | ✅ 已落地 |
| **S3a** | `ensure_window` 逐空间开、**打不开的跳过**；公告按 `window_serves` 过滤（⛔ 不谎报） | 判据 `a_space_that_cannot_open_does_not_take_the_whole_window_down`（能开的在服务、打不开的不算在服务）＋ **真机前后对比**：同一天、同一个锁着的保险柜，改前连报 5 次「窗口起不来…都不宣告」，改后一行「这一轮**少服务一个空间**（其余照常）」＋「网格窗口已启动」，18:49:14 照常发现对端 ✓ | ✅ 已落地 |
| **S3b** | 窗口在**不开库**的情况下从 `mesh_outbox` 服务；收侧写 `mesh_inbox`（只存不应用） | 形状已定（§7.1 能力协商 `caps=sealed1`）：一端锁着 ⇒ 带 caps 的对端能拉到 sealed 行、`mesh_inbox` 有行、**双方空间库零变化**；不带的**一条都不发**（⛔ 不发一半） | ⬜ **未开工（形状已定）** |
| **S4** | 解锁后 drain ＋ 水位/体积裁剪 | 解锁后一轮 ⇒ 页出现在库里、两侧**块级投影一致**；超限路径有一条"响亮失败"判据 | ⬜ 未开工 |

> ⚠️ **S3b 的真实障碍（写在这里，免得下一轮重新发现）**：现在的 wire 记录是
> `{seq, device_id, device_seq, entity, entity_id, op, payload}`，`entity/entity_id/op` **在明文**、
> 只有 `payload` 是封的（`encrypt_payload`）。而 S2 的 outbox 为了不泄露元数据，把
> **整条记录**封成了 `sealed` ⇒ 锁定态的窗口**拿不出 `entity_id/op`**，照原格式发就是**编**。

### 7.1 ⭐ 探路结论（2026-10-23 实测读代码，owner 拍「先 3 再 1」）

**问**：老对端收到"不认识的记录"会怎样？能不能靠"它自己跳过"做成向后兼容？
**答**：**不能** —— 它会**跳过，但把游标推到批尾**：

```text
sync.rs:3955  `_` 那一支：不认识的 (entity, op) 只记一条 `unrecognized`，**照旧忽略**（F7b：不再无声）
sync.rs:4005  `if change.seq > max_pulled { max_pulled = change.seq }`
sync.rs:9498  判据 `unrecognized_entity_kinds_are_ignored_loudly_and_never_wedge_the_cursor`
              断言 `max_pulled == 5`（"游标必须走到批尾 —— 否则下一条读不懂的搭配就是死锁"）
⇒ 那个被跳过的 `device_seq` **永远不会再拉**；等对方升级，也补不回来（**静默丢一条**）✗
```

而且"推进游标"是**故意的**（否则一条读不懂的记录会把整条流卡死）⇒ ⛔ 不能改它来迁就我们。

⇒ **S3b 的形状定下来：能力协商，不靠"对方自动忽略"**：

```text
① 拉取请求带能力：`/mesh/pull?…&caps=sealed1`（新客户端总是带；老客户端不带 ⇒ 我们**看得出它不懂**）
② 服务侧分两种：
   · 空间库**开着** ⇒ 照旧从 `changes` 服务（今天的格式，老对端零感知 ✓）
   · 空间库**打不开**（锁着）⇒ **只给带 `caps=sealed1` 的对端**发 `sealed` 记录；
     不带的**一条都不发**、回一句明确的话（如 409「这一台锁着，且你不认识封包」）
     ⛔ 绝不"发一半"：游标会越过被扣下的那几条 ⇒ 那几条就永远丢了 ✗
③ 收侧：`sealed` 记录只进 `mesh_inbox`（meta.db，密封），**不解密、不落空间库** ⇒ 游标照常前进（它确实收下了）
④ 解锁后：drain inbox → 解密 → 走**现有** apply（S4）
```

这条形状的代价比"三方约同一版"低：**老对端不需要升级就先继续用**（只是它会看到一句"对端锁着"），
新对端一旦升级就自动享受"锁着也能搬"。⚠️ 但它仍然要求**两台新端**都懂 `sealed1` 才真正搬得动
（一台新一台旧 ⇒ 旧的那台在锁定态只能等）。

> ⚠️ **S1 的更正（我先前那个"7 处"是错的）**：按 `git grep -n "INSERT INTO changes"` 数出 7 处，
> 但逐处看上下文后：**只有 `sync.rs::record_change` 是生产写入点**，其余 5 处是 `#[cfg(test)]` 夹具
> （`db.rs:2094` / `mesh.rs:6257` / `sync.rs:8153` / `sync.rs:9064` / `workspace_io.rs:914`），
> 第 6 处 `mesh_wire_bytes.rs:118` 是 `#[tokio::test]` 探针（`--ignored` 才跑）。
> ⇒ **生产早就已经收敛过了**，S1 只剩一句结论 —— 把它写在这里，免得下一个人再"发现"一次。

> S3 落地时同步改 `architecture.md:132` 与 `2026-09-23-encryption-scope-decision.md` §3.3③ 的措辞
> —— 否则又变成"两份真相"（本仓最贵的那类债）。

## 8. 与当前那两条的关系

- **「一个未解锁的加密空间把整扇门按死」**：✅ **S3a 已修**（窗口逐空间开、跳过打不开的；公告只播真在服务的那些）。
  真机读数见 S3a 那一行 —— 同一个锁着的保险柜，改前整扇门不起，改后照常起来并发现对端。
- **「锁定能不能看见新内容」**：本方案的回答是**不能**，只能搬运（S3b）。想要能看 ⇒ §2 甲。
