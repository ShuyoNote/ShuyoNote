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
| **②b 后端** | **分类的手动出口** `set_space_kind`（命令面**窄进**：只认 3 个值，别的串报错）＋ **一次读全的隐私读数** `space_security_overview`（`SpaceSecurityView`：分类 ＋ 加密状态 ＋ 闸门裁决；**未分类照样列出来**）＋ 判据 1 条（14/14 绿） | `0cdf9d99` |
| **②b 界面** | **最小界面**：`SpacePrivacySection`（挂在**同步面板**里 —— 闸门拦的就是「绑同步」这个动作）＋ 8 条判据（含 Web 不调 api / 两步确认 / 接线） | `87d189ab` |
| **③ 0b 服务端** | **公开材料**：v16 `space_keyrings` ＋ `GET\|PUT\|DELETE /spaces/{id}/keyring`（读 viewer / 写删 admin、不解析、64 KiB 上限）⇒ 补丁 `docs/plans/patches/0001-feat-keyring-0b.patch`（5 个文件，含**真服务端探针** `scripts/verify-space-keyring.mjs`；**没碰**那一仓的在写工作树；脏树上 `git apply --check` **exit 0**；真服务端 **8 通过 / 0 失败**） | 本仓本轮（见 §7.0） |
| **③ 0b 客户端** | **公开材料的推 / 取**：`sync::push_space_keyring` / `pull_space_keyring` ＋ `space_crypto::stored_material`（推之前先验）＋ `adopt_material`（**默认不覆盖**）＋ 界面两个按钮 ＋ **端到端判据**（A 推 ⇒ B 全新目录取回 ⇒ **只凭口令**解出**同一把**空间钥匙） | 本轮（见 §7.0.1） |
| **①-2 修** | **轮换"正开着"的那个空间**：函数自己让开连接（签名改 `&mut`）＋ 成功后**先换内存盒子再重开**、失败什么都不换；新增 `set_keyring_memory`（只更新内存、不写 meta）；判据 1 条（含内存/meta 一致）＋ 测试用 `CleanupGuard`（失败也清进程级全局） | `bb31bc80` |
| **①-3 修** | ★★ **存量空间会被静默锁死**那处：库已是密文而袋里没盒子时，`enable_space` 原来会**凭空造新盒子**（而 `convert_space_db` 对"已经是密文"是 no-op ⇒ 盒子与库对不上 ⇒ 打不开）⇒ 现在**拒绝并说清两条出路**，判据 1 条（报错要可操作 / **一个盒子都不造** / 空间照样打得开） | 本轮（见 §7.0.3） |

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


**当轮 tip 读数**（②b **界面**这一轮，提交后即 `origin/dev`）：Rust 全量 **579 passed / 0 failed / 18 ignored**
（`test exe exit code = 0`，293.1 s）；vitest 全量 **215 文件通过 / 2206 passed / 12 skipped**（exit 0）；
`npx tsc --noEmit` 0；`pnpm run build` 0；`build:web` 0 ＋ `check:web-build` **9 通过 / 0 失败**（真 Chromium 里跑）；
`check-web-commands` 绿（**Rust 255 / web 249 / 契约 257**）；`check-overlay-registry` **26 通过 / 0 失败**
（这一节**不是**浮层，是 `sync` 浮层里的一节 ⇒ 不需要新登记）；doc 门禁 138 篇 / 863 条链接 / 84 篇方案 /
44 条 / 562 处（基线 562 未动）。
（对照：②b **后端**那一轮 `0cdf9d99` ⇒ Rust 579 / vitest 2198 / 214 文件。）

**③ 的服务端读数**（在 `shuyonote-sync-server` 的**干净克隆** `ede92a2` 上跑，不是他们那棵在写的树）：
`cargo test` ⇒ **bin 41 passed / 0 failed / 1 ignored** ＋ **集成 4 passed / 0 failed**；
`cargo clippy --all-targets` ⇒ 仅 1 条**既有**警告（`sync.rs` 测试段）；
`rustfmt --check` ⇒ 本补丁三个文件干净；`node website/check.mjs` ⇒ 绿。
⚠️ 那一仓 HEAD 自己就有三条门禁是红的（`check-doc-links` / `check-release-discipline` / `cargo fmt` 既有差异），
详见 §7.0 —— **不是**本补丁弄红的，也**不许**顺手替他们把那些改掉（那是另一个人的活）。
本轮我这一仓的代码**没动**（只多了一份补丁与文档）⇒ 上面那一套读数继续有效。

**当轮 tip 读数**（③ 0b **客户端**这一轮，提交后即 `origin/dev`）：Rust 全量 **584 passed / 0 failed / 18 ignored**
（`test exe exit code = 0`，569.6 s —— 比上一轮慢一倍，因为**机器上同时有另一会话在编译/测试**）；
`npx tsc --noEmit` 0；`pnpm run build` 0；`build:web` 0 ＋ `check:web-build` **9 通过 / 0 失败**；
`check-web-commands` 绿（**Rust 257 / web 249 / 契约 259**）；`check-overlay-registry` 绿；
doc 门禁 138 篇 / 863 条链接 / 84 篇方案 / 44 条 / 562 处（基线未动）；
新增判据：`SpacePrivacySection.test.ts` **10 条**（上一轮 8）＋ Rust **5 条**
（②b 读数面 1 ＋ 采纳/坏材料 2 ＋ 端到端/404/状态码 3）。

⚠️ **vitest 全量这一轮没拿到干净读数（不是代码问题，是机器）**：连跑两次全量都在"spawn 密集"的
那几个文件上超时（第一次 3 文件 4 条、第二次 3 文件 10 条），而且**每次红的文件都不一样**
（`yrsInterop.spike` / `sm-library-patch` / `check-changelog-version-parity` / `check-sys-deps`），
这些文件**隔离复跑全过**（42/42、31/31）；同一时刻机器上跑着**另一会话的 2 个 cargo ＋ 2 个 rustc
＋ 24 个 node**（Rust 全量也从 293 s 涨到 569 s）。⇒ 记成**负载 flake**，**没有**拿它当绿，
也**没有**重试到绿了算数。

**当轮读数（③ 0b 真服务端这一轮）**：我这一仓**代码没动**（只换了补丁 ＋ 文档）⇒ 上面那一套读数继续有效。
这一轮的新证据是 §7.0 第 3 条：**真设备密钥 ＋ 真 axum 服务 ⇒ 8 通过 / 0 失败**；
探针脚本已并进补丁，`git apply --check` 在**他们那棵脏树**上仍然 **exit 0**（他们树仍 78 项，一个字节没被碰）。

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
4. ~~**UI**（待做）~~ ✅ **最小界面已做**（②b）：`src/components/SpacePrivacySection.tsx`，
   **挂在同步面板里**（`SyncPanel.tsx`）。为什么是这一屏：闸门拦的正是「绑同步」这个动作
   （`sync::sync_bind_gate`）⇒ 读数与动作必须**同屏**，否则用户得自己去别处找「为什么绑不上」。
   每个空间一行：名字 ＋ 分类徽标 ＋ 已加密/明文 ＋ **闸门裁决**（拦 ⇒ 原样显示后端那句可操作的原因；
   未分类 ⇒ 明确写「闸门这次没有管到它」，**不许**沉默放行），动作＝改分类下拉 ＋ 开启/关闭加密。
   ⚠️ 三条纪律写在组件里：① **唯一的平台判定点**（Web 上只渲染解释句、**一次 api 都不调** ——
   调了就是 `command not found`）；② 「关闭加密」是**两步确认**（不用 `window.confirm`：Tauri 里不保证有实现，
   静默返回 false 就成了「点了没反应」的静默失败）；③ 后端报错**原样**显示（自己改写一遍＝把"可操作"抄第二份）。
   判据 `src/components/SpacePrivacySection.test.ts` **8 条**（含 Web 不调 api、两步确认、主口令原样透传，
   以及**接线判据**：`SyncPanel.tsx` 里真的挂了这一节，防孤儿组件）。样式在 `App.css`（`.space-privacy*`，
   与 `.sync-card` 同族，不另起视觉语言）。
   **后端**（上一轮已推）：`set_space_kind`（分类的**手动出口**）＋ `space_security_overview`
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
   （2026-09-24 更明确的一次：**另一会话**在同一台机器上编译/跑测试时，vitest 全量连跑两次都红，
   且**每次红的文件不同**；隔离复跑全过 ⇒ 判据是"**隔离绿 ＋ 负载证据**"，
   不是"重试到绿了就算绿"。）
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

### 7.0 ✅ 已落地（2026-09-24 本轮）：**补丁就绪 ＋ 判据全绿 ＋ 落点已验证**

⚠️ 为什么是**补丁**而不是直接提交：那个仓的工作树里**有别人正在写的未提交改动**
（22 个已跟踪文件 ＋ 几十个未跟踪文档，其中 `src/main.rs` 本身也改过），而路由必须加在 `main.rs`。
直接在那儿提交＝把**别人的改动混进我的提交**（静默）；直接改＝可能在对方写入时互相覆盖。
⇒ 做法：**克隆一份干净 HEAD** 到 `C:\Users\cnzen\zhai\_scratch\sync-server-keyring`，在那儿实现＋跑判据，
交付一份可直接 `git apply` 的补丁（**没碰他们的工作树**）。

- 补丁：`docs/plans/patches/0001-feat-keyring-0b.patch`（**32 KB，5 个文件**：新模块 `src/space_keyring.rs`
  ＋ `src/db.rs` 的 v16 迁移 ＋ `src/main.rs` 的三条路由 ＋ 新探针 `scripts/verify-space-keyring.mjs`
  ＋ `package.json` 的 `verify:space-keyring`）。
- ★ **补丁跟着他们往前走了**：他们又落了一笔（`0544bed` 把 traffic-dashboard 迁去独立仓）⇒
  我这边 **rebase 到新 HEAD**（我的提交＝`3995bee`）后在克隆里重跑 `cargo test`
  ⇒ **bin 41 passed / 0 failed / 1 ignored ＋ 集成 4 passed**（exit 0）；
  对着他们**当前的树**（`0544bed` ＋ 未提交改动）`git apply --check` 仍 **exit 0**，
  他们树仍 76 项、**一个字节没被碰**。
  ⚠️ 仍然**没有**落进他们仓：`src/main.rs` **还是脏的**（是他们在写的东西）—— 往那儿提交会把他们的改动
  一起提交（静默混别人的活），把工作树改回"没有我的改动"又会让他们的下一次提交**把我的路由删掉**。
  两条都不能做 ⇒ 交付物仍是**等价于一次提交的补丁**（`git am` 一条命令的事）。
- **落点已验证**：在**他们那棵有未提交改动的树**上 `git apply --check` **exit 0**（能干净落下；他们树仍是 78 项，
  一个字节都没被我碰过）。（`git apply --3way --check` 会报 `src/main.rs: does not match index` ——
  那是"它本来就脏"的正常结果。）
- ★★ **真服务端已验证（不是桩）**：在克隆里 `--issue-device-key --space sp-e2e` 拿一把**真设备密钥**，
  起真的 axum 服务，再跑 `scripts/verify-space-keyring.mjs` ⇒ **8 通过 / 0 失败（exit 0）**：
  ① 无 token ⇒ 401；② owner PUT ⇒ 200 ＋ `bytes=306`；③ GET 回**逐字节相同**的 `keyring_json`（含中文与未知字段）；
  ④ 拿这把 key 读**别的空间** ⇒ 403；⑤ 覆盖 PUT ＝ 轮换（取回的是新那份）；⑥ DELETE ⇒ 200，再 GET ⇒ 404，
  再 DELETE 仍 404（**不假装成功**）；⑦ **审计里有 `space_keyring.put`，明细只有 `bytes=306`** ——
  **没有**把材料本身抄进日志。
  ⚠️ 这条探针当场踩到一处并修掉（留个路标）：`/spaces/{id}/audit` 的回话是 `{ items: [...] }`，
  我第一版按 `entries` 取 ⇒ 取到 0 条 ⇒ 把"审计没记"误判成红。**是脚本错，不是服务端错。**
  ⚠️ 这条读数的边界要说清：服务是**克隆里那棵含补丁的树**跑起来的，**不是**他们那棵在写的树。
- 内容：v16 迁移 `space_keyrings(space_id PK, keyring_json, updated_at, updated_by)` ＋
  `src/space_keyring.rs`（`get` / `put` UPSERT / `delete` ＋ 三个 handler）＋
  路由 `GET|PUT|DELETE /spaces/{id}/keyring`（接在 `space_routes` 里，走同一个 `auth_user`）。
  **读要 `viewer`，写/删要 `admin`**；`keyring_json` 服务端**不解析**（原样存原样取）；
  上限 64 KiB（空 ⇒ 400，超 ⇒ 413）；审计**只记字节数**，绝不记材料本身。
- 判据（`cargo test`，本机实测）：**bin 41 passed / 0 failed / 1 ignored ＋ 集成 4 passed**；
  我这一族 7 条全过（逐字节相同 / 一个空间只有一行且覆盖＝轮换 / 缺行 ⇒ `None` 且删除幂等 /
  空间隔离 / 表恰好四列且 `space_id` 是主键 / 大小闸门三个边界 / `require_space` 三个角色）。
  ⚠️ 加迁移时**它仓自己的判据当场红了**（`migration_creates_team_schema_and_is_idempotent`
  里版本号写死 15）⇒ 同批改成 16 并加上新表断言 —— 那条断言写死就是为了这个。
- 本机门禁读数（克隆于干净 HEAD `ede92a2`）：`cargo clippy --all-targets` 只有 **1 条既有警告**
  （`sync.rs` 测试段的 `unused doc comment`，不是本补丁引入）；`rustfmt --check` 对本补丁三个文件干净
  （`src/main.rs:211/253` 与 `src/device_key.rs` 的 fmt 差异是 **HEAD 既有**的，我**没有**顺手改它）。
  ⚠️ 那个仓 **HEAD 上本来就有三条自己的门禁是红的**（与本补丁无关，别当成我弄红的）：
  `check-doc-links`（`docs/SESSION_CONTINUE.md` 等指向 `../../ShuyoNote/docs/SHUYONOTE_STATE.md`）、
  `check-release-discipline`（"已存在指向 1.2.3 的 tag（v1.2.3）"）、`cargo fmt`（`device_key.rs` 既有差异）。
  `website/check.mjs` 绿。
- **还差一笔（落地时补）**：`docs/api.md` 加一节 `GET|PUT|DELETE /spaces/{id}/keyring`
  （README 若有接口清单也同步一行）。**故意没放进补丁**：那个文件在他们的工作树里也是脏的，
  放进去会让补丁更容易撞车。那一节的正文写在补丁的提交说明里（`git am` 之后仍可查）。

**~~还差的另一半（客户端"第二台设备"路径）~~ ✅ 本轮做完了**（下面这几句留着看当时的计划）：服务端现在存得下、取得回，
但客户端**还没有**"输口令 ⇒ 拉公开材料 ⇒ 解盒子"那条路（今天只有手工搬文件）。
要做的三件：① `sync.rs` 加 `fetch_space_keyring` / `push_space_keyring`（POST/GET 那两个端点，
复用现有 HTTP 与错误映射）；② 解锁路径接上"本地没有袋子 ⇒ 先拉一次"；
③ 判据：**两台设备的端到端**（A 开加密 ⇒ 推公开材料 ⇒ B 只输口令 ⇒ 解出同一把空间钥匙并读到数据）。
⚠️ 设计上要先定一件事：**这算不算用户的显式动作**（自动拉 vs 点一下"从服务器取回钥匙"）
—— 这牵涉到"口令输给谁"的用户理解，别自己默默决定。

### 7.0.1 ✅ 客户端那一半（本轮做完）

- `sync::push_space_keyring` / `sync::pull_space_keyring`（`PUT` / `GET /spaces/{id}/keyring`）：
  同步档案复用 `claim_config` —— 与血统 claim **同一处解析**（不另写一份"该找哪台服务器/哪个远端空间"）。
  "正常的不顺利"（没配同步 / 服务端上没有 / 连不上 / 被拒）用 `outcome` 回，**不抛异常**
  （与 `claim_page_lineage` 同一纪律：抛出去会被平台 invoke 层记成 error）。
- `space_crypto::stored_material`：推之前**先验**能不能解析 —— 坏材料**不许推上去**
  （推上去等于把服务端那份好副本也弄坏，而且没有第二个人能替你发现）。
- `space_crypto::adopt_material`：取回来装进本机；**默认拒绝覆盖**已有的那一份
  （闷头覆盖可能让本机**打不开自己的空间**：别的设备轮换过之后，服务端那份与能开当前库的那把未必一致）。
- 界面：`SpacePrivacySection` 每行两个按钮「推到服务器」/「从服务器取回」＋「允许覆盖本机已有的材料」勾选框；
  结果**原样**显示后端那句话（`ok` / `warn` / `err` 三档）。两条命令登记为**桌面专属**（Web 无钥匙袋）。

★ **端到端判据**（`sync.rs::tests::a_second_device_unlocks_the_space_with_the_passphrase_alone`）：
A 设备建袋子（口令）＋给本机空间包一把钥匙 ⇒ 推给**桩 HTTP 服务端** ⇒ B 设备（**全新目录、什么都没拷**）
取回 ⇒ 装进本机 ⇒ **只凭主口令**解出**同一把**空间钥匙，且采纳之后闸门眼里这个空间就是"已加密"。
⚠️ 写这条判据时当场踩到一个坑（值得记）：桩服务端读 body **必须按字节收齐再转字符串** ——
分块读在多字节字符中间切开会让中文变乱码，于是"存进去的"与"取回来的"会被判成不一样。

★★ **再加一条"真服务端"判据**（`sync.rs::tests::the_client_talks_to_a_real_server_and_needs_its_bearer`，
`#[ignore]` —— 要真服务端 ＋ 真设备密钥才跑）：**桩服务端不看 `Authorization`、也不在乎路径**，
而"客户端到底有没有带 bearer、打的是不是 `/spaces/{id}/keyring`"正是桩**一定发现不了**的那一处
（路径写错的客户端在桩上全绿、在真服务端上 404）。这条在**真 axum 服务**上钉住：
① 空 token ⇒ 被挡（401/403，且**不许**当成功）；② 推上去取回来**逐字节相同**；
③ 第二台设备（全新目录）**只凭口令**解出同一把钥匙 —— **实测 `1 passed / 0 failed`**（跑法见 `docs/TESTING.md`）。

★★ **还有一条守门判据**（`a_server_that_hands_over_a_different_bag_makes_the_second_device_fail_loudly`）：
服务端交过来的那份**不是你那一袋**（被换过 / 本来就是别人的）⇒ 第二台设备**解不开**，
而且报的是"**口令不对或盒子被改过**"这句可操作的话，**不会**给出一把错的钥匙；
连"袋子里根本没这个空间的盒子"那一支也是一句人话。
**为什么必须有它**：服务端**不解析也不校验**那份材料（这是刻意的 —— 真伪靠客户端解盒子时的 AEAD）
⇒ 没有这条判据，"服务端可以悄悄换盒子"这个洞就没人守、"真伪不靠服务端"也就只是句口号。

★★ **结果层那一步也钉住了**（合并在同一条桩上的端到端判据里）：B 取回 ＋ 输口令之后，
在**自己**这个空间上开加密 ⇒ **复用的是取回来的那把空间钥匙**（不是又随机一把），
B 自己的库**真的**变成密文，而且到这一步闸门才放行（分类用**库里读出来的**那个值去问，
不是把 `Personal` 硬编码进判据 —— 硬编码会把判据弄软成"我把参数填对了"）。
⚠️ 顺手记一个坑：`open_space_conn_at` **不给** `meta.workspaces` 建行 ⇒ 想让分类参战，
得走真 API `workspaces::insert_new_local_space`（A=3 那条路），别指望 `set_space_kind` 能凭空写。

⚠️ **我替口径做了一个决定，要 owner 过目**：推 / 取做成了**显式两个按钮**，**不做**自动拉。
理由：自动拉意味着在解锁屏上先联网、先取材料，而用户看不到"这一步在跟谁说话"；
显式动作把因果摆在眼前（先取回、再输口令）。要改成自动拉只是**界面/流程**改动，机制这边不用动。

**仍然没做的两件（都不许写成"已做到"）**：
1. **真机双设备（UI 那一段）**还没跑：两台跑 Tauri 应用的设备，一台点「推到服务器」、
   另一台点「从服务器取回」＋输口令并**真的读到数据**（含"输错口令"那一支）。
   链路的三段如今各自都有判据（服务端 **8/0**、客户端↔真服务端 **1/0**、桩上的整段流程 **1/0**）——
   **没跑的正是"界面点下去"那一段**，所以整件事还不能说"验收过了"。
2. **服务端补丁还没落进那个仓**（对方工作树在写，见 §7.0 开头）：`git apply --check` 已经过了，
   但**没有**在他们的树上编译过（在那棵树上编译会把他们的半成品一起编进来）。

### 7.0.2 本轮查出来：① **还没算完**（下一片就做它）

1. **① 的两个迁移函数没有任何命令 / 界面能调到**（全仓 grep：只有它们**自己的判据**在调用）：
   `migrate_legacy_space_into_keyring`（把旧应用级钥匙装进袋子）与
   `rotate_legacy_space_to_random_key`（换成真随机钥匙）。⇒ 机制齐、判据齐，但**用户够不着**：
   存量加密空间既迁不进来、也换不了钥匙。要补：两条命令（`commands.rs` ＋ `lib.rs`）＋ 契约 ＋ `api.ts`
   ＋ 界面两个按钮（**轮换那条要两步确认**：它会重写库）＋ 判据 ＋ 桌面专属登记 ＋ 计数同改。

2. ~~★★ **轮换"正开着"的那个空间跑不通**~~ ✅ **本轮修好了**（判据：对着**正开着**的空间轮换 ⇒
   成 / 数据没丢 / 连接被开回来还查得动 / **内存与 meta 里那份是同一把钥匙**）。
   修复按下面 a–e 的顺序落地（含新增的生产 setter `space_crypto::set_keyring_memory`：
   **只更新内存那份公开材料、不写 meta** —— 因为"重新打开"那一步是按盒子取钥匙的，而此刻 `conn`
   已是内存库，写 meta 会 `no such table`）。原委与顺序理由留在下面（下次改这段代码前先读它）：
   函数里原来是"**先转换、最后换盒子**"，于是"重新打开"那一步拿着**旧盒子**的钥匙
   去开**新钥匙**的库 —— 这正是 `enable_space` 里**已经写着**的教训
   （"★ 先把袋子落下去（内存 ＋ meta）再转换：这样紧接着的'重新打开这个空间'才会按空间拿到钥匙"）。
   ⚠️ 但**不能照抄**：`enable_space` 是"先建新盒子再转换"，因为它是**复用**已有盒子（失败时盒子本来就该是那个）；
   轮换是**换一把新钥匙**，若转换失败而盒子已经换成新的，那个空间就**打不开**了（旧库配新盒子）。
   ⇒ 实际落地的顺序：a. 取旧钥匙 ＋ 先备份；b. 若连接正开着它 ⇒ swap 成内存库；
   c. 两次转换（失败 ⇒ 尽量回退到旧钥匙那一版）；d. **成功** ⇒ 先只换内存盒子 → 重新打开 → 再落 meta；
   **失败** ⇒ 什么都不换、把连接按旧状态开回来再报错（那时盒子里还是旧钥匙，对得上
   "库还在旧钥匙那一版"）；e. 最后 `store_keyring`（幂等）＋ 打标记。

   ⚠️ 写这条判据时踩到的第二个坑（记下来免得再踩）：**它在清理进程级全局之前 panic**，于是把
   `KEYRING` / `SESSION_MASTER` / `SESSION_KEY` 留脏，**后面 5 条空间判据跟着红**
   （`space_kind_round_trips…` / `the_security_overview…` / `with_no_keyring…` 之类全被带红）——
   全是同一条根因，不是它们自己坏了。⇒ 判据里凡会污染全局的，**失败路径也要能清干净**
   （把清理放进 `Drop` 守卫是最省事的做法）。

> ①-2 已在下一轮**修好**（见上：判据 17/17）。**①-1（两个迁移函数用户够不着）还没做** ——
> 下一片就做它：两条命令（`commands.rs` ＋ `lib.rs`）＋ 契约 ＋ `api.ts` ＋ 界面两个按钮
> ＋ 桌面专属登记 ＋ 计数同改（`docs/TESTING.md` 的 facts 行）。

### 7.0.3 ★★ 本轮又查出一处**会静默把存量空间锁死**的 bug（已修 ＋ 已判据）

**症状（改之前）**：库**已经是密文**、而钥匙袋里**没有**它的盒子时，`enable_space` 会**凭空造一个
新随机盒子**；可 `convert_space_db` 对"已经是目标状态（密文）"是 **no-op**（**不会重加密**）
⇒ 盒子里的新钥匙与库文件对不上 ⇒ 那个空间**打不开**了，而且**是静默的**（盒子看着好好的，
只有下一次开库才炸）。这恰恰是**存量空间**最常见的入口（早先「应用级一把钥匙」加密的那些）。

**修法**：库已是密文而袋里没盒子 ⇒ **拒绝**，一个盒子都不造，并把两条出路写进错误里
（这是 C=1「报错＋说清」这条口径在这里的落点）：
① 先「把旧钥匙迁进钥匙袋」（第一半，不动库文件）；② 或在旧设备上推公开材料、这台设备取回。

**判据**：`enabling_a_space_whose_db_is_already_encrypted_refuses_to_mint_a_box` ——
对着"旧钥匙加密的存量空间"调 `enable_space` ⇒ 报错里要说清后果与出路 /
**一个盒子都没造**（`!keyring().has(...)`）/ 那个空间**照样打得开**（没被弄坏）。space_crypto **18/18**。

**教训（写在这里免得再犯）**：`convert_space_db` 对"已经是目标状态"是 **no-op** ——
凡是"**造一把新钥匙**再指望库被重加密"的路径，都必须先问一句「**库里现在到底是什么钥匙**」。

### 7.1 落点计划（补丁按此实现；留着看当时的取舍）

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
