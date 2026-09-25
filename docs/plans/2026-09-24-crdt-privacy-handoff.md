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
| **去应用级** | ★★ **owner 第三轮拍板落地**（§7.0.7）：应用级加密（全局一把钥匙）**整套删净**（含解锁哨兵与**读老库的兜底**）＋ ① 的迁移/轮换**同批删除**（失去对象）；设置面板那节换成挂 `SpacePrivacySection`；解锁改按**袋子记的 KDF 参数**派生、**由解盒子回答口令对不对**；`wire`/`backup`/开库三条路只认**空间盒子**。**不向后兼容**：应用级加密的存量库打不开（C=1 报错＋说清）。判据 14 条改写 ＋ 1 条新增 | 本轮（见 §7.0.7） |

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
4. ~~**第 3 步存量迁移**~~ ✅ **已按 owner 第三轮拍板结清（§7.0.7）**：不是"迁移"，而是
   **应用级加密整套删除** ⇒ 存量（应用级）库**打不开**、**报错＋说清**，**不做双读、也不留兜底**。
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

## 6. ④ 安卓真机解锁实测：**已量到（但那是旗舰机 → 只能当"乐观下界"）**

**设备（如实记录）**：HUAWEI **OCE-AN10**（Mate 40E）· **Kirin 9000E** · 8 核 · 7.7 GB · Android 12 · arm64。
⚠️ 这是 **2021 年的旗舰**，**不是"低端机"** ⇒ 下面的读数是**乐观下界**；真正的低端机仍未实测。

**怎么量的**（临时件在 `_scratch/kdfbench`，不进仓）：一个微基准，**crate 版本与参数对齐主仓**
（`argon2 0.5.3` / `sm3 0.5` / `hmac 0.13` / `pbkdf2 0.13`；Argon2id m=19456 KiB·t=2·p=1
＋ PBKDF2-HMAC-SM3 **200 000** 轮），**release**（opt-level 3 ＋ LTO）交叉编到
`aarch64-linux-android`（NDK 29 的 clang 当 linker），`adb push` 后在机器上跑，各 3 遍：

| 机器 / 构建 | Argon2id（19 MiB·t=2·p=1） | PBKDF2-HMAC-SM3（20 万轮） | 合计（一次解锁） |
|---|---|---|---|
| **OCE-AN10（真机，release）** | **88 / 90 / 88 ms** | **247 / 263 / 248 ms** | **335 / 353 / 336 ms** |
| 本机桌面（release） | 24 / 26 / 27 ms | 104 / 109 / 103 ms | **128 / 135 / 130 ms** |
| 本机桌面（debug） | 519 / 548 / 525 ms | 2569 / 2469 / 2401 ms | **3088 / 3017 / 2926 ms** |

**★ 拍板 B 之后：真机按 64 MiB 再量一次**（同一份微基准，只把 `Params::new(64*1024, 2, 1, …)`）：

| 机器 / 构建 | Argon2id（**64 MiB**·t=2·p=1） | PBKDF2-SM3(200k) | 合计（一次解锁） |
|---|---|---|---|
| **OCE-AN10（真机，release）** | **335 / 276 / 241 ms** | **214 / 157 / 158 ms** | **549 / 433 / 399 ms** |

⇒ **选定参数在真机上一次解锁约 0.4–0.55 秒**（桌面 release 按同比例约 0.2 s 量级），完全在可接受区间；
读数的抖动（Argon 241–335 ms）是手机调度/温度的常态，别当精确值用。

**★★ 2026-09-24 深夜：第二台真机 —— 小米 MIX 2（老机读数与旗舰同档，但它**不是低端机**）**

设备（如实记录）：Xiaomi **MIX 2**（`msm8998`）· **骁龙 835** · 8 核 · **5.8 GB** · **Android 9** · arm64。
⚠️ **口径必须诚实**：它是 **2017 年的旗舰**，**不是低端机**（4xx / 6xx / Helio 那一档）。
它比 OCE-AN10 老 4 年、单核低一档 ⇒ 是**比"旗舰下界"更靠慢端的一档**，
但 **"真正的低端机"这一格仍然空着**。

| 机器 / 构建 | Argon2id（19 MiB·t=2·p=1） | PBKDF2-SM3（200k） | 合计（一次解锁） |
|---|---|---|---|
| **MIX 2（真机，release）** | 79 / 80 / 79 ms（复跑 76 / 76 / 89） | 204 / 204 / 198 ms（复跑 196 / 199 / 196） | **277 / 283 / 284**（复跑 272 / 275 / 285） |

★ **拍板 B 之后按 64 MiB 再量**（与旗舰同一张表的位置）：

| 机器 / 构建 | Argon2id（**64 MiB**·t=2·p=1） | PBKDF2-SM3（200k） | 合计（一次解锁） |
|---|---|---|---|
| **MIX 2（真机，release）** | **280 / 272 / 272 ms**（复跑 273 / 273 / 272） | **196 / 196 / 196 ms**（复跑 196 / 196 / 196） | **476 / 468 / 468**（复跑 469 / 469 / 468） |

**★ 结论（两条，都要如实）**：

1. **选定参数在这台 2017 老机上 ≈ 0.47 秒**，与 2021 旗舰**同档**（0.40–0.55 s），
   甚至在 SM3 那条腿上**更快**（196 ms vs 157–214 ms）⇒ 「抬到 64 MiB」这笔账
   **在更老的机器上依然付得起**（复跑抖动 < 2%，比旗舰那次稳得多）。
2. ⚠️ **它仍不是低端机** ⇒ 上面那句"低端机仍未实测"**依然成立**，只是"下界"从
   **一个旗舰**变成 **一个旗舰 ＋ 一个 2017 老旗舰**。**真正低端（4xx/6xx/Helio）在量到之前，
   不许把 0.47 s 当结论**（它是下界，不是中位数）。

**复跑办法（约一分钟，全自动）**：
`powershell -ExecutionPolicy Bypass -File _scratch\kdfbench\run-on-device.ps1`
—— 它自己编 aarch64 release（NDK 29 的 clang 当 linker），然后**每 5 秒看一次 adb**，
设备一出现就打印机器信息并跑两遍（每遍内含每组参数各 3 次，落机器可读的 `RESULT` 行）。
⚠️ 这一轮顺手修掉了微基准里一个**会污染文档的 bug**：上一版的 `println!` 标签是**硬编码**的
`m=19456KiB`，而 `Params::new` 早已被改成 64 MiB ⇒ **标签说一套、真跑另一套**
（正是最容易被原样抄进文档的那种假读数）。现在**标签由实参拼出来**，并且**一次量两组**，
两行能直接对上本文上面两张表。
⚠️ 这仍是**旗舰机**的下界；**低端机仍未实测**。

**★★ 件5 第一步（2026-09-24）：解锁路径加了一行耗时日志 —— 并当场揭出一件要紧事**

`security::unlock_encryption_impl` 现在会打一行：
`[unlock] 整条解锁 <n> ms（含两次 KDF：应用级那条 ＋ 钥匙袋那条，以及开库）`。
在**本机 debug 测试构建**里读到的是 **7381 ms** —— 这正好解释了那个"~8 秒"：
它是**整条解锁**（不只是 KDF）在 **debug** 下的读数；release 除以约 23 ⇒ **约 0.3 秒**量级。

⚠️ **要紧的那件事**：解锁会跑**两遍 KDF**：
① 应用级那条（`crypto::derive_app_keys`，Argon2 库默认 19 MiB ＋ SM3 200k）—— 它同时用来验哨兵、
② 钥匙袋那条（`master_from_passphrase`，Argon2 **64 MiB** ＋ SM3 200k）。
⇒ 按真机 §7.2.2 的数字估算，真机 release 的**整体解锁 ≈ 0.9–1.0 秒**（＝ 微基准 0.4–0.55 s 的近两倍）。
**这条要记住**：D/"低端机不超过约 1 秒"那个目标，预算要按**两遍**算。
⇒ 一个**将来**可做的优化（**这次不做**，因为它改的是钥匙来源 ⇒ 得连带迁移）：
让钥匙袋主密钥从应用级密钥材料派生（HKDF）而不是再跑一遍 Argon2 —— 那会把解锁砍掉近一半。
⚠️ 但**不能随手做**：已经存在的袋子记的是"自己那套 Argon2 参数"，换派生成 HKDF 会让它们解不开。

**Android 侧还没量，但"这行能不能出去"已经查清了**：本仓 `src-tauri/Cargo.toml` 的安卓依赖那一段里
留着一条**真机 logcat 原话**（`E/RustStdoutStderr: Expect rustls-platform-verifier to be initialized`）⇒
**Rust 进程的 stdout/stderr 在真机上是被 Android 侧接进 logcat 的**（tag **`RustStdoutStderr`**）。
所以这行 `eprintln!` **不需要**改通道，也不用加日志库。下一片只剩纯体力活：
**出一次 Android 包 → 装上 → 解锁一次 → `adb logcat -s RustStdoutStderr`** 读那行 `[unlock] … ms`。
（⚠️ 仍未量到的：低端机上的整体解锁；顺带也能量到"**两遍 KDF**"在真机上到底各占多少。）

**★★ 2026-09-24：试过出包了，卡在环境上（三个坑都记下来，下次省一整轮）**

链路是 `npx tauri android init` → `npx tauri android build --apk`。按顺序撞到：

1. **缺 `src-tauri/gen/android`** ⇒ 先 `tauri android init`（会生成 `gen/android`；它自带 `.gitignore`，
   **工作树不会被弄脏**，实测 `git status` 仍 0 项）。
2. **`beforeBuildCommand: pnpm build` 在后台任务里失败**：pnpm 的依赖状态检查判定 `node_modules`
   要重装，而**没有 TTY** 时它自己中止 —— `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。
   ⚠️ **不要**为此跑 `pnpm install`（网络不通会把 `node_modules` 弄成半成品，还会连累同工作树的另一个会话）；
   本机对策：用**配置文件**把 `beforeBuildCommand` 置空（前端产物 `dist/` 已是当前 tip 的）：
   `_scratch/tauri-android-override.json` = `{"build":{"beforeBuildCommand":""}}`，然后
   `npx tauri android build --apk --config <那个文件>`。
   ⚠️ 顺带记一条 PowerShell 坑：`--config '{"build":{...}}'` 里的引号会被 PS 5.1 吃掉
   （CLI 收到 `{build:{...}}` ⇒ `key must be a string`）⇒ **配置一律走文件**。
3. ★ **最后卡在 `perl`**：Android 侧的 `rusqlite` 要用 vendored OpenSSL（`openssl-src`），
   而它编之前要 **Perl**。本机**没装** ⇒ `error: failed to run custom build command for openssl-sys`。
   试过用 **Git 自带的那份 msys perl**（`C:\Program Files\Git\usr\bin\perl.exe`，v5.38.2）加到 PATH：
   它能被找到，但 OpenSSL 的 `Configure` **报错退出 2**（msys Perl 驱动不了 Android 目标那套构建）
   ⇒ 这条路**不通**。
   ⇒ **结论**：要出安卓包，本机需要**一份正经 Perl（Strawberry Perl 那种）**；那是**系统级安装**，
   需要 owner 点头（或者在一台已经能出包的机器/CI 上量）。
   ⚠️ 这也正是仓里 `docs/plans/2026-09-17-sm-crypto-tradeoff.md` 早写过的坑（"Android NDK 的 Perl 是硬坑"）。

**因此"整体解锁"的真机读数目前仍只有推算值（≈0.75–0.9 s）**，而**微基准的真机读数（0.4–0.55 s）是真的量过的**。
> ✅ **2026-09-25 已收口**：真机 **742 ms**（MIX 2 / release）—— 见下面「2026-09-25：件5 量到了」那一段；
> 顺带在那台机器上堵掉两个"Android 上应用根本起不来"的缺陷（`build.target` ＋ 十项 polyfill）。

**★ 2026-09-24 晚：装了正经 Perl（Strawberry 便携版）之后又往前走了两步，仍卡在同一处**

- 网络坑（先记下来，下东西要用）：本机 **`github.com` 直连不通**，但 **`api.github.com` 与 CDN
  （`objects.githubusercontent.com` / `release-assets.githubusercontent.com`）通** ⇒ 从 GitHub 下资产
  要走 **API 资产端点**（`/repos/<o>/<r>/releases/assets/<id>` ＋ `Accept: application/octet-stream`，
  它 302 到 CDN），**不能**用 `browser_download_url`（那是 `github.com`，第一步就连不上）。
- Perl 到手且**校验过 sha256**（Strawberry 便携版 5.42.3.1，304,765,269 字节，
  sha256 `6a081a81…a10690`，解在 `_scratch/perl`，**没装进系统**，只在构建命令里加 PATH）。
- 带着它重跑：`openssl-sys` 这次**认到了 perl**，但 OpenSSL 的 `Configure` 报
  **`'perl' reported failure with exit code: 255`**（`running "perl" "./Configure" --prefix=C:/Users/…`
  ＋ Android 目标）⇒ **Windows 上交叉编 vendored OpenSSL for Android 这条链本身不通**。
  ⚠️ 想手工复刻 Tauri 的交叉编译环境也不轻松：我直接跑那条 `cargo build --target aarch64-linux-android`
  时，卡在 `ring` 找不到 `aarch64-linux-android-clang`（缺 Tauri 会设的 `CC_…`/NDK PATH）。
- ~~⇒ **结论：本机出不了安卓包，请在 CI/会出包的机器上做**~~ ❌ **这个结论是错的，当天就自己推翻了**：
  仓里 `docs/TESTING.md` §474–517 **早就写着本机出安卓包的完整配方**（2026-09-21 就打通了），
  我前面是**在瞎试**。按配方跑**一次就成**，见下。

**★★ 2026-09-24：按仓里的配方，**本机真的把安卓包出出来了**（全过程与读数）**

配方（`docs/TESTING.md` §501–517，`init` 会重新生成 `gen/` ⇒ 之后每一步都要重跑）：
```powershell
node scripts/setup-local-perl.ps1        # 只抓"缺的那几个纯 Perl 模块"到 ~/.local-perl5/lib（不用装完整 Perl）
$env:PERL5LIB = "$env:USERPROFILE\.local-perl5\lib"
$env:PATH = "$env:PATH;C:\Program Files\Git\usr\bin"     # openssl 的 Makefile 要 sh
$ndk = "…\ndk\29.0.13846066\toolchains\llvm\prebuilt\windows-x86_64\bin".Replace('\','/')
# ★ 关键：工具链用**正斜杠**喂（否则 msys sh 把反斜杠吃掉 ⇒ clang 路径变 C:Users… 报 Error 127）
foreach ($v in 'CC','AR','RANLIB') { … "${v}_aarch64_linux_android" = $ndk/clang.exe | llvm-ar.exe | llvm-ranlib.exe }
$env:TARGET_CC/AR/RANLIB = 同上；$env:CFLAGS_aarch64_linux_android = "--target=aarch64-linux-android24"
node_modules\.bin\tauri.CMD android init --ci
node scripts/android-platform-verifier.mjs ; node scripts/android-mobile-shell.mjs ;
node scripts/android-app-icon.mjs ; node scripts/stage-android-pdfium.mjs ;
node scripts/patch-android-buildtask.mjs   # 本机那份 BuildTask.kt 会 `node tauri …` 找不到模块
node_modules\.bin\tauri.CMD android build --target aarch64 --apk --ci
```
**本机读数**：`Finished 1 APK at … app-universal-release-unsigned.apk` ⇒ **53.8 MB**，exit 0。
⚠️ 我另外用配置文件把 `beforeBuildCommand` 置空绕开了那个 pnpm 无 TTY 的坑（`dist/` 已是最新）。
⚠️ 想手工复刻 Tauri 的环境**没用**：直接 `cargo build --target aarch64-linux-android` 会卡在
`ring` 找不到 `aarch64-linux-android-clang`（缺 Tauri 设的那些 `CC_*`）——**必须走上面这条**。

**★★★ 2026-09-25：件5 量到了 —— 但先把两个「Android 上应用根本起不来」的缺陷堵了**

**先证实手上那个包是旧口径**（不靠时间戳猜）：旧 `shuyonote-signed.apk`（9/24 17:09 构建）里的
`lib/arm64-v8a/libshuyonote_lib.so` **含 `两次 KDF` 与 `应用级那条`、不含 `一遍 KDF`**（字节扫）；
而删掉应用级加密的提交在 **9/24 19:07** ⇒ 那个包**必须重出**（量它只会得到一个作废口径）。
```powershell
tar -xf <apk> -C $tmp lib/arm64-v8a/libshuyonote_lib.so   # APK 就是 zip；bsdtar 认
$t = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes("$tmp\lib\arm64-v8a\libshuyonote_lib.so"))
$t.IndexOf('一遍 KDF'); $t.IndexOf('两次 KDF')
```

**重出包之后，应用在那台机器上起不来 —— 两个真缺陷（都在 Android 侧，都不在加密那条链上）**：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| ① | `Uncaught SyntaxError: Unexpected token '='`（**整页挂**） | 产物里有 `??=` ×135 / `||=` ×518 / `&&=` ×88（逻辑赋值，**Chrome 85+**），而 `vite.config.ts` 没设 `build.target` ⇒ 走 Vite 8 的现代默认；该机系统 WebView 是 **Chromium 80** | `vite.config.ts` 加 **`build.target: "chrome80"`**（与"目前能实测到的最老设备"对齐）⇒ `??=`/`||=` 归零；剩下 2 处 `&&=` 经查在 **Prism 的 operator 正则字面量**里（`/--\|\+\+\|\*\*=?\|=>\|&&=?\|…/`，无害） |
| ② | `Object.hasOwn is not a function` | 同一处版本差：WebView 80 缺一串**运行时 API**，而**应用自己的代码一处都没用**（全是依赖在用）⇒ 只能补 | `public/es-polyfills.js` 补十项：`Object.hasOwn`(93) / `replaceAll`(85) / `Array·String.at`(92) / `findLast`·`findLastIndex`(97) / `crypto.randomUUID`(92) / **`structuredClone`(98，降级)** / `Element·DocumentFragment.replaceChildren`(86) / `reportError`(95) / **`Intl.Segmenter`(87，降级)** |

⚠️ **这就是"声称支持"与"真能跑"的差**：`minSdk = 24`（Android 7），而这台 WebView 80 的 Android 9
**在修之前连启动页都到不了**（`SyntaxError` 是整页挂，不是某功能降级）。修完之后一路可用 ——
新建页面 / 设置 / 开启加密 / 重启锁定 / 解锁都走通了。
⇒ 判据：`scripts/es-polyfills.test.mjs` 从 **4 条扩到 15 条**（新增那组**先把原生实现删掉**、
装出"WebView 80"的处境再逐条钉语义：`structuredClone` 的循环引用、`crypto.randomUUID` 的 v4 版本位/变体位、
`replaceAll` 的 `$&` 展开与非全局正则抛错、以及 **`reportError` 真的派发 error 事件**这条承重的）。

**★ 件5 读数（真机 release，一次成功解锁）**：

| 机器 / 构建 | **整条解锁** | 其中：钥匙袋 KDF（微基准） | 其余（解盒子 ＋ 开库） |
|---|---|---|---|
| **Xiaomi MIX 2 · Android 9 · WebView 80（release）** | **742 ms** | 468–476 ms | ≈ 270 ms |

- 日志行（`adb logcat -s RustStdoutStderr`）：`[unlock] 整条解锁 742 ms（一遍 KDF：钥匙袋那条；＋解盒子 ＋开库）`
- ⇒ **推算值（≈0.75–0.9 s）被实测取代**（这次推算相当准），而且**"一遍 KDF"的口径在真机上得到确认**。
- 怎么驱动的 UI：这台机器 **`adb shell input tap` 是能用的**（与华为那台的记录相反），但最终走的是
  **WebView 的 CDP 口**（`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` ＋
  `Runtime.evaluate`）—— 按 DOM 点比按坐标稳得多，路是 设置 → 安全 → 主口令 → 开启加密 → **重启** → 解锁。
- ⚠️ **顺带发现一处 UI 疑问（待查，不阻塞读数）**：「安全」页里**没有「立即锁定」按钮**
  （加密已开启、主口令已设），本次的锁定是靠**重启**拿到的。是条件写窄了还是刻意如此，另开一片核。

**签名与安装（也是现成的）**：keystore 在 `~/.shuyonote-release-keystore/`（含 `PASSWORD.txt`，
README 里连命令都写好了）⇒ `zipalign -f -p 4` → `apksigner sign --ks … --ks-key-alias shuyonote`
→ `apksigner verify --print-certs` 读数 **`6ee89e6f0f9326a40d3eac48b520c470d3fb6a7111a94fbe606510b489457a88`**
（与文档里的正式指纹**逐字符一致**）→ `adb install -r -d` ⇒ **Success**（覆盖安装，数据没动）。

**❌ 但"整体解锁"这次**还是没量到**，原因不是技术**：那台手机上**没人知道加密空间的主口令**
⇒ 做不了一次成功解锁 ⇒ 那行 `[unlock]`（打在成功路径上）根本不会出现；owner 随后选择**卸载**该包
（已执行，`Success`；按他的确认，手机上的 App 数据一并删除）。
⇒ 下次要量它，得在**一台能自由摆弄的设备**上：自己新建一个加密空间（口令自定）再解锁，
或者由知道口令的人配合解锁一次。
⇒ 顺带更正上面那条：`_scratch/shuyonote-signed.apk`（53.8 MB）**留着**，任何时候 `adb install -r -d` 就能装回去。
- ✅ **但明天的低端机 KDF 读数不依赖它**：那个微基准只用 NDK clang 交叉编一个纯 Rust 小程序，
  **本机已经跑通过**（真机 0.4–0.55 s 就是这么量出来的）⇒ 明天插上低端机就能立刻量。

### ★★ 由此更正一条之前的口径：那个"桌面 ~8 秒"是**debug 构建**量出来的

同一份 bench 在同一台桌面机上：**debug ≈ 3.0 s，release ≈ 0.13 s（差约 23 倍）**。
之前记的"应用级解锁 ≈ 8 s、SM3 占 ~7 s"以及 `keyring.rs::unlock_time_reading` 的
8.24 / 8.05 / 7.80 s（64 MiB·t=3 的 3.96 / 256 MiB·t=4 的 20.6 s）**全是 `cargo test` 那个
debug 构建**下的读数 ⇒ **不能拿它当"用户实际要等多久"**。
⇒ 真实量级是：**当前参数一次解锁 ≈ 0.13 s（本机桌面 release）／≈ 0.35 s（2021 旗舰手机 release）**。

**这对 KDF 参数拍板意味着什么**（决策稿 §7.2 的输入变了）：
- "8 秒不可接受 ⇒ 得把参数调小"这个前提**不成立**了；**当前参数在两头都很宽裕**；
- 反过来有**很大余量往上加内存硬化**：Argon2 从 19 MiB 提到 64 MiB（≈3.3× 成本）
  ⇒ 桌面约 0.4 s、旗舰手机约 1.1 s（按同比例外推）——**这才是该拍的方向**；
- ⚠️ 但**低端机仍未实测**：上面是旗舰机，低端机可能再慢 3–5× ⇒ 在真低端机上量之前，
  **不许**把"手机上只要 0.35 s"写成结论贴到决策稿上（它是**下界**，不是中位数）。
  （2026-09-24 深夜补了一台 **2017 老旗舰 MIX 2**：选定参数 64 MiB 合计 ≈ **0.47 s**，
  与旗舰同档 —— 见本节上面那个小节。**真低端机仍空着**，所以这条纪律**不变**。）
- ⚠️ 同时也说明：**拿 debug 读数拍加密参数是个坑**，以后量 KDF 一律标明构建档位（release / debug）。

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
  两条都不能做 ⇒ 交付物曾是**等价于一次提交的补丁**（`git am` 一条命令的事）。
  ✅ **2026-09-24 已落地**：他们那棵树终于干净了（0 项）⇒ 我 rebase 到他们当时的新 HEAD（`b68b8f8`）
  → 克隆里 `cargo test` **41 + 5 全绿** → 重生成补丁 → `git apply --check` 通过 →
  **`git am` 落进他们仓**：提交 `d391be9`（`src/db.rs` 的 v16 迁移 ＋ `src/space_keyring.rs`（新）
  ＋ `src/main.rs` 三条路由 ＋ `scripts/verify-space-keyring.mjs`（新）＋ `package.json` 的
  `verify:space-keyring`，5 文件 / +555 行），树仍是干净的。
  ⚠️ **没有 push**：他们那边的本地 main 本来就领先 `origin/main` 若干笔（我一 push 会把别人的提交
  一起发出去）⇒ 推不推由他们决定。⚠️ 落地时**没**在他们那棵树上再跑一遍门禁（克隆里跑的同一份内容），
  CI 上那三条既有红灯（`check-doc-links` / `check-release-discipline` / `cargo fmt` 既有差异）
  与本补丁无关。
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

### 7.0.4 owner 拍板（2026-09-24 第二轮）＋ B 的**硬前提**（下一片第一件）

**拍板结果（照此执行）**：
| | 事项 | 拍板 |
|---|---|---|
| 件1 | KDF 参数 | **B：往上一档 —— Argon2id 19 MiB → 64 MiB**（只抬内存那条腿；t=2 / p=1 不动） |
| 件2 | 存量空间批量分类 | **A：不做**（老空间继续放行；想让某个空间受管，用户自己在同步面板里贴「个人」） |
| 件3 | 换设备取回公开材料 | **保持手动**（同步面板两个按钮；取回默认不覆盖本机已有那份） |
| 件4 | 服务端补丁 | **A：等那个仓的工作树干净，由我落**（现在它仍有 76 项未提交、含 `main.rs`） |
| 件5 | 用插着的这台手机量"真实解锁" | **2：要** —— 但见下面的前提（App 里**没有**解锁耗时日志） |

**★★ B 有一个硬前提：先把"参数驱动派生"做出来（＝注释里那个 0a-2）。**
今天 `KdfParams::derive_master` 走的是 `crypto::derive_app_keys(passphrase, salt)` ——
它内部是 **`Argon2::default()`**（＝19 MiB）。而材料里记的 `m_kib` **只是被一条守卫兜着**：
`ensure_supported` 要求"**与本版常量完全相等**"，否则报错。⇒ 于是：

1. **只改常量 = 安全表演**：写着 64 MiB，实际派生仍是 19 MiB（`derive_app_keys` 不认参数）——
   我们会以为加固了，其实一点没加。**这条最危险**，因为它不报错。
2. **只改常量 + 保留那条守卫 = 把老袋子锁在外面**：19 MiB 的老袋子会被判"参数与本版不同"直接报错。
3. ⇒ 正确顺序：① 让**钥匙袋主密钥**的派生按**材料自己记的参数**走
   （新增 `crypto::derive_app_keys_with(passphrase, salt, m_kib, t, p)`，**只服务钥匙袋**这条线）；
   ② 把 `ensure_supported` 从"必须相等"放宽成"**算法认识 ＋ 参数在合理区间**"（老袋子 19 MiB 照旧放行）；
   ③ **然后**才把 `ARGON2_M_KIB` 抬到 `65536`（只影响**新**袋子）；
   ④ 判据两条必须同时有：
   · **老袋子照旧**：用 19 MiB 记的袋子，在本版（默认 64 MiB）下**仍能解出原来那把主密钥**；
   · **`crypto::derive_key` 的口径不许动**：它同时是**既有加密库的 SQLCipher 原始密钥**
     （`crypto.rs:122` 写着"改了它 = 既有加密库全部打不开"）⇒ 它必须**永远**留在 `Argon2::default()`；
     现有判据 `current_params_match_the_library_default` 要改成"**我们记的**参数是我们选的 ＋
     `derive_key` 仍是库默认"这一对（不能像原来那样要求两者相等）。

**件5 的实情**：App 里**没有**解锁耗时日志（全仓搜不到），所以"抓 logcat 读时间戳"这条路
**今天走不通**。两条可做的：① 我那个 release 微基准（**已经量过**：真机 0.35 s）；
② 给解锁路径加一行**耗时日志**再出一次 Android 构建装上去（要跑 Tauri 的 Android 打包，
是"出包"级别的活，不是一次调用能完的）。⇒ 件5 建议按 ② 做，但要单独排一片。

### 7.0.5 ①-1 的**施工单**（照抄即可；下一轮第一件）

**目标**：让 ① 的两个迁移函数**用户够得到**（现在只有它们自己的判据在调用）。五处改动**必须同批**做
（漏了契约 `check-web-commands` 就红；漏了计数 `check-doc-facts` 就红）：

1. `src-tauri/src/commands.rs`（命令 ＋ 载荷）——放在 `space_security_overview` 之后：
   ```rust
   /// ★ ① 第一半：把"旧的应用级钥匙"装进这个空间的盒子（**不动库文件一个字节**，可重复调）。
   #[tauri::command]
   pub fn migrate_legacy_space_encryption(db: State<Db>, args: SpaceIdArgs) -> Result<bool, String> {
       let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?.to_path_buf();
       let c = conn(&db);
       crate::space_crypto::migrate_legacy_space_into_keyring(&c, &dir, &args.space_id)
   }

   /// ★ ① 第二半：换成**真随机**空间钥匙（会重写库 ⇒ 界面必须两步确认）。
   /// ⚠️ 返回值故意不给钥匙（界面不需要，少一处泄漏面）。
   #[tauri::command]
   pub fn rotate_legacy_space_encryption(db: State<Db>, args: SpaceIdArgs) -> Result<(), String> {
       let dir = crate::db::app_data_dir_ref().ok_or("app data dir not initialised")?.to_path_buf();
       let mut c = db.0.lock().map_err(|_| "db mutex poisoned".to_string())?;
       crate::space_crypto::rotate_legacy_space_to_random_key(&mut c, &dir, &args.space_id).map(|_| ())
   }
   ```
   （`SpaceIdArgs` 已存在：`space_security_overview` 那一批加的。）
2. `src-tauri/src/lib.rs`：注册这两条（桌面专属，理由：Web 没有钥匙袋、也没有"应用级旧钥匙"）。
3. `src/lib/platform/commands.ts`：
   ```ts
   migrate_legacy_space_encryption: { args: { args: { space_id: string } }; result: boolean };
   rotate_legacy_space_encryption: { args: { args: { space_id: string } }; result: null };
   ```
4. `scripts/check-web-commands.mjs` 的 `DESKTOP_ONLY_COMMANDS` 各加一条（含理由）；
   然后**计数会变成 Rust 259 / web 249 / CommandMap 261** ⇒
5. `docs/TESTING.md` 的 facts 行同改（`check-doc-facts` 会核对）。

**界面**（`src/components/SpacePrivacySection.tsx`，与「推到服务器/从服务器取回」同一节）：
- 「把旧钥匙迁进钥匙袋」→ `api.migrateLegacySpaceEncryption(space_id)`，把**后端那句话原样**显示；
- 「换成真随机钥匙」→ **两步确认**（照「关闭加密」那套：第一下只把按钮改成「确认：换成随机钥匙」，
  第二下才真调）——它会重写库，失败会报错并给出备份路径；
- `api.ts` 加两个包装（照 `pullSpaceKeyring` 的写法）；
- 判据：在 `SpacePrivacySection.test.ts` 里补两条（真调 `migrate…`；轮换**第一下不调**、第二下才调），
  并保留既有的"接线"判据。✅ **已做**（`SpacePrivacySection.test.ts` 12 条：⑪ 迁进钥匙袋真调
  `migrateLegacySpaceEncryption(id)`／⑫ 换钥匙**两步**，第一下不调、第二下才调）。
  ⚠️ 写这两条时记一个坑：**别按下标选按钮**（这一行里前面还有「开启加密/关闭加密」「迁进钥匙袋」），
  按**文字**找（`buttons().find(b => b.textContent === …)`）。

**跑门禁**：`win-cargo-test.ps1` 全量 → `npx tsc --noEmit` → `node scripts/check-web-commands.mjs`
→ `node scripts/check-doc-facts.mjs` → `vitest run src/components/SpacePrivacySection.test.ts` →
`pnpm run build`。全绿再提交推送。

### 7.0.6 ★★ owner 拍板（第三轮）：**去掉应用级那套（连兜底也删），不向后兼容** —— 施工单

**拍板**：设置面板里那节"端到端加密"（应用级：全局一把钥匙）**去掉**；**连"读老库/解锁"的兜底也删**
（选乙）。⇒ 后果（已向 owner 说明并确认）：**应用级加密的存量库从此打不开**（按 C=1：**报错＋说清**，
不静默），并且 **① 的迁移/轮换失去对象**（它们是"把旧钥匙搬进袋子"），函数、命令、界面按钮、判据**一并删**。

**爆炸半径（实测 grep，63 处引用）**：`security.rs`（哨兵 `ENC_SALT`/`ENC_VERIFY`、`session_key()`、
`encryption_enabled` 的兜底、`set_encryption_impl`、`enable/disable_encryption(_impl)`、`wire_keys_for_conn`
的兜底 ＋ **6 条判据**）、`backup.rs`（快照要按旧钥匙读）、`space_crypto.rs`（① 的两函数 ＋ 9 处
`tests_set_session_key`）、`crypto.rs`（三个 meta 常量）、`lib.rs`（注册）、UI（`SettingsDialog` 与
`SpacePrivacySection`）、契约/`api.ts`/`check-web-commands`。

**分阶段（每阶段自带判据；每阶段跑满门禁、全绿再推）**：

**★ 2026-09-24 晚：动手试了阶段 2 的"安全那半"（wire 去掉应用级兜底），当场红了 9 条既有判据 ⇒
按纪律回退（不留半截、不推红的 tip），但把名单钉死在下面 —— 这就是"整批"的具体内容，下一轮照它改**：

```
payload_roundtrip_when_enabled
encrypted_db_roundtrip_and_sniff
national_crypto_covers_all_three_paths_and_keeps_the_library_key_unchanged
convert_space_db_is_idempotent_for_already_encrypted
lock_gates_key_and_sync
space_format_is_recorded_on_enable_and_cleared_on_disable
space_guard_allows_v2_in_the_sm_build
wire_payloads_use_the_space_key_and_never_silently_fall_back_to_plaintext
（＋本轮新加的那条 a_ciphertext_space_without_a_box_is_refused_… 也要在同一批里调通）
```
⇒ **结论：阶段 1 与阶段 2 必须与这 9 条的改写同批提交** —— 它们都是"**用应用级加密造状态，
再走 wire/解锁路径**"的形态，脱开应用级那把钥匙就必然要改写。
我自己动手那条改法本身是对的（`wire_keys_for_conn` 里"密文文件 ＋ 无盒子 ⇒ `Err("…应用级加密已不再支持…")`"），
已经在本轮验证到"红在哪"，下一轮直接从"改写这 9 条"开始。

**已逐条看过的两条（该改什么，就写在这，省下一轮勘察）**：

- `per_space_switch_and_startup_gate_look_at_the_space_itself`（`security.rs` 1168–1215）：
  它的 **③ 段就是"旧路兜底"本身** —— `sync::set_meta_state(&c, ENC_ENABLED, "1")` 之后断言
  `encryption_enabled(&c) == true`。这一段**要删**（旧模型没了）；
  **④ 段**结尾用 `*SESSION_KEY = Some(legacy_only(key))` 表示"有钥匙 ⇒ 不用解锁"，
  要改成**按空间**的写法（把钥匙放进袋子/会话主密钥，而不是应用级 `SESSION_KEY`）。
- `payload_roundtrip_when_enabled`（`security.rs` 1667–1680）：它用测试助手 `enable_meta(&c, "supersecret")`
  （＝造应用级状态）＋ `temp_ws()`；要改成"**建袋子 ＋ 给这个空间一个盒子**
  （`Keyring::new()` → `derive_master` → `wrap(space_id)` → `set_keyring_for_test` ＋ `set_session_master`）"，
  末尾那两条"密钥不落盘"的断言（`ENC_KEY` 不在 state/meta）**保留**。
- 其余七条同族：凡出现 `set_encryption_impl(...)` / `enable_meta(...)` / `ENC_ENABLED` /
  `ENC_SALT` / `ENC_VERIFY` / `SESSION_KEY` 的**造状态**与**断言**，都按上面两条的路子换成"按空间"。

**★ 第二次试探（改共享助手 `enable_meta` 一处 ⇒ 想一次翻 3 条）：更糟，红到 14 条 ⇒ 也回退了。**
多出来的 5 条说明耦合比名单更深（它们间接依赖那个助手造出的应用级状态）：

```
lock_gates_key_and_sync / open_space_conn_reports_an_actionable_error_for_a_mismatched_page_db /
encrypted_db_roundtrip_and_sniff / key_space_conn_prefers_the_space_key_from_the_keyring /
lock_closes_connection_unlock_reopens / convert_space_db_encrypt_back_to_readable /
national_crypto_covers_all_three_paths_and_keeps_the_library_key_unchanged /
open_space_conn_reads_encrypted_space / convert_space_db_is_idempotent_for_already_encrypted /
per_space_switch_and_startup_gate_look_at_the_space_itself / payload_roundtrip_when_enabled /
space_format_is_recorded_on_enable_and_cleared_on_disable / space_guard_allows_v2_in_the_sm_build /
wire_payloads_use_the_space_key_and_never_silently_fall_back_to_plaintext
```

⇒ **结论（两次实测后）**：这批**不能靠"改一处"省**，只能**逐条改写**（14 条），
并且**改写与生产代码改动同一批**做。⇒ 它需要一次**专门、完整的**预算，不适合夹在别的工作之间做。

1. **解锁改从"钥匙袋"派生**：`unlock_encryption_impl` 不再用应用级盐/哨兵，改为
   用袋子记的 KDF 参数推主密钥；**错口令靠解盒子的 AEAD 认**（报"打不开（口令不对或盒子被改过）"）。
   判据：错口令 ⇒ 明确报错（且**不是**"口令不正确"这种旧文案）；正确口令 ⇒ 能解出盒子里的空间钥匙；
   没有袋子时解锁**不报错**（旧路已无，等价于"什么都还没加密"）。
2. **去掉 wire / backup 里的旧兜底**：`wire_keys_for_conn` 只走**空间钥匙**；空间没有盒子而其文件是密文
   ⇒ **报错＋说清**（这是第 3 阶段之后唯一可能的"老库"形态）。`backup.rs` 的快照同理。
   判据：没有盒子的密文空间 ⇒ 载荷路径**响亮失败**，绝不退回明文；明文空间照旧。
3. **删应用级命令与界面**：`enable_encryption`/`disable_encryption`（＋`set_encryption_impl`/
   `disable_encryption_impl` 若无人再用）、契约、`api.ts`、`SettingsDialog` 那一节（换成
   **挂 `SpacePrivacySection`**）、`check-web-commands` ＋ `docs/TESTING.md` 计数同批。
4. **删 ① 的迁移/轮换**：`migrate_legacy_space_into_keyring`、`rotate_legacy_space_to_random_key`、
   两条命令、界面两个按钮、`api.ts` 两条、组件判据两条、Rust 判据若干 ＋ 文档里 ① 的段落标注"已作废"。
5. **文档收尾**：口径（§0.5 / 决策稿 §7 与 §3.1）、`docs/TESTING.md`、遗留文案（"应用级加密"字样）。

⚠️ **顺序不能反**：先让"解锁/载荷"不再依赖应用级钥匙（1、2），再删开关与命令（3、4）——
反过来会留下一段**没人守的加密路径**，而它恰恰是最容易静默降级成明文的地方。
⚠️ 每一步都要**同一批**改完（Rust ＋ 契约 ＋ api ＋ UI ＋ 计数），否则中间态推不出去（门禁会红，这是好事）。

### 7.0.7 ✅ **本轮做完：应用级加密整套删净（含兜底）＋ ① 的迁移/轮换一并删**

**拍板落地（owner 第三轮，§7.0.6）**：设置面板那节「端到端加密」→ 换成挂 `SpacePrivacySection`
（**按空间**）；应用级那套（全局一把钥匙、`ENC_ENABLED`/`ENC_SALT`/`ENC_VERIFY` 三个 meta 键、
哨兵、`set_encryption_impl` / `enable/disable_encryption` 两条命令、`session_key()` 与
`wire_keys_for_conn`/`key_space_conn`/`key_if_enabled`/解锁里的**所有**兜底）**整条删除**；
① 的 `migrate_legacy_space_into_keyring` / `rotate_legacy_space_to_random_key`＋两条命令＋界面两个按钮
＋`api.ts` 两条＋契约两条＋全部判据**同批删除**（**失去对象**）。**不向后兼容**：应用级加密的存量库
**打不开**，按 C=1 报错＋说清（唯一出路：从还有那份旧材料的设备取回公开材料）。

**解锁的新形状**：`carry_keyring` ＋ `master_from_passphrase`（**按袋子记的 KDF 参数**）
⇒ 口令对不对**由解盒子回答**（`space_crypto::verify_master_against_keyring`，AEAD）；
**没有袋子 / 袋里一个盒子都没有 ⇒ 解锁不报错**；应用级存量库在**开库那一步**响亮失败。
⇒ 解锁的耗时口径随之变成**一遍 KDF**（`[unlock]` 那行日志已改；旧读数里"两次 KDF"作废）。

**★★ 实测：为什么"阶段 1/2"与"阶段 3/4"必须**同批**（这是 §7.0.6 两次试探之后的第三次实测）**：
只改生产代码两处（wire 去掉兜底 ＋ 解锁改袋子派生）时，`space_crypto::tests` 有**两条判据的成立前提
直接消失** —— `migrating_a_legacy_space_wraps_the_old_key_without_touching_the_file` 与
`rotating_the_space_the_connection_currently_holds_works_and_reopens_it`：它们要先把
"**用应用级旧钥匙加密的库**"打开（靠 `key_space_conn` 的 `session_key()` 兜底）才谈得上迁移/轮换。
兜底一删，这两条连"把库打开"都做不到 ⇒ panic 在 `SEC_LOCK` 里 ⇒ **整片 14 条 PoisonError 连坐**。
⇒ 想留住它们只有一条路：**把兜底留着** —— 而那条兜底正是"附件/导出这一路拿不到空间钥匙时
静默写出明文"的窗口（`key_if_enabled` 返回 `None` ⇒ 透传）。
**所以本轮把 1/2/3/4 合成同一批做**（不是图省事）：① 的迁移/轮换与"应用级钥匙"**同生共死**，
中间态只可能是"留着一条没人守的加密路径"，那正是纪律里最不许出现的东西。

**改判据清单（14 条全部改写 ＋ 说明）**：
· `security.rs`：`key_space_conn_prefers_the_space_key_from_the_keyring`（改成"盒子里换另一把 ⇒ 读不开；
  清掉袋子 ⇒ **响亮报错**"）、`wire_payloads_use_the_space_key_and_never_silently_fall_back_to_plaintext`、
  **新增** `a_ciphertext_space_without_a_box_is_refused_on_the_wire_never_plaintext`（承重）、
  `per_space_switch_and_startup_gate_look_at_the_space_itself`（删掉"应用级标志"那段 ＋ ④ 段改按空间）、
  `encrypted_db_roundtrip_and_sniff`、`open_space_conn_reports_an_actionable_error_for_a_mismatched_page_db`、
  `convert_space_db_encrypt_back_to_readable`、`convert_space_db_is_idempotent_for_already_encrypted`、
  `full_loop_enable_restart_unlock_readable_disable`（整条重写：`enable_space` → 锁 → 错口令**报"打不开"**
  （不再是"口令不正确"）→ 对口令 → 可读 → `disable_space`）、`open_space_conn_reads_encrypted_space`、
  `lock_closes_connection_unlock_reopens`、`payload_roundtrip_when_enabled`、
  `space_format_is_recorded_on_enable_and_cleared_on_disable`、`lock_gates_key_and_sync`、
  `national_crypto_covers_all_three_paths_…`（改名 `…_the_paths_it_still_has_and_the_space_path_stays_v1`：
  空间钥匙是随机字节 ⇒ 空间级载荷**按设计是 v1**，国密覆盖落在**盒子**上（含 v1 盒子双读））；
  删 `verify_sentinel_roundtrip`（哨兵没了）、删助手 `enable_meta`（换成 `enable_space_meta`）。
· `space_crypto.rs`：删 3 条（迁移 1 ＋ 轮换 2）；`enabling_a_space_whose_db_is_already_encrypted_…`
  改成断言"**应用级加密已不再支持** ＋ 唯一出路是取回公开材料"，并且连接**不再开在**那个存量库上
  （存量库打不开**本身就是**这条拍板的事实）。干净侧新增 `set_space_box_for_test` 助手（跨模块用）。
· `backup.rs`：`snapshot_spaces` 改成**按空间取钥匙**（判据 `snapshot_spaces_keys_the_encrypted_space_…` 同改）。
· TS：`vaultGate.test.ts` 删 1 例（`enableVault` 那例）、`SpacePrivacySection.test.ts` 删 2 例（迁移/轮换按钮）。
· 顺带修掉一处**真的会静默降级**的地方：`sync.rs` 推载荷原来先问 `key_if_enabled().is_some()` 再加密
  ⇒ "袋里有它但拿不到钥匙"时会**跳过加密、明文上云**。现在**一律**走 `encrypt_payload`（它自己三出口判）。

**当轮 tip 读数（本轮，提交后即 `origin/dev`）**：Rust 全量 **586 passed / 0 failed / 19 ignored**
（`win-cargo-test: test exe exit code = 0`，251.8 s）；vitest 全量 **215 文件通过 / 2207 passed / 12 skipped**
（exit 0）；`npx tsc --noEmit` 0；`pnpm run build` 0；
`check-web-commands` 绿（**Rust 255 / web 247 / CommandMap 257**，`docs/TESTING.md` facts 行同改）；
`check-doc-facts` / `check-doc-links`（138 篇 / 861 条）/ `check-doc-content-access`（67 文件 / 562 处，基线未动）
/ `check-overlay-registry`（26/0）/ `check-capabilities`（25 条）/ `check-panel-layout`（40/0）全绿。

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
