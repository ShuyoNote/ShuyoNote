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

**当轮 tip 读数**（`e0563d50` 那棵树上）：Rust 全量 **572 passed / 0 failed / 18 ignored**；
vitest 全量 **2194 passed / 12 skipped**；`pnpm run build` 0；doc 门禁 137 篇 / 44 条 / 562 处（基线 562）。

## 2. 下一片：**1b-2b**（把"开关"与"启动闸门"也改成按空间）

要动的四处（按风险从小到大）：

1. **启动闸门**（`src-tauri/src/db.rs` ~L269：`if enc_on && !security::session_has_key()`）——
   今天是"应用级标志 ＋ 没钥匙 ⇒ 不打开活动空间、退回内存库 ＋ attach meta"。
   按空间后应改成 **嗅活动空间的库文件**（`security::space_db_is_encrypted(&space_db_path(dir, &active))`）——
   它不需要钥匙，正是为这一步准备的（`space_crypto::space_status` 已经在用同一手法）。
2. **`security::encryption_enabled(c)`**（`security.rs:36`，今天读 meta 的应用级标志）——
   改成"这个**连接**对应的空间库是不是密的（或袋里有它）"，**保留**应用级标志作为**旧路兜底**
   （老库/老用户没有袋子 ⇒ 一切照旧）。⚠️ 调用点不少（`lock/unlock/enable/disable`、`encryption_status`、
   `key_if_enabled`），逐个确认语义：**锁是主密钥级的**（见决策稿 §3.1 的更正），不要试图做"分空间上锁"。
3. **按空间启用/禁用的命令面**：`space_crypto::enable_space` / `disable_space` 已经是 lib 函数 ⇒
   加两条命令（`commands.rs` ＋ `lib.rs` 注册）＋ 契约 `commands.ts` ＋ web 平台（Web 上按空间加密**不适用**，
   按先例登记 `DESKTOP_ONLY_COMMANDS` 并写清理由）＋ `api.ts`。⚠️ 命令面一变，`check-web-commands` 会红，
   必须**同批**改完。
4. **UI**（可后置）：设置面板里"这个空间加密/不加密" ＋ "个人/团队"分类（分类是闸门的输入，见 §3）。

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
