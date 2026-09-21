# 国密（SM 系列）交付说明 —— **按平台分列**

> 日期：2026-09-20　｜　被验 commit：`f64f2320`（dev，两远端一致）
> ⚠️ 读数**是分两次取的**，别读成一个 commit：门禁与「导出/备份」那几行在 `f64f2320` 上重跑；
> 库级那几行（P2 三段自证、Tongsuo 对拍 12/12、`gm_provider` 9/0）取自其父提交 `b5cc99c3`
> —— F2（`f64f2320`）只动导出/备份路径，**不碰库级任何代码**。
> 权威方案与全部口径：[`plans/2026-09-16-sm-crypto-full-plan.md`](plans/2026-09-16-sm-crypto-full-plan.md)（§0 拍板 / §0.1 常量表 / §0.2 P1 落地记录 / §3.1 provider 线 / §7 验收标准）
> 图例：**✅ 已取证**（附判据与读数）｜**🔶 机制已落地、默认未启用**｜**❌ 未做**（写明归属与所需条件）

---

## 一、边界声明（**交付文本照这段写，不要含糊成"全链路国密"**）

| 面 | 是否国密 | 说明 |
|---|---|---|
| **数据面**：静置密文（附件）、同步载荷、导出包里的**附件** | ✅ **是** | 应用层 AEAD 全换（SM4-CBC ＋ HMAC-SM3，见 §三） |
| 导出包里的**库文件**（`shuyonote.db` / `spaces/<id>.db`） | ❌ **明文**（导出/导入契约如此，不是遗漏） | 导入端按「明文 SQLite 库」读；故**导出包不能整体称为国密**。整库备份里的各空间库是**密文快照**（导出端密钥），meta.db 明文。⚠️ 因此**包的安全性＝用户对这份 zip 的保管** |
| **传输层** | ⚠️ **数据面国密、传输层标准 TLS**（方案 §5.2 已定：走"路径 2"） | 链路上的**载荷**是 SM4 密文；协议本身仍是 TLS 1.3。**不要写成"全链路国密"** |
| **控制面**：更新包签名（minisign/Ed25519）、插件索引签名 | ❌ **不是**（已决定） | 不在甲方系统边界内；内网离线部署下自动更新本就不可用 |
| 内容寻址摘要（附件 SHA-256） | ❌ **保持 SHA-256**（有意为之） | 换成 SM3 = 全库附件改名 ＋ 同步标识全失；要换需单独立项 |
| 库级页加密 / 页 HMAC / 库 KDF | 🔶 **页加密：尚未**；**页 HMAC 与库 KDF：能力已具备但应用尚未接线** | 由 SQLCipher 的编译期 provider 决定（P2/P3，provider 层属 **AMD**）。⚠️ **2026-09-20 实查更正**：补丁只让 `HMAC_SM3`/`PBKDF2_HMAC_SM3` **可设**（默认值仍是 SHA512），而**应用从来没有设过它们** ⇒ **当今任何构建（含国密版）建出来的库，页 MAC 与库 KDF 仍是 SHA512**。接线规格与代价见方案 §3.5 |

---

## 二、这一版交付的**接口**（换成"有哪些算法"的问题时照这里答）

**密文格式**（`MAGIC = 0x53`，头 2 字节，文本路径整体 base64、二进制路径直接用 —— 同一套编码）

| 版本 | 布局 | 用途 |
|---|---|---|
| `v0` | 无头 `nonce(24) ‖ ct` | P0 之前的老数据，**永远可读**（含"首两字节恰好撞 magic+版本"的回退） |
| `v1` | `0x53 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305 ct` | **只读**（老数据；2026-09-20 起不再写） |
| `v2` | `0x53 0x02 ‖ iv(16) ‖ SM4-CBC(PKCS#7) ct ‖ HMAC-SM3 tag(32)` | **默认构建写这个**（2026-09-20 owner 拍板「无兼容快路」后 `sm-crypto` 成为默认特性；旧行为 `--no-default-features` 仅作**回滚通道**，见方案 §3.4） |

**套件常量（方案 §0.1，一处定义处处引用）**：SM4-CBC ＋ HMAC-SM3（**encrypt-then-MAC，先验后解**）；
PKCS#7；IV 16B 随机；tag 32B **在尾部**；**MAC 覆盖"版本头 ＋ IV ＋ 密文"**；
**两把独立密钥**；KDF = **PBKDF2-HMAC-SM3，盐 16B，输出 64B → 前 16 加密 / 后 32 MAC**
（⚠️ 原表写"前 32 加密"，与 SM4 的 128 位密钥冲突，已更正）；迭代数 **200000**（压测入档见 §0.2）。

**跨实现黄金向量**（两侧独立产出、逐字节相同 ⇒ 可直接拿去对拍；判据 `crypto_sm::tests::kdf_golden_vector_and_key_slicing`）：

```text
pass=a-typical-passphrase   salt=5a×16   iters=200000   len=64
KDF ：b5623ce8682771b65b7d72a9c0b707adad32fa36e0c03ee92f2832ac594ffad9
      9c3469e8dc977dd3fd159ef69d41d39742a54f140e932498e5b5c069fb0861d4
SM4 密钥 = 前 16 字节    MAC 密钥 = 后 32 字节
```

---

## 三、按平台分列

| 平台 | 应用层 SM4（附件/同步载荷；导出包里的附件同此） | 库级（页加密 · 页 HMAC · 库 KDF） | 构建前置 | 归属 | 取证状态 |
|---|---|---|---|---|---|
| **macOS** | ✅ | 🔶 **国密版构建：P2 = provider 层已具备**（`HMAC_SM3`/`PBKDF2_HMAC_SM3` **可设且回显正确**、有运行期判据；⚠️ **应用尚未接线 ⇒ 库的页 MAC/KDF 仍是 SHA512**，见方案 §3.5）；**默认包仍是 CommonCrypto（只有 AES）**；**页加密仍是 AES**（P3 未做） | Tongsuo **已在本机构建**（commit `540603a3`）；`sm-library` 打开时 `build.rs` **fail-fast**（不给 `OPENSSL_DIR` 就当场失败） | 本侧 | 应用层 ✅；**三段自证在本机全绿**（见 §四）；⚠️ 有一条 macOS-only 风险见 §五 |
| **Windows** | ✅（纯 Rust，全平台同一份实现） | 🔶 同 P2（其后端本来就是 OpenSSL） | 据信箱：**AMD 2026-09-18 报过 `tongsuo build: msvc=ok`**（附三条前置踩坑）；⚠️ **本侧没有独立复核** | Windows 侧 | 应用层：本机跑不了 `cargo test`（`0xC0000139`）⇒ 行为由 Linux/CI 证；库级未取证 |
| **Linux** | ✅ | 🔶 **国密版构建：P2 = provider 层已具备**（AMD 在 WSL2 上有读数；同样**未接线**，见 §3.5）；页加密仍是 AES（P3 未做） | 后端**已是 OpenSSL**（读 `libsqlite3-sys/build.rs` 的最后一支：非 Apple/非 Windows 且未给 `OPENSSL_DIR` ⇒ `link-lib=dylib=crypto`；Linux CI 的 `rust-test` 常绿也印证系统 `libcrypto` 在位）；换 Tongsuo 只需 `OPENSSL_DIR` | AMD（provider） | 应用层 ✅（Linux 376/376） |
| **Android** | ✅（纯 Rust） | ❌ 未做（P2/P3 的 Android 构建链未排） | Tongsuo 交叉编译**已被 AMD 证过**（NDK r29）；真机验收未做 | 真机＝**人手** | ❌ 未取证 |
| **iOS** | ❌ | ❌ | 无 `ios.yml`、未开始；Apple 平台与 macOS 同一个 CommonCrypto 坑 | 未立项 | ❌ 范围外（方案 §1 已写明） |
| **Web** | ❌ | ❌ | 不提供静态加密与多设备同步 | — | ❌ 范围外（方案 §1） |
| 同步**服务端** | ❌ | ❌ | 只转发密文，不改 | 另一仓库 | ❌ 范围外 |

> **一句话读法**（2026-09-20 更新）：**应用层已全平台国密**（纯 Rust，一份实现；
> 口径是**附件＋同步载荷**——导出包里那份空间库**刻意是明文**，见 §一，别把两者合成一句）；
> **库级已走到 P2 的 provider 层**（`HMAC_SM3`/`PBKDF2_HMAC_SM3` 可设、可回显、有运行期判据；macOS 本机三段自证全绿）；
> ⚠️ **但应用尚未接线 ⇒ 库的页 MAC 与库 KDF 目前仍是 SHA512**（2026-09-20 实查，见方案 §3.5）—— **不要把「能力已具备」读成「已在生效」**；
> **还差 P3（SM4 页加密）** —— 它**不是顺手加一个分支**（方案 §3.2 三条结构事实：`cipher` 回调无 algorithm 参数、
> `OPENSSL_CIPHER` 编译期钉死五处、没有 `cipher_algorithm` PRAGMA），**两条路的成本要 owner 拍板**。
> ✅ **2026-09-20 owner 已拍板：P3 走 A（编译期切换）** —— 施工单与分工见方案 §3.2 末尾，
> 迁移规格（升级/回滚/可操作错误/四条判据）见 §3.3。**拍板已下，但代码未落地 ⇒ 本说明里 P3 一律仍标 ❌/🔶，不许提前写 ✅。**
> 本说明的作用之一就是**不让这几件事被读成一件**。
>
> ⚠️ **页加密是「整库属性」，不是逐空间的**：上层"按空间开加密"说的是**应用层开关**；
> 库级页加密一旦选定就是那个**库文件**的属性（且协议里没有算法标识 ⇒ 解密端必须会 SM4）；⇒ **P3 之后「老数据可读」的准确写法是「经迁移后可读」**：跨页加密算法必须走一次「先在能读老库的构建里关闭磁盘加密（逐表重建，不依赖 `sqlcipher_export`）→ 换构建 → 重新开启」，升级与回滚说明、未迁移库的可操作错误、四条验收判据见方案 §3.3

---

## 四、已取证清单（每条都能跑；读数带被验 commit）

| 结论 | 判据 / 命令 | 读数 |
|---|---|---|
| 密文带版本头、两条路径同一编码 | `cargo test --lib crypto::` | 10/10（**默认构建即国密**；`--no-default-features` 只跑旧行为那一半） |
| **无头老数据永远可读**（含撞头回退，对 v1、v2 各验一遍） | 同上（金标夹具 `tests/crypto-legacy-v0.json`，三格真实密文） | ✅ |
| **EtM 正确**：篡改版本头/IV/密文/ tag 都必须**先失败且不解密**；两把密钥不可互换 | `crypto_sm::tests::tampering_anywhere_fails_before_decrypting` 等 | ✅ |
| **未知版本给可操作错误**（不是"数据损坏"） | `unknown_future_version_gets_an_actionable_error`；默认构建读 v2 | ✅ |
| 两条路径（附件 / 同步载荷）全覆盖；导出包里的附件走同一条静置密文路径 | `security::tests::national_crypto_covers_all_three_paths_…`、`attachments::…national_crypto…` | ✅（默认构建即国密；旧行为的对照由 `--no-default-features` 提供） |
| ★ **E1（磁盘加密）下导出/备份不再硬失败、也不再静默少空间**（2026-09-20，F2，commit `f64f2320`） | `workspace_io::tests::snapshot_plaintext_from_an_encrypted_source_is_readable_without_a_key`、`backup::tests::snapshot_spaces_keys_the_encrypted_space_and_names_what_it_skips`、`backup::tests::cross_key_encrypted_snapshot_gets_an_actionable_diagnosis` | ✅ 3/3；**变异证明**：退回老行为各红一次 |
| **库级密钥未被国密密钥顶替**（顶替＝既有加密库全打不开） | `security::tests::national_crypto_…_keeps_the_library_key_unchanged` | ✅ |
| KDF 常量写死 ＋ 防改小 ＋ 跨实现黄金向量（含**切片**口径） | `kdf_rounds_are_the_pinned_value`、`kdf_golden_vector_and_key_slicing` | 变异证明：改切片只有黄金向量红 |
| **跨实现对拍**（GM/T 0002/0004 ＋ RustCrypto↔Tongsuo 双向互解 ＋ 两侧密文逐字节相同 ＋ PBKDF2 与拆 key 口径） | `SHUYONOTE_TONGSUO_OPENSSL=<Tongsuo>/bin/openssl node scripts/check-gm-conformance.mjs` | **12/12**（macOS 与 AMD 的 WSL2 各一次，同源码 commit） |
| **页加密是库文件属性：交叉打开必须失败**（2026-09-20 起取代上一版那条"换后端仍可读"） | `security::tests::exactly_one_page_cipher_fixture_opens_and_the_other_is_refused`（两份内容相同的夹具：`tests/sqlcipher-backend-fixture.db`＝**AES 页**、`tests/sqlcipher-sm4-page-fixture.db`＝**SM4 页**） | 双向实测：**AES 页构建**（默认 CC）⇒ 只读开 AES 夹具；**SM4 页构建**（打 v3 补丁 ＋ Tongsuo）⇒ 只读开 SM4 夹具；判据打印本构建的页加密 |
| 实际编进去的是哪个后端（不是看你设了什么环境变量） | `node scripts/check-crypto-backend.mjs` | 双向实测：产物 openssl＋声明 openssl ⇒ 绿；产物 CC＋声明 openssl ⇒ **红** |
| **补丁在不在**（第三格的一半；另半是运行期"真的生效没有"） | `SHUYONOTE_EXPECT_SM_PATCH=applied\|absent node scripts/check-crypto-backend.mjs`<br>⚠️ **国密（Tongsuo）构建上必须同时声明后端**：`SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl …` —— macOS 的平台默认是 `commoncrypto`，只声明补丁那格会**假红**（我 2026-09-20 自己踩了一次；一键自证 `gm-version-selfcheck` 里两个声明都已写死） | 声明 applied 而产物无标记 ⇒ 红（附 `cargo clean -p shuyonote`）；声明 absent 而有标记 ⇒ 红（配置漂移）。⚠️ 标记可能是上次构建的重放，故输出里带 `src_sha256`（与当前将要编译的那份源码逐字比对）＋ output mtime；标记里的 `patch=` 是**补丁文件 sha256 前 8 位**（v2 起，之前是写死的 `v1` —— 那在补丁升到 v2 后不再标识任何东西）；**补丁 v3 起还带 `page_cipher=sm4|aes|other|unknown`**（读源码里 `#define OPENSSL_CIPHER` 那一行）—— `cipher_settings` 回显里**没有** algorithm 字段，这是构建期唯一能回答「这份构建写 SM4 页还是 AES 页」的地方 |
| **P2 provider 补丁落地**（让 SM3 页 MAC ＋ 库 KDF **可设** ＋ 能力门） | `patches/0001-sqlcipher-sm3-provider.patch` ＋ `scripts/sm-library-build.mjs`（幂等打补丁） | AMD 在 WSL2 有读数；**macOS 本机独立复跑见下两行**；⚠️ **「可设」≠「在生效」**：应用尚未接线（方案 §3.5） |
| ★ **三段自证（macOS，真补丁 ＋ 真 Tongsuo）** | `node scripts/gm-version-selfcheck.mjs --openssl-dir <Tongsuo> --expect-patch applied --with-build`（**加 `--with-tests` 会多跑第 ④ 段**：`cargo test --lib gm_provider::` ＝ 运行期「真的生效没有」） | **3 段全过**：后端=openssl（link-search 指 Tongsuo）／补丁在场且 `src_sha256=6ec0a114b861…`（**补丁 v2**；与 AMD 在 WSL 上报的逐字相同，新鲜度可证）／跨对拍 12/12 |
| 运行期「真的生效没有」（第三格另一半；**已收进一键自证的 `--with-tests`**，见上一行的第 ④ 段） | `cargo test --lib gm_provider`（**在打过补丁 ＋ Tongsuo 的构建上**） | macOS：**9 passed / 0 failed / 4 ignored**（与 AMD 报的同一套 13 一致）；2026-09-20 起 `gm-version-selfcheck --with-tests` 会把这一段并进同一份读数 |
| 门禁 | `pnpm verify`（23）/ `node scripts/test-report.mjs --group rust`（**6 条**，含 `rust-test`（默认即国密）、`rust-no-sm-crypto`（**回滚通道**：`--no-default-features` 仍可编可过）、`check-crypto-backend`、`gm-conformance`） | 全绿 |
| **老端在动手之前就拒绝**（§0-C）：同步**整批拒绝**、空间级标识、附件拒绝（不是逐条失败） | `sync::tests::prescan_payload_formats_refuses_the_whole_batch`、`security::tests::space_guard_…`、`…attachment_bytes_of_an_unsupported_format_are_refused…` | ✅（默认构建拒绝 / 国密构建放行，两半都有 cfg 判据） |

---

## 五、未取证清单（含**归属**与**所需条件**，不冒领）

| 项 | 归属 | 还差什么 |
|---|---|---|
| **P3：SM4 页加密** | **AMD**（方案 §3.2 两条路） | **需 owner 拍板成本**：**A 编译期切换**（`-DSQLCIPHER_SM4_CBC` → `EVP_sm4_cbc()`，薄、建议先做；代价＝同一份源码只能有一种页加密）／**B 给 provider 加 algorithm 参数**（改回调签名 ＋ 三个 provider ＋ codec，上游级、patch 面涨到几十段）。**SM3 系（页 MAC ＋ 库 KDF）已随 P2 落地** |
| 「页加密确为 SM4」的直接判据（读文件头 / 用错算法打不开） | AMD ＋ 本侧 | 依赖 P3 落地 |
| ★ **macOS-only 风险：补丁留在共享 registry 上** | **AMD**（我给了三条修法） | 补丁打在**共享**的 `libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c` 上 ⇒ 跑过一次国密构建后，**默认（CommonCrypto）构建会红 12＋7 条**（受控 A/B：打过补丁 7/12 fail ＋ 2/7 fail；还原后 **19/0 ＋ 9/0**；现场是 `PRAGMA key = "x'…'"` 被拒 ⇒ 加密库打不开）。Linux/Windows 后端本就是 OpenSSL ⇒ **只有 macOS 会暴露**。修法候选：按后端守护补丁／胶水可撤回／国密构建用独立 `CARGO_HOME` |
| Windows MSVC 版 Tongsuo | **Windows 侧** | 据信箱 **AMD 2026-09-18 已报 `msvc=ok`**（Tongsuo 8.5.0-pre2 / SM3＋SM4 读数、三条前置踩坑）；⚠️ **本侧无独立复核** |
| Android 真机（口令→加密→重启解锁→读写） | **人手** | 真机 |
| 桌面真机：新装加密 / 重启解锁 / 加密开关双向迁移不丢数据 | **人手** | 真机 |
| 端到端"旧版库 ＋ 旧版附件 → 新版打开" | **人手** | 真机（本版只有单测层的跨后端夹具与 v0 金标夹具） |
| **macOS 默认切掉 CommonCrypto** | **已拍板：不切**（owner，2026-09-19，选项 A） | 维持"**默认包＝Apple CommonCrypto ＋ 国密版另发**"（方案 §0-E 的形态）。依据：翻了默认＝要求每个 macOS 开发者与默认 CI 都先编 Tongsuo，而此刻**用户可见行为零变化**（页加密仍 AES、页 HMAC 仍 SHA512、库 KDF 仍 PBKDF2-SHA512），只多一个 dylib 的打包/`@rpath`/签名/公证负担。⇒ 国密版的正确形态＝显式 `OPENSSL_DIR` ＋ `sm-library` fail-fast ＋ `check-crypto-backend` 严格模式。**改判触发条件**：① client 要求「装机即国密」② 重启路径 3（TLCP/RFC 8998，那时 Tongsuo 反正要进构建）③ 双 provider 维护成本高于打包成本 |
| 传输层国密（TLCP / RFC 8998） | 未排期 | 方案 §5.2 的重启条件：客户明确要求"传输层协议本身必须是国密"，或招标点名 TLCP |
| 更新包 / 插件索引签名换 SM2 | **不做**（已决定） | 见 §一 |

---

## 六、怎么构建与验证"国密版"

```bash
# ① 构建/单测（应用层完全体；各平台一致）
cargo test --manifest-path src-tauri/Cargo.toml                       # ← 应用层国密已是**默认**（§0-E 于 2026-09-20 由 §3.4 取代）
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features # ← 旧行为（v1 写路径）＝回滚通道

# ② 跨实现对拍：需要一份真 Tongsuo 的 CLI
SHUYONOTE_TONGSUO_OPENSSL=<Tongsuo>/bin/openssl node scripts/check-gm-conformance.mjs
#   本机没有 Tongsuo ⇒ 那 9 项自报跳过（不装绿）；**指名了却用不了 ⇒ 判红**

# ③ macOS 库级接缝（**只对国密版**；默认包按拍板维持 CommonCrypto，不会被这一步影响）
#    `sm-library` 打开 ⇒ 没给 OPENSSL_DIR 会**当场失败**（build.rs 的 fail-fast），不留"静默没有国密"的结局
cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml    # ← 这一步不能省，理由见 ④
OPENSSL_DIR=$HOME/tongsuo-macos/install \
  cargo build --lib --features sm-library --manifest-path src-tauri/Cargo.toml
node scripts/check-crypto-backend.mjs                                 # ← 拿产物说话
#   ⚠️ macOS 特有：`sm-library-build.mjs` 会把补丁**打到共享的 registry 源码**上。跑完之后**默认构建
#   （CommonCrypto）会红 12＋7 条**（现场：`PRAGMA key` 被拒）。要么用修法里的"撤回/守护"，
#   要么跑完立刻还原：把 `…/libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c` 恢复原版（sha256 `ea0bf0b0…`）

# ④ 门禁：默认组 / rust 组（含国密两条）
pnpm verify && node scripts/test-report.mjs --group rust

# ⑤ ★ **一键三段自证**（国密版发布前跑这个，而不是凭记忆挑几条）
node scripts/gm-version-selfcheck.mjs --openssl-dir <Tongsuo 前缀> --expect-patch applied
#   ①后端是谁 ②补丁在不在（读产物）③跨实现对拍  —— 三格全过才算"这版是国密版"
#   今天补丁还没写 ⇒ 用 `--expect-patch absent` 也能跑通（那时收尾句会说清"补丁未打、页加密仍是 AES"）
#   ⚠️ 在**默认构建**上第①格本来就该红（默认是 CommonCrypto）—— 那不是脚本坏了，是这版不是国密版
#   加 `--with-build` 会先走 `sm-library-build.mjs`（先清 libsqlite3-sys 再带 OPENSSL_DIR 编）
#   加 `--with-tests` 追加应用层国密单测；`--print` 只打印将要跑什么
```

> ⚠️ **`cargo clean -p libsqlite3-sys` 为什么不能省**：该 crate 的 `build.rs` **没有**为 `OPENSSL_DIR`
> 声明 `rerun-if-env-changed` ⇒ 只设环境变量时 cargo **不会重跑构建脚本**，后端**悄悄保持原样**
> （实测：编译通过、测试全绿、产物里仍是 `framework=Security`）。详见
> [`development.md`](development.md) 的「工具坑：失败得像成功」第 5 条。

---

## 七、升级与运维须知（会被问到的四条）

1. **老数据一定读得出来**：`decrypt` 按密文头分派 v0/v1/v2（无头＝v0）；认出的版本解不开时会**再按 v0 试一次**
   （那 24 字节是随机 nonce，"首两字节恰好等于 magic+版本"是**真实存在**的 1/65536）。
   ⚠️ 但"解不开"有两种，别混：**认得出、却版本不支持** ⇒ **拒绝**（说清换哪个版本）；
   **认得出、版本支持但口令不同**，或**根本不是密文** ⇒ 维持透传老语义。
2. **默认包读不了 v2**：这是刻意的（§0-C）—— 报错是"**这段数据来自更新的应用版本，请升级**"，
   而不是"数据损坏"。发国密版时**必须同时告诉用户：降级回默认包打不开国密版写的数据**。
3. **口令与密钥 / 降级**：会话密钥不落盘（沿用 E1 约束）；国密构建下**库级 `PRAGMA key` 仍是原 32 字节**
   （有用例钉住）⇒ **同一份 SQLCipher 库文件，默认包也打得开**。但⚠️**这不等于可以无痛降级**：
   库里由国密版写下的**应用层载荷（v2）**默认包解不开，会给出"请升级国密版/更新版本"的**可操作错误**
   （第 2 条）。⇒ 发国密版时要说清："**降级回默认包 = 库能打开、但国密版写过的那部分内容读不出来**"。
4. **页加密是「整库属性」，不是逐空间的**（方案 §3.2 的提醒，容易读错）：
   上层"按空间开加密"说的是**应用层开关**；库级页加密一旦选定就是那个**库文件**的属性，
   而 SQLCipher 的协议里**没有算法标识** ⇒ **解密端必须自己会 SM4**。
   所以 P3 走 A（编译期切换）时："同一台机器上的库文件只能有一种页加密"，
   跨端读取要求**对端也是国密版构建**。
5. **性能**：解锁＝Argon2id ＋ PBKDF2-HMAC-SM3 200000 轮，本机（M4 Max，release）合计 ≈ **112 ms**；
   中端机按单核比**外推** ≈ 0.4–0.7 s（**外推，不是实测**，真机读数属真机验收）。
