# 交接：隐私边界（个人空间 E2EE / 团队空间明文）落地进度（2026-09-24 夜）

> 写给**下一个会话**（或睡醒后的 owner）。上位口径：[数据可见边界](../sync-server-data-boundary.md) **§0.5**；
> 落法：[加密作用域决策稿](2026-09-23-encryption-scope-decision.md)（含顺序 0→1→2→3→4）；
> 第 0 步细节：[钥匙袋施工单](2026-09-23-keyring-step0-workorder.md)。
>
> 本文件只讲**"现在到哪、下一步动哪里、有哪些坑"**，不重复口径本身。

## 1. 现在到哪（都已推 `origin/dev`）

| 片 | 内容 | 提交 |
|---|---|---|
| 第 0 步 0a | **钥匙袋**：`keyring.rs`（包裹/解包/轮换/公开材料；复用 `crypto` 的 AEAD）＋ 5 条判据 | `3b1fb21d` |
| 第 1 步 1a | **按空间取钥匙**（开库路径）：`space_crypto.rs`（空间 id 从库文件主干反推、袋子进 meta、会话存主密钥）＋ `key_space_conn` **袋子优先、旧路兜底** | `051a0d3c` |
| 第 1 步 1b-1 | **wire 载荷按空间**（`encrypt_payload`/`decrypt_payload`）：袋里有它但锁着 ⇒ **报错**，绝不静默放明文 | `54fc18ab` |
| 第 1 步 1b-2a | **按空间启用/禁用**（`enable_space`/`disable_space`，只动那一个空间；连接开着它时先让开）＋ **按空间状态**挂进 `encryption_status.active_space` | `36ff643a` |
| 第 2 步 | **同步闸门**：`space_crypto::sync_gate`（纯函数）＋ `sync::sync_bind_gate` 接进 `set_sync_profile`；分类标记 `meta.workspaces.kind` | `e0563d50` |
| 交接 | 本文（进度 ＋ 施工点 ＋ 纪律） | `2f9f1579` |
| 第 2 步补 | 闸门裁决做进状态命令（`active_space_gate`） | `14893b9d` |
| 第 1 步 1b-2b | **`encryption_enabled` 按空间**（这个连接的库是密的 **或** 袋里有它）＋ **启动闸门改成嗅活动空间的文件**（`security::startup_needs_unlock`） | `63fc5506` |
| **A=3** | owner 拍板"分类由入口决定" ⇒ 本地新建空间标 `personal`（`workspaces::insert_new_local_space`）＋ **D 的 KDF 实测读数**（8 秒大头在 SM3 那条腿） | `4fa9d6d4` ⚠️ **只在本地，推送被 TLS 挡住**（见 §6） |
| 第 1 步 1b-2c | **按空间启用/禁用的命令面**（`enable_space_encryption` / `disable_space_encryption`；Web 侧登记**桌面专属**）＋ 顺手把 `disable` 的载荷从 `PageStateArgs`（`page_id`）换成 `SpaceIdArgs`（`space_id`） | `988d756f` |
| **②b 后端** | **分类的手动出口** `set_space_kind`（命令面**窄进**：只认 3 个值，别的串报错）＋ **一次读全的隐私读数** `space_security_overview`（`SpaceSecurityView`：分类 ＋ 加密状态 ＋ 闸门裁决；**未分类照样列出来**）＋ 判据 1 条（14/14 绿） | 本轮（见 §2 第 3–4 条） |

### 6. ✅ 2026-09-24 推送事故：**已恢复**（瞬时，非我们这侧）

`git push origin feat/crdt-json-ydoc:dev` 曾连续失败约十分钟：

```
schannel: SEC_E_UNTRUSTED_ROOT (0x80090325)          ← 默认后端
SSL certificate problem: EE certificate key too weak ← -c http.sslBackend=openssl
```

**两个后端都失败** ⇒ 判为**服务端证书链**的瞬时问题（不是本地代理、不是我们的代码）。
**处置**：**没有**用 `http.sslVerify=false` 绕过（那等于关掉 TLS 校验），而是**隔几分钟重试** ——
随后同一条命令**一次成功**（`63fc5506..05a56890`）。⇒ 教训：这类 TLS 失败**先重试**，别急着改配置；
真要做诊断再看 `curl -v` 的证书链，不要动校验开关。

### 7. owner 2026-09-24 的六条拍板（已按此执行）

| | 拍板 | 落地情况 |
|---|---|---|
| **A** | **3**（分类由入口决定） | ✅ 本仓＝个人版入口 ⇒ 本地新建 = `personal`（团队空间由团队流程标 `team`）。**存量空间仍 `''`（未分类）⇒ 照旧放行** |
| **B** | **甲**（加密的个人空间在 Web 上**直接不能开**，绝不许降级明文） | ✅ **已做**：新纯模块 `src/lib/ciphertextSniff.ts`（`looksLikeCiphertext` 认 `base64(magic=0x53\|version)`，版本只认 1/2，四条"不猜"）＋ `ciphertextRefusalMessage()` 单一措辞；接线 `web.ts::applyChange` **在解析载荷之前**抛那句可操作的话（今天是把密文当坏 JSON ⇒ 抛 `Cannot read properties of null`）。判据 4 条（含**位置比较**的文本级接线判据） |
| **C** | **1**（存量迁移：**报错** ＋ 说清怎么办） | ✅ **两半都做了**：**第一半** `migrate_legacy_space_into_keyring`（旧应用级钥匙原样装袋 ⇒ 空间钥匙 == 旧钥匙 ⇒ **库文件一个字节不动**）；**第二半** `rotate_legacy_space_to_random_key`（**先备份** `<space>.db.pre-rotate.bak` ⇒ 旧钥匙解密到明文 ⇒ 新随机钥匙加密 ⇒ 换盒子；任一步失败 ⇒ **停住报错**并说清备份在哪、库未被破坏）。判据：第一半 4 条 ＋ 第二半 1 条（钥匙真换／备份在／**数据没丢**／**旧钥匙打不开**） |
| **D** | 实测后决定 | ✅ 已出读数（决策稿 §7.2）：今天解锁 **~8 秒**，其中 **~7 秒在 PBKDF2-HMAC-SM3 200k 轮**（纯 Rust、无硬件加速；**不能随手调小**）；256 MiB/t=4 单独就要 **20 秒** ⇒ 取舍的是**两条腿的总预算**；改 `SM_KDF_ROUNDS` 会让**存量 v2 解不开** ⇒ 0a-2 必须把 SM 迭代数纳入"随袋子存的参数"。⚠️ **低端 Android 还没量**（§6：本机 `adb devices` 无设备 ⇒ 如实记为**未做，需真机**） |
| **E** | **你做，任何时候可以** | ★ **`shuyonote-sync-server` 就在本机**（`C:\Users\cnzen\zhai\shuyonote-sync-server`）⇒ 0b 可做（服务端加"公开材料的存放/取回"） |
| **F** | 按建议 ⇒ **不做**「用对端」 | ✅ 不排期 |


**当轮 tip 读数**（②b 后端这一轮，提交后即 `origin/dev`）：Rust 全量 **579 passed / 0 failed / 18 ignored**
（`test exe exit code = 0`，313.8 s）；vitest 全量 **214 文件通过 / 2198 passed / 12 skipped**（exit 0，186.0 s）；
`npx tsc --noEmit` 0；`pnpm run build` 0；`check-web-commands` 绿（**Rust 255 / web 249 / 契约 257**）；
doc 门禁 138 篇 / 863 条链接 / 84 篇方案 / 44 条 / 562 处（基线 562 未动）。
（上一轮树上的旧读数，作为对照：Rust 572 / vitest 2194 / 137 篇。）

## 2. 下一片：~~1b-2b~~（**已完成**：开关与启动闸门按空间；剩下的是"命令面/UI"与"分类来源"）

1. ~~**启动闸门**~~ ✅：`src-tauri/src/db.rs`（原来 `if enc_on && !session_has_key()`）已改成
   `security::startup_needs_unlock(&space_db_path(dir, &active))` —— **嗅活动空间自己的文件**。
   后果：**明文空间（例如团队空间）不再因为"别的空间开着加密"被拦在解锁屏后面**（有单测：
   `per_space_switch_and_startup_gate_look_at_the_space_itself`）。
2. ~~**`security::encryption_enabled(c)`**~~ ✅：改成"这个**连接**对应的空间是加密的吗"
   （库文件是密的 **或** 袋里有它），旧的应用级标志作为**兜底**保留（老库/老用户照旧）。
3. ~~**按空间启用/禁用的命令面**~~ ✅（`988d756f`）：`enable_space_encryption` /
   `disable_space_encryption`（`commands.rs` ＋ `lib.rs` 注册 ＋ 契约 ＋ `api.ts`）；
   Web 侧登记进 `DESKTOP_ONLY_COMMANDS` 并写清理由（Web 无钥匙柜，加密空间由 `ciphertextSniff` 明确拒收）。
   ⚠️ 顺手把 `disable_space_encryption` 的载荷从 `PageStateArgs`（字段名 `page_id`）换成新的
   `SpaceIdArgs`（`space_id`）—— 名字与语义不符的载荷会被后来的人照着抄。
4. **UI**（**待做**，可后置）：设置面板里"这个空间加密/不加密" ＋ "个人/团队"分类（分类是闸门的输入，见 §3）。
   **后端已就绪**（本轮）：`set_space_kind`（分类的**手动出口**）＋ `space_security_overview`
   （**一次读全**所有空间的分类 ＋ 加密状态 ＋ 闸门裁决，`SpaceSecurityView`）。
   界面侧不用知道"钥匙袋"存在；未分类的空间**照样在列表里**（`kind === ""`），界面要如实显示成
   "未分类"，**不许**默认成个人空间。
   ⚠️ 两条都是**桌面专属**（登记进 `DESKTOP_ONLY_COMMANDS`）：Web 没有钥匙柜 ⇒ `in_keyring` 恒假、
   `encrypted_on_disk` 无从嗅探，真给一份读数只会是**误导**。命令面计数随之变成
   **Rust 255 / web 249 / CommandMap 257**（`docs/TESTING.md` 的 facts 行已同改）。
   ⚠️ 分类命令面是**窄进**：只接受 `"personal"` / `"team"` / `""`，别的串**直接报错** ——
   与内部 `SpaceKind::parse` 的"宽进不猜"刻意相反（前者读库里别人写的数据，后者读界面传的参数；
   界面把 `team` 拼错若被静默当成"取消分类"，闸门会在用户以为已归类时**松开**）。

## 3. 待 owner 拍 / 硬前置（别自己决定）

1. ★ **"这个空间是个人还是团队"从哪来**：今天**所有空间都是未分类**，所以闸门对它们**一律放行**
   （`AllowedUnclassified` ＋ 一条 `eprintln` 提示）。要让闸门真正生效，必须先有分类来源
   （建空间时选？账号类型推？）—— 这是**产品输入**。
2. **KDF 参数取值**（Argon2id 内存/迭代）：结构性要求（显式存参数）已落地；
   取多少要**实测解锁耗时**（本机 ＋ 低端 Android）再定（决策稿 §7.2）。
3. **0b（公开材料可同步）**：要动 `shuyonote-sync-server` 那个仓（本会话碰不到）⇒
   在那之前，"换设备能用"只支持**手工搬**公开材料（`Keyring::to_json` 就是那份可公开的文件）。
4. **第 3 步存量迁移**：口径是"不考虑向后兼容"⇒ 一次性迁移、**不做双读**；
   但**失败必须如实报错**（密文打不开＝数据丢失，不许静默）。
5. **第 4 步 Web 口径**：加密的个人空间在 Web 上应"不可同步、不可编辑"，不许悄悄降级成明文上传。

## 4. 本会话踩出来的三条纪律（都写进 `docs/TESTING.md` 了）

1. **改源文件只用 `edit`/`write`**：我用 PowerShell `Set-Content -replace` 把一个 UTF-8 源文件写坏过
   （PS 5.1 默认 ANSI ⇒ 非 UTF-8、中文全乱），代价＝`git checkout` 还原 ＋ 重做整片。批量替换用
   `edit` 的 `replace_all`。
2. **进程级全局的测试必须共用一把锁**：`SESSION_KEY`/`LOCKED`/`KEYRING`/`SESSION_MASTER` 都是进程级
   `static`，cargo test 多线程会交错 ⇒ 现场是**隔离绿、全量红**。锁＝`security.rs` 的
   `#[cfg(test)] pub(crate) static SEC_LOCK`，`space_crypto::tests` 与 `security::tests` 共用。
3. **Rust 全量与 vitest 全量别并行跑**；`Test timed out` 先量 `git status --short`（>1s ＝ 机器在忙，
   等它恢复再跑）—— 那天**隔离复跑仍超时**的 6 个文件，机器恢复后同一批 44/44 全过。
4. **Windows 上 SQLCipher 负例的 stderr 噪声会让外层退出码变成 1**（2026-09-24 实测）：
   `hmac check failed for pgno=1` 正是"错钥匙必须解不开"那条判据在生效的证据，但 PowerShell 把原生命令的
   stderr 记成 `NativeCommandError` ⇒ **外层 1、测试全绿**。判绿看 `test result: ok` 与
   `win-cargo-test: test exe exit code = 0` 两行；反之 `test exe exit code != 0` 才是真红。
   （两个方向都得认，细节写在 `docs/TESTING.md`。）

## 5. 一条"没管到"要一直记着

`sync_gate` 对**未分类**空间放行（因为今天全是未分类）；`encryption_enabled` 与启动闸门也还没按空间
⇒ **"个人空间密文 / 团队空间明文同时成立"这件事，今天还没有真正生效**（机制齐了、输入没齐）。
别在文档里写成"已经做到"。

**本轮补的两条同族缺口（同样不许写成"已做到"）**：

1. **Web 侧今天没有这道闸门**：`set_space_kind` / `space_security_overview` 与按空间加解密一样登记为
   **桌面专属**。Web 上没有钥匙柜 ⇒ 没有"按空间加密"这回事，闸门的输入在那里**没有下游**。
   口径上 Web 该是"加密的个人空间**不可同步、不可编辑**、绝不降级明文"（owner 拍板 B=甲），
   今天这条靠 `src/lib/ciphertextSniff.ts` 把密文**明确拒掉**兜住；**"Web 侧的闸门本身"未做**。
2. **分类的手动出口有了，"自动来源"仍然只有一条入口**：本地新建 ⇒ `personal`（A=3）。
   存量空间、以及团队流程之外建的空间**仍是未分类**（闸门放行）。本轮**不**批量迁移是对的：
   把存量一律当个人空间，会把它们的同步**突然掐断** —— 那是一次行为变更，不是一次分类。

## 6. ④ 低端 Android 解锁实测：**未做，需真机**（2026-09-24 如实记录）

本机有 `adb`（`C:\Users\cnzen\AppData\Local\Android\Sdk\platform-tools\adb.exe`）与完整 Android SDK，
但 `adb devices` **一台设备都没有**；可用 AVD 只有一个 `ShuyoNote`。模拟器跑在桌面 CPU 上，
它的解锁耗时对**低端真机不具代表性**（会给出偏乐观的读数）——拿它当"已实测"就是假读数 ⇒ **不测**。

⇒ KDF 参数（决策稿 §7.2）现在只有**本机桌面**的读数，而且**两条口径不同、别混着比**：

- **应用级解锁**（今天的真实路径）≈ 8 s，其中 SM3-PBKDF2 20 万轮占约 7 s（把它关掉后 Argon2 只约 1 s）；
- `keyring.rs::unlock_time_reading` 的对照读数：当前参数 **8.24 / 8.05 / 7.80 s**、
  64 MiB·t=3 **3.96 / 3.99 / 4.32 s**、256 MiB·t=4 **20.6 / 20.1 / 21.4 s**。

**要拍参数，就得有一台真机（最好是低端机）跑一次**；在那之前不许按桌面读数下结论。

## 7. ③ 0b（公开材料可同步）：服务端落点计划（下一轮直接照着做）

已侦察（`C:\Users\cnzen\zhai\shuyonote-sync-server`，**另一个仓**，按它自己的门禁走）：
axum ＋ rusqlite；`src/` 有 `space.rs` / `db.rs` / `sync.rs` / `device_key.rs` / `main.rs`；
已有路由族 `/auth/*`、`/spaces`、`/spaces/{id}/members`、`/spaces/{id}/audit`、`/spaces/{id}/device-keys`；
已有表 `spaces` / `space_members` / `device_keys` / `server_config` / `page_lineage` / `audit_log` …；
`tests/` 只有 `cli_args.rs`（集成判据少，单测在 `#[cfg(test)] mod tests` 里）。

**落点（建议；落地前先读那个仓自己的 `docs/` 与迁移先例）**：

1. **表**：`space_keyrings(space_id TEXT PRIMARY KEY, keyring_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`，
   跟着它自己的 `schema_version` 迁移函数走。存的是**公开材料**（盐 ＋ KDF 参数 ＋ 被包裹的盒子）：
   服务端拿到它也**解不开**任何空间 —— 这是本设计的关键性质，要在判据里钉住"**存得进、解不开**"。
2. **路由**：`GET /spaces/{id}/keyring` ＋ `PUT /spaces/{id}/keyring`，权限与 `/device-keys` 同族
   （空间成员；写要 role 检查）。
3. **判据**（用那个仓自己的集成测试）：① 非成员读 ⇒ 403；② 成员写后读回来**逐字节相同**；
   ③ 篡改一个字节 ⇒ 客户端侧 `Keyring::from_json` / `unwrap_key` **报错**（服务端不校验内容，
   真伪靠 AEAD —— 这一点必须写进判据，否则"服务端可以悄悄换盒子"这个洞没人守）；
   ④ 同一空间覆盖写 ⇒ 旧盒子失效、新盒子可用（轮换语义）；⑤ 这一列里**只有**公开材料，
   不许顺手把别的空间数据塞进来。
4. **收口**：客户端侧只需"输口令 ⇒ 拉公开材料 ⇒ 推出主密钥 ⇒ 解盒子"。`Keyring::to_json` /
   `from_json` 就是这一份文件（已有判据 `the_master_comes_from_the_stored_kdf_params_so_another_device_can_reproduce_it`）。
   在那之前，"换设备能用"只支持**手工搬**这一份可公开的文件。
