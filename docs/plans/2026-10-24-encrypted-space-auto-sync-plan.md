# 加密空间「自动同步」（B1＋B2）实施方案

> **状态**：**实施中（P1/P2 已落：钥匙袋 v2 多组、解锁按组派生、公开材料交换合并、解锁后自动建加密空间；P3 锁着盲公告/对账未做）**。
> **一句话目标**：个人版两台设备之间，**加密空间也能像普通空间一样自动同步**；换新设备**不再手工导出/导入钥匙**，
> 用户只需要在新设备上**输一次主口令**。
> **安全红线**：网线上只传**公开材料**（盐/参数/密文盒子/空间名）；⛔ 不传主口令、⛔ 不传裸空间密钥。

---

## 一、为什么不能只靠"搬密文"

```text
加密空间的密钥 = 每空间随机的 32 字节，被"主密钥"包裹成盒子；主密钥 = 口令 ＋ 盐/参数派生。
两台设备各自第一次加密时盐不同 ⇒ 同一个口令在两台派生出不同主密钥 ⇒ 对端的盒子解不开。
⇒ 要"自动"，必须解决三件：① 公开材料要能自动到对端（盐/参数/盒子）；
   ② 解锁时按"每一组材料"各派生一次主密钥；③ 空间清单（名字/id）也要到，才能建同名空壳。
```

## 二、两条档位（本方案都做，先 B1 后 B2）

```text
B1 新设备（本机还没有任何盒子）：整体采纳对端的公开材料（它成为主组）⇒ 输一次口令即可解开全部空间。
B2 已有设备（本机有自己的盐/盒子）：对端材料作为**额外组**并入；解锁时按组各派生一次主密钥
   ⇒ 两边的空间都能开；同空间不同盒子（各自轮换过）⇒ **保留本地 + 报冲突**，⛔ 不静默覆盖。
```

## 三、已完成（P1，2026-10-24）

```text
1) 钥匙袋 v2（`keyring.rs`）
   · `Keyring { v:2, kdf, spaces, space_names, extra_groups: [{kdf, spaces, space_names}] }`
   · `from_json` 仍认 v1（只有主组），⛔ 不改老盐/参数
   · `merge_from(other) -> MergeReport`：同组补空间盒子；不同组整组收下；冲突保留本地并列出来
   · `space_names`：自动建同名空间要用的元数据（公开，不含内容）
2) 解锁按组派生（`space_crypto.rs` + `security.rs`）
   · `masters_from_passphrase`：一句口令 ⇒ 每组一把主密钥
   · `verify_masters_against_keyring`：**每组各验一次**（别只验主组）
   · `session_masters()` + `space_key` 用组指纹匹配；老路径（单主密钥）保留兜底
3) 公开材料交换（`mesh.rs`）
   · 服务面：`GET /mesh/keyring?space_id=…`（与 `/mesh/pull` 同一道鉴权；只回公开材料；没有就 `material:null`）
   · 取用面：`fetch_peer_keyring`（签名同 pull；老对端 404 ⇒ 当作"没有这一档"，不是错误）
   · 接线：每次成功拉取之后顺手取一次（**10 分钟节流**，失败只记日志、不影响同步）
   · `merge_material`：本地空袋 ⇒ 整体采纳（B1）；非空 ⇒ 并成额外组（B2）
4) 判据
   · `keyring::tests::merging_two_materials_keeps_both_groups_and_both_spaces_open`
   · `a_box_conflict_is_reported_and_the_local_box_is_kept` / `a_v1_material_still_loads_as_one_group`
   · `mesh::tests::the_keyring_endpoint_is_a_route_not_a_not_yet`
```

## 四、P2 已完成（2026-10-24）：解锁后**自动建**加密空间

```text
· `security::provision_spaces_from_keyring(dir, conn, masters)`：
  遍历钥匙袋里的空间 ⇒ 本地 meta **没有行**的：名字在 ⇒ 用盒子里那把空间密钥建 SQLCipher 空库
  ＋ meta.workspaces(personal/encrypted) ＋ 空同步档案行；下一轮后台轮就会像普通空间一样拉密文。
· 边界：已有 meta 行（含墓碑）一律不碰；没名字/盒子解不开/库文件已存在 ⇒ 跳过并记日志；
  加密空间**不按名合并**（身份就是那把钥匙，不做同名融合）。
· 接线：`unlock_encryption_impl` 解锁成功后调一次；运行中并入新公开材料后也调一次
  （`provision_from_current_session`），失败只记日志、不影响解锁/同步。
· 判据：`security::tests::provisioning_builds_an_encrypted_space_from_the_keyring`
  —— meta 行建了 / 库文件**头嗅探是密文** / 用盒中钥匙能打开且空库 / 再跑一次幂等。
```

## 五、还没做（P3）

```text
P2 自动建加密空间（B1 的"零操作"另一半）
   · 解锁成功后：遍历钥匙袋里的空间 ⇒ 本地没有的，用**盒子里那把空间密钥**建 `<本地空间>.db`
     （SQLCipher 加密）＋ meta.workspaces 行（personal/encrypted）＋ 空同步档案行
   · 判据：新设备输一次口令后，加密空间自动出现；随后后台轮自动拉密文并合并
   · ⚠️ 这一步要动"建库/元数据"路径 ⇒ 必须先在测试空间验，再对真实空间做
P3 锁着也能被发现/搬运
   · 锁着时只公告"我有一个空间，名字指纹＋可拉密文"（盲公告）；解锁后对账
真机验收（需要 owner 参与的那一步）
   · 两台设备：新设备配对 → 自动收到公开材料 → **用户输一次主口令** → 加密空间出现并自动同步
   · ⚠️ 主口令只有用户知道；机器无法替用户输（这是这条链路唯一的人工动作）
```

## 六、安全边界（写死）

```text
· 公开材料只发给**已配对**设备（`authorized` 同一道门）；未配对 401、空间不服务 403
· 不覆盖本地盒子：同空间不同盒子只报冲突；整份覆盖只能走显式 `adopt_material(overwrite=true)`
· 盒子与空间 id 绑定（既有）；坏材料/未知版本 ⇒ 拒绝且本机一个字节不改
· 主密钥只活内存；锁定/退出即清；日志只记"并了几组/几个空间/冲突几个"，不记材料正文
· 加密空间**不做锁着对账**、不做按名自动融合；「保险柜」类离线导出/导入仍保留为逃生通道
```

**依据/关联**：
`plans/2026-09-23-encryption-scope-decision.md`（三层钥匙袋模型）、
`plans/2026-10-23-sync-while-locked.md`（锁着时的密封搬运）、
`src-tauri/src/keyring.rs`、`src-tauri/src/space_crypto.rs`、`src-tauri/src/mesh.rs`。
