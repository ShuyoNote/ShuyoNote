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
| **C** | **1**（存量迁移：**报错** ＋ 说清怎么办） | ✅ **两半都做了**（见下表下方第 2 行）：第一半"把旧钥匙装进袋子"（不动数据）＋ 第二半"轮换成真随机钥匙"（**先备份**、失败停住报错） |
| **D** | 实测后决定 | ✅ 已出读数（决策稿 §7.2）：今天解锁 **~8 秒**，其中 **~7 秒在 PBKDF2-HMAC-SM3 200k 轮**（纯 Rust、无硬件加速；**不能随手调小**）；256 MiB/t=4 单独就要 **20 秒** ⇒ 取舍的是**两条腿的总预算**；改 `SM_KDF_ROUNDS` 会让**存量 v2 解不开** ⇒ 0a-2 必须把 SM 迭代数纳入"随袋子存的参数"。⚠️ 低端 Android 还没量 |
| **E** | **你做，任何时候可以** | ★ **`shuyonote-sync-server` 就在本机**（`C:\Users\cnzen\zhai\shuyonote-sync-server`）⇒ 0b 可做（服务端加"公开材料的存放/取回"） |
| **F** | 按建议 ⇒ **不做**「用对端」 | ✅ 不排期 |


**当轮 tip 读数**（`e0563d50` 那棵树上）：Rust 全量 **572 passed / 0 failed / 18 ignored**；
vitest 全量 **2194 passed / 12 skipped**；`pnpm run build` 0；doc 门禁 137 篇 / 44 条 / 562 处（基线 562）。

## 2. 下一片：~~1b-2b~~（**已完成**：开关与启动闸门按空间；剩下的是"命令面/UI"与"分类来源"）

1. ~~**启动闸门**~~ ✅：`src-tauri/src/db.rs`（原来 `if enc_on && !session_has_key()`）已改成
   `security::startup_needs_unlock(&space_db_path(dir, &active))` —— **嗅活动空间自己的文件**。
   后果：**明文空间（例如团队空间）不再因为"别的空间开着加密"被拦在解锁屏后面**（有单测：
   `per_space_switch_and_startup_gate_look_at_the_space_itself`）。
2. ~~**`security::encryption_enabled(c)`**~~ ✅：改成"这个**连接**对应的空间是加密的吗"
   （库文件是密的 **或** 袋里有它），旧的应用级标志作为**兜底**保留（老库/老用户照旧）。
3. **按空间启用/禁用的命令面**（**待做**）：`space_crypto::enable_space` / `disable_space` 已经是 lib 函数 ⇒
   加两条命令（`commands.rs` ＋ `lib.rs` 注册）＋ 契约 `commands.ts` ＋ web 平台（Web 上按空间加密**不适用**，
   按先例登记 `DESKTOP_ONLY_COMMANDS` 并写清理由）＋ `api.ts`。⚠️ 命令面一变，`check-web-commands` 会红，
   必须**同批**改完。
4. **UI**（**待做**，可后置）：设置面板里"这个空间加密/不加密" ＋ "个人/团队"分类（分类是闸门的输入，见 §3）。

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

## 5. 一条"没管到"要一直记着

`sync_gate` 对**未分类**空间放行（因为今天全是未分类）；`encryption_enabled` 与启动闸门也还没按空间
⇒ **"个人空间密文 / 团队空间明文同时成立"这件事，今天还没有真正生效**（机制齐了、输入没齐）。
别在文档里写成"已经做到"。
