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
| 库级页加密 / 页 HMAC / 库 KDF | ✅ **打过补丁的 OpenSSL（国密）构建：SM4 页 ＋ SM3 页 MAC ＋ SM3 库 KDF**，且**补丁 v4 起这是库级默认值**（不再靠应用约定）；**未打补丁 / CommonCrypto 构建仍是 AES ＋ SHA512**。<br>★ **2026-09-22 owner 拍板「单一口味＝国密」并已落进 `release.yml`**：发出去的包一律 SM4 页（构建前 `--prepare` 打补丁＋清产物、`tauri build --features sm-library`、构建后断言 `page_cipher=sm4`）。各平台库来源：Windows＝vcpkg 静态／Linux＝系统 OpenSSL 3（共享，deb 声明依赖）／macOS＝自编 `no-shared`（配方见 `docs/RELEASING.md`）。**Tongsuo 不是必需的**（数据面用到的 SM3/SM4/PBKDF2-SM3 上游 OpenSSL ≥1.1.1 都有） | 由 SQLCipher 的编译期 provider 决定（P2/P3，provider 层属 **AMD**）。**2026-09-20 已接线**：`set_cipher_key` 在 `#[cfg(feature = "sm-library")]` 下设 `cipher_hmac_algorithm=HMAC_SM3` / `cipher_kdf_algorithm=PBKDF2_HMAC_SM3`，并**回显校验**（回显不是 `Applied` ⇒ 响亮失败，宁可不写库）。⚠️ 两条必须一起读：① **回显校验是判据本身** —— SQLCipher 会**接受**不认识的算法标签却不改算法，「设了没报错」在无补丁的构建上就是**静默降级**；② 代价是**这份构建读不开 SHA512 参数写的老库**（owner 已拍板走快路，见方案 §3.4）。接线规格见方案 §3.5 |

---

## 二、这一版交付的**接口**（换成"有哪些算法"的问题时照这里答）

**密文格式**（`MAGIC = 0x53`，头 2 字节，文本路径整体 base64、二进制路径直接用 —— 同一套编码）

| 版本 | 布局 | 用途 |
|---|---|---|
| `v0` | 无头 `nonce(24) ‖ ct` | P0 之前的老数据，**永远可读**（含"首两字节恰好撞 magic+版本"的回退） |
| `v1` | `0x53 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305 ct` | **只读**（老数据；2026-09-20 起不再写） |
| `v2` | `0x53 0x02 ‖ iv(16) ‖ SM4-CBC(PKCS#7) ct ‖ HMAC-SM3 tag(32)` | **默认构建写这个**（2026-09-20 owner 拍板「无兼容快路」后 `sm-crypto` 成为默认特性；旧行为 `--no-default-features` 仅作**回滚通道**，见方案 §3.4）。⚠️ **`--no-default-features` 只关「应用层」那一半**：库级（页加密/页 MAC/库 KDF）是**编译期库属性** —— 补丁 v4 之后**打过补丁的 OpenSSL 构建默认就是 SM3**，与这个特性无关 ⇒ 它**关不掉**库级国密 |

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
| **macOS** | ✅ | ✅ **`sm-library` 构建：P2 已接线 ＋ P3（SM4 页）已落地** ⇒ 页加密 SM4、页 MAC/KDF SM3（本机实测：XOR 判据打印「本构建的**页加密** = SM4 页」—— ⚠️ **更正**：那条判据**只判页加密**，夹具是裸钥默认参数写的）；**默认包仍是 CommonCrypto（AES ＋ SHA512）** | Tongsuo **已在本机构建**（commit `540603a3`）；`sm-library` 打开时 `build.rs` **fail-fast**（不给 `OPENSSL_DIR` 就当场失败） | 本侧 | 应用层 ✅；**三段自证在本机全绿**（见 §四）；库级 ✅（`security::` 22/0、`gm_provider::` 9/0，接线构建实测）；⚠️ 有一条 macOS-only 风险见 §五 |
| **Windows** | ✅（纯 Rust，全平台同一份实现） | 🔶 **代码同一份 ⇒ 接线也在**（其后端本来就是 OpenSSL）；⚠️ **本侧无独立库级读数** | 据信箱：**AMD 2026-09-18 报过 `tongsuo build: msvc=ok`**（附三条前置踩坑）；⚠️ **本侧没有独立复核** | Windows 侧 | 应用层：本机需走 `scripts/win-cargo-test.ps1`（测试 exe 手工挂 v6 清单；**真因是清单，不是 PATH/同名 DLL** —— 我原来的 PATH 假设已被 Windows 侧实测证伪，见信箱 `…crypto-backend.reply-3.md`）⇒ 行为另有 Linux/CI 证；库级未取证 |
| **Linux** | ✅ | 🔶 **代码同一份 ⇒ 接线也在**（AMD 在 WSL2 上有 provider 层读数；**接线后的库级读数归 AMD**，见 §3.5） | 后端**已是 OpenSSL**（读 `libsqlite3-sys/build.rs` 的最后一支：非 Apple/非 Windows 且未给 `OPENSSL_DIR` ⇒ `link-lib=dylib=crypto`；Linux CI 的 `rust-test` 常绿也印证系统 `libcrypto` 在位）；换 Tongsuo 只需 `OPENSSL_DIR` | AMD（provider） | 应用层 ✅（Linux 376/376） |
| **Android** | ✅（纯 Rust） | ❌ 未做（P2/P3 的 Android 构建链未排） | Tongsuo 交叉编译**已被 AMD 证过**（NDK r29）；真机验收未做 | 真机＝**人手** | ❌ 未取证 |
| **iOS** | ❌ | ❌ | 无 `ios.yml`、未开始；Apple 平台与 macOS 同一个 CommonCrypto 坑 | 未立项 | ❌ 范围外（方案 §1 已写明） |
| **Web** | ❌ | ❌ | 不提供静态加密与多设备同步 | — | ❌ 范围外（方案 §1） |
| 同步**服务端** | ❌ | ❌ | 只转发密文，不改 | 另一仓库 | ❌ 范围外 |

> **一句话读法**（2026-09-22 更新）：**应用层已全平台国密**（纯 Rust，一份实现；
> 口径是**附件＋同步载荷**——导出包里那份空间库**刻意是明文**，见 §一，别把两者合成一句）；
> **库级已接线**（`HMAC_SM3`/`PBKDF2_HMAC_SM3` 在 `sm-library` 构建里由 `set_cipher_key` 设上并**回显校验**，
> 与 P3 的 SM4 页合并成同一套库级参数；macOS 本机接线构建实测 `security::` 21/0、`gm_provider::` 9/0）；
> ⚠️ **默认构建（不带 `sm-library`）仍是 AES 页 ＋ SHA512** —— 读本说明时必须先问「说的是哪一份构建」；
> ⚠️ **代价**：`sm-library` 构建**读不开 SHA512 参数写的老库**（owner 已拍板走快路，方案 §3.4）——
> **不要把「能力已具备」读成「已在生效」**，也不要把「已接线」读成「两种构建互通」；
> ✅ **P3（SM4 页加密）owner 已拍板走 A（编译期切换），补丁 v3 已落地** —— 施工单/分工见方案 §3.2 末尾，
> 迁移规格（升级/回滚/可操作错误/四条判据）见 §3.3。补丁在仓库里（`patches/`）、由 `scripts/sm-library-build.mjs` 施加，
> 用完**刻意不自动还原**（保留补丁 ＋ 大横幅 ＋ 产物标记 `page_cipher=`，理由见方案 §3.4「乙+」）；
> **「这份构建到底是哪种页加密」以 `check-crypto-backend` 打印的 `page_cipher=` 为准，不靠回忆。**
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
| **P2 provider 补丁落地**（让 SM3 页 MAC ＋ 库 KDF **可设** ＋ 能力门） | `patches/0001-sqlcipher-sm3-provider.patch` ＋ `scripts/sm-library-build.mjs`（幂等打补丁） | AMD 在 WSL2 有读数；**macOS 本机独立复跑见下两行**；⚠️ **「可设」≠「在生效」** —— 所以有下一行 |
| ★ **P2/P3 接线（库级参数真的设下去了）** | `src-tauri/src/security.rs::set_cipher_key` ⇒ `apply_gm_page_settings`（`#[cfg(feature = "sm-library")]`）。三步：① `gm_provider::library_recognizes_gm_labels()`（**内存库**探"库认不认识国密标签"，与口令/文件无关）；② `set_gm_cipher_labels` 设两条 PRAGMA；③ `read_gm_cipher_status` **回显校验**，不是 `Applied` 就响亮失败 | macOS 接线构建（**`cargo test --features sm-library` ＋ `OPENSSL_DIR=<Tongsuo>`**）实测：**全库单测 427 passed / 0 failed / 18 ignored**；`security::` **22/0/2**、`gm_provider::` **9/0/4**；XOR 判据打印 **「本构建的页加密 = SM4 页」**（⚠️ **更正 2026-09-22**：它**只判页加密**；页 MAC/库 KDF 的证据是 `gm_provider` 回显 ＋ `sqlcipher-sm3-fixture.db`（显式设国密参数写的）＋ 判据 `raw_key_defaults_are_sm3_only_when_the_patch_says_so`）；`--no-default-features` 回滚通道 **415/0/17**。<br>⚠️⚠️ **读数必须显式带 `--features sm-library`**：胶水只在 `cargo build` 上加它，裸 `cargo test` 会把接线那段 `#[cfg]` **编掉** ⇒ 测到的是"没接线的应用"（我 2026-09-22 就这么拿到过两套自相矛盾的读数）。已加两处防线：`sm-library-build.mjs` 的收尾横幅写明口径、`gm-version-selfcheck --with-tests` 新增**第 ⑤ 段**（`security:: --features sm-library`）。<br>★ 接线**当场抓出两个真 bug**（都是"只在接线后才出现"的形态）：① `backup.rs`/`workspace_io.rs` 的**在线备份目标端**只写裸 `PRAGMA key` ⇒ 备份 API 按**目标**codec 重加密 ⇒ 国密构建里产出 SHA512 参数的快照，恢复路径读不开（判据当场红）；② 第一版接线用 `configure_gm_cipher` 的健康自检 `SELECT 1` 做判据，而"标签不认识"与"**口令不对**"在那句话上**一字不差** ⇒ 错口令被误诊成"这份构建可能没有 provider 补丁" |
| ★ **三段自证（macOS，真补丁 ＋ 真 Tongsuo）** | `node scripts/gm-version-selfcheck.mjs --openssl-dir <Tongsuo> --expect-patch applied --with-build`（**加 `--with-tests` 会多跑两段**：第 ④ 段 `cargo test --lib gm_provider::` ＝ 库级「真的生效没有」；**第 ⑤ 段** `cargo test --lib --features sm-library security::` ＝ **应用真的在用它**） | **3 段全过**：后端=openssl（link-search 指 Tongsuo）／补丁在场且 `src_sha256=6ec0a114b861…`（**补丁 v2**；与 AMD 在 WSL 上报的逐字相同，新鲜度可证）／跨对拍 12/12 |
| 运行期「真的生效没有」（第三格另一半；**已收进一键自证的 `--with-tests`**，见上一行的第 ④ 段） | `cargo test --lib gm_provider`（**在打过补丁 ＋ Tongsuo 的构建上**） | macOS：**9 passed / 0 failed / 4 ignored**（与 AMD 报的同一套 13 一致）；2026-09-20 起 `gm-version-selfcheck --with-tests` 会把这一段并进同一份读数 |
| ★ **应用层国密真的在这份构建里**（`sm_crypto=on|off`，2026-09-22 补） | `SHUYONOTE_EXPECT_SM_CRYPTO=on node scripts/check-crypto-backend.mjs`（读产物标记；发布链第 4 条断言的最后一格） | 实测（真 release 构建 `--features sm-library`）：标记 `page_cipher=sm4 **sm_crypto=on**`；反向声明 `off` ⇒ **红** ✅。动机：`tauri dev` 与 `tauri build` 对 `default features` 的处理不同（argv 已实测），而「包退回 v1 写路径」此前**没有任何判据**能发现 |
| ★ **应用真的在用它**（第四格；2026-09-22 补） | `cargo test --lib --features sm-library security::`（**`OPENSSL_DIR` 必须给**：`build.rs` 对 `sm-library` fail-fast），已收进 `gm-version-selfcheck --with-tests` 的**第 ⑤ 段**；★ 同日进**常开门禁** `rust-sm-wired`（`node scripts/check-gm-wired.mjs`：打补丁 ＋ `--features sm-library` 全量单测，内部下限 380/0，跑完还原补丁并重建默认特性；无 SM 版 OpenSSL 前缀时自报跳过） | macOS 接线构建：**21 passed / 0 failed / 2 ignored**；判据里包含「错口令必须**读**失败（不是被 key 阶段误诊）」与「另一套库级参数写的库必须读不开」两半 |
| 门禁 | `pnpm verify`（**以 `scripts/lib/gates.mjs` 为准**，本机当前全绿）/ `node scripts/test-report.mjs --group rust`（同一来源，当前含 含 `rust-test`（默认即国密）、`rust-no-sm-crypto`（**回滚通道**）、**`rust-sm-wired`（库级国密接线：打补丁 ＋ `--features sm-library` 全量单测，2026-09-22 新增）**、`check-crypto-backend`、`gm-conformance`） | **全绿**。`rust-sm-wired` 在无 SM 版 OpenSSL 前缀的机器上自报跳过（macOS 需 `OPENSSL_DIR`）；本机实测 **440 passed / 0 failed**；★ **真 CI 实测（Linux，run `35685322260`，dev `6248b882`）**：`--group rust` **7 条全绿（575.8s）**，该门禁在 ubuntu runner 上真跑（`OPENSSL_DIR=/usr` ⇒ `LIB_DIR=/usr/lib/x86_64-linux-gnu`、`INCLUDE_DIR=/usr/include`）**440 passed / 0 failed**，跑完还原补丁并重建默认特性 ⇒ **Linux 支的国密链路已被真流水线验过** |
| **老端在动手之前就拒绝**（§0-C）：同步**整批拒绝**、空间级标识、附件拒绝（不是逐条失败） | `sync::tests::prescan_payload_formats_refuses_the_whole_batch`、`security::tests::space_guard_…`、`…attachment_bytes_of_an_unsupported_format_are_refused…` | ✅（默认构建拒绝 / 国密构建放行，两半都有 cfg 判据） |
| ★ **静态前缀守卫在 Windows 的**真实前缀**上判得对**（2026-09-22，AMD 的 Windows 盒 —— 补上「Windows 侧无独立库级读数」的一半） | 纯读探针（**不打补丁、不构建**）：<br>`node -e "import('./scripts/lib/sm-library-source.mjs').then(m => console.log(m.requireStaticCrypto(process.env.OPENSSL_DIR)))"` | 本机全局 `OPENSSL_DIR=C:\Program Files\OpenSSL-Win64`：`ok=**false**`，理由点到 `libcrypto-3-x64.dll`；`prefixLooksLinkable=true`（`lib\libcrypto.lib` 在）。⇒ **这台机器用默认环境编出来的国密包不自包含**（`lib\libcrypto.lib` 是**导入库** ⇒ 链接期解析到它、运行时去找 DLL）⇒ Windows 侧要发单一口味包必须先换静态前缀（见 §五）。<br>⚠️ **别拿 `--require-static` 当探针**：它会**先幂等打补丁**（实测打印 `补丁 = applied（本次打上）`），之后才轮到静态核对；`--print-source-sha256` 同样会打（它记进产物标记的哈希，按定义就该是"已打补丁那份"）。要只读就用上面那条 import，或加 `--no-apply`；确实打了补丁就按横幅提示 `--revert`（本回合实测：打 → 撤 → 源码 `SM3` 命中数回到 **0**） |
| ★ **前缀类判据本身跨平台**（2026-09-22 修：此前在 **Windows 上是 6 条假红**） | `node node_modules/vitest/vitest.mjs run scripts/check-gm-wired.test.mjs scripts/lib/sm-library-plan.test.mjs scripts/lib/sm-library-source.test.mjs` | 修前（Windows）**6 failed**：判据注入的假 FS 按**字面** `/lib`、`/bin`、`/lib64` 匹配，而生产用 `node:path.join` ⇒ `join('/usr','lib')` = `"\\usr\\lib"`、`endsWith('/lib')` = false ⇒ 假 FS 一条都匹配不上（**产品代码本身是对的** —— 见上一行，用真实前缀实测判得对）⇒ 这 6 条是**假红**，而它们落在 `pnpm verify` 的 vitest 门禁范围内（`group: smoke`、`include: scripts/**/*.test.mjs`）。修法：假 FS 改按 `basename`（最后一段）匹配、期望值用 `join` 拼，并各加一条**真磁盘**判据（不喂假 FS、目录用 `join` 建）⇒ 修后 **37 passed**。<br>**变异证明**：把 `requireStaticCrypto` 的 `lib64` 那一支删掉 ⇒ **磁盘版**判据当场红（`1 failed | 15 passed`），而纯函数那条照样绿 —— 这正是"必须有一条走目录扫描"的理由 |
| ★ **共享 registry 没留国密补丁**（常开门禁 `gm-registry-clean`，2026-09-22 AMD） | `node scripts/check-gm-registry-clean.mjs`（**只读、不构建**；`--platform=darwin` 可在任何平台上判"若是 macOS 会怎样"） | 本机实测：干净 ⇒ `✅ 原版` **exit=0**；打上补丁后 ⇒ 本平台 `⚠️ notice` exit=0、`--platform=darwin` ⇒ `❌ block` **exit=1**（并给出 `--revert` 那一行）、`--platform=dawrin`（拼错）⇒ **exit=2**（**不许**把拼错当成"非 darwin"静默降级成 notice）；期间连调 3 次 CLI，源码 `SM3` 命中**恒为 50**（"只读"在真文件上也证了）；`--revert` 后 ⇒ 回 `✅` 且命中 **0**。<br>**变异证明**：把判 `darwin` 的那一支改掉 ⇒ **2 条判据当场红**（`2 failed | 11 passed`）。<br>⚠️ 边界：**"读不出来"只提示不判红**（干净机器 / 没 fetch 过 registry 不该被判红），有专门判据钉这一条 |
| ★ **Windows 上的库级真读数**（2026-09-22 AMD；此前从未有过） | `node scripts/sm-library-build.mjs --prepare` ⇒ `powershell -File scripts\win-cargo-test.ps1 -CargoArgs '--features=sm-library'` | `test result: FAILED. **455 passed; 34 failed; 18 ignored**; finished in 38.57s`。★ **34 条失败全部是 `plugins::`**（`win-cargo-test.ps1` 头注写明的"需要真宿主进程、权威全量归 CI/WSL2"）；**国密各组 0 失败**：`gm_provider::` 0 · `security::` **0** · `sm3`/`sm4`/`cipher` 各 0。<br>⚠️ 这一格在 Windows 上此前**根本跑不起来**，两个真因：① 测试 exe 以 `0xC0000135 STATUS_DLL_NOT_FOUND` 直接退出（**不是**清单那条已知原因——走 `win-cargo-test.ps1` 注入 v6 清单后仍然同码；真因是**动态前缀**下运行时缺 `bin\libcrypto-3-x64.dll`，而门禁没把 `<前缀>\bin` 放进 PATH）⇒ 已修（`testPathFor`，**win32-only**，＋3 判据）；② 门禁通过标准是 `passed ≥ 380` **且 `failed == 0`**，Windows 上那 34 条必然失败 ⇒ **即使可跑的全过也永远红** ⇒ 这条**没有**擅自放宽，已列候选（`--skip plugins::` / 写明豁免 / 整格交给 `win-cargo-test.ps1`）请门禁作者定。★ **2026-09-23 已收口**：口径取**显式 skip ＋ 自报排除了什么**，并且门禁现在在 win32 上**自产读数**（跑器 `-PrintExePath` 构建＋给副本注入 v6 清单并打印副本路径 ⇒ 门禁自己跑副本 `--skip plugins::` 再自判；Windows 侧实测：全量 **508 passed / 0 failed / 18 ignored**、`-Skip plugins::` **385 passed / 124 filtered out / exit 0**） |
| ★ **产物事实 ＋ `SHUYONOTE_EXPECT_OPENSSL_DIR` 的真机变异**（2026-09-22，AMD 的 Windows 盒） | `SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl SHUYONOTE_EXPECT_SM_PATCH=applied SHUYONOTE_EXPECT_PAGE_CIPHER=sm4 SHUYONOTE_EXPECT_SM_CRYPTO=on SHUYONOTE_EXPECT_OPENSSL_DIR=<前缀> node scripts/check-crypto-backend.mjs` | 产物标记逐字：`patch=72df3f9a target=windows libsqlite3-sys=0.38.2 marker=sqlite3.c **page_cipher=sm4 sm_crypto=on** src_sha256=741d999b7933…`，且 `src_sha256` **与当前源码一致**（新鲜度可证，不是重放）；后端 `openssl`，`link-search=C:\Program Files\OpenSSL-Win64\lib`。<br>**变异**：声明成**真实前缀** ⇒ **exit=0** ✅；声明成另一个前缀 ⇒ **exit=1** ❌ 且理由对（"产物实际链的 OpenSSL 目录是 `…\OpenSSL-Win64\lib`，而声明要求 …"，并点出 `OPENSSL_LIB_DIR`/`OPENSSL_INCLUDE_DIR` 优先于 `OPENSSL_DIR`）⇒ 这一格**真的在岗**，不是摆设。⚠️ **静态前缀那一半仍未做**（见 §五） |

---
| ★ **补丁隔离（消灭"残留在共享 registry 上"）**（2026-09-23，macOS 侧落地） | `node scripts/sm-library-build.mjs --openssl-dir <前缀> --prepare`（建私有副本 ＋ 私有 `CARGO_HOME`），随后 `CARGO_HOME=<repo>/.gm-build/cargo-home` 构建；`--print-env` 会把 `CARGO_HOME` 一起打出来（CI 写进 `$GITHUB_ENV`） | 实测（macOS，**全程没做 revert**）：国密 `security::` **22 passed / 0 failed**；紧接着默认构建 `security::` **22/0**；共享 `sqlite3.c` SM3 命中 **0**；`check-crypto-backend` 读到 `patch=72df3f9a page_cipher=sm4 sm_crypto=on` 且 `src_sha256` **与私有副本一致**（`via=isolation`）；`gm-registry-clean` 绿。Rust 侧：`build.rs` 现在**按证据**选源码（产物 `cargo:include=` 指向 `.gm-build/` ＞ 环境 `CARGO_HOME` 指向私有 home），忘了导出 `CARGO_HOME` 会**当场失败**（响亮），不会静默编出一份没有国密的库 |
| ★★ **win32 上的库级国密接线读数（门禁自产，2026-09-23）** | `set OPENSSL_DIR=<MSVC Tongsuo 前缀>` ＋ `node scripts/check-gm-wired.mjs`（Windows 上门禁自己驱动跑器副本） | AMD 那台：**398 passed / 0 failed**（`--skip plugins::`，下限 380）＋ **③ link-search 逐字对得上钉的前缀** ＋ `GATE_EXIT=0`；收尾干净度（他独立复核）：共享 `sqlite3.c` **逐字节未变**（`EA0BF0B088…`）、SM3 命中 0、`.gm-build/` 已删。⇒ 这一格此前在 Windows 上只能"自报未实查"，现在**有真读数了**（与 macOS 的 520 不可直接比：平台与跳过集不同） |

## 五、未取证清单（含**归属**与**所需条件**，不冒领）

| 项 | 归属 | 还差什么 |
|---|---|---|
| **P3：SM4 页加密** | **AMD**（方案 §3.2 两条路） | ✅ **owner 拍板 A（编译期切换），补丁 v3 已落地并在本侧实测**：`patches/0001-sqlcipher-sm3-provider.patch` 把 `OPENSSL_CIPHER` **无条件**改成 `EVP_sm4_cbc()`（单一 `#define`、五处使用点跟着走；只有在 `SQLITE_HAS_CODEC > SQLCIPHER_CRYPTO_OPENSSL` 那一支里编译 ⇒ **CommonCrypto 构建不受影响**）。实测标记 `page_cipher=sm4`；AES 夹具在 SM4 构建里被拒、SM4 夹具在 AES 构建里被拒（**恰好一个能开**，两种构建都绿） |
| 「页加密确为 SM4」的直接判据（读文件头 / 用错算法打不开） | 已落地（本侧实测） | ✅ 两种构建上跑 `security::tests::exactly_one_page_cipher_fixture_opens_and_the_other_is_refused`：**AES＋SHA512 夹具与 SM4＋SM3 夹具恰好一个能开**，并**打印**是哪一种 ⇒ 不必只靠声明 |
| ★ **macOS-only 风险：补丁留在共享 registry 上** | **AMD**（我给了三条修法） | 补丁打在**共享**的 `libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c` 上 ⇒ 跑过一次国密构建后，**默认（CommonCrypto）构建会红 12＋7 条**（受控 A/B：打过补丁 7/12 fail ＋ 2/7 fail；还原后 **19/0 ＋ 9/0**；现场是 `PRAGMA key = "x'…'"` 被拒 ⇒ 加密库打不开）。Linux/Windows 后端本就是 OpenSSL ⇒ **只有 macOS 会暴露**。修法候选：按后端守护补丁／胶水可撤回／国密构建用独立 `CARGO_HOME`。<br>★ **2026-09-22 已落一条"发现并拦住"的机制（AMD）**：`scripts/check-gm-registry-clean.mjs` ＋ `scripts/lib/sm-library-hygiene.mjs`，接成常开门禁 **`gm-registry-clean`**（rust 组）—— 它**只读**读出状态（不再有"想核状态就得先打补丁"那个自相矛盾），并判三档：原版 / 本次就是 `sm-library` 构建 ⇒ `ok`；带补丁 ∧ 非 darwin ⇒ **只提示不判红**（会把后续默认构建静默改成 SM4 页）；带补丁 ∧ darwin 默认构建 ⇒ **红并给出那一行 `--revert`**；**读不出来 ⇒ 只提示**（干净机器/没 fetch 过 registry 不判红）。A/B 与变异读数见 §四。<br>✅ **已根除（2026-09-23）**：取的不是"守护补丁"，而是**让补丁不再接触共享源码** —— 国密构建把 registry 里那份
`libsqlite3-sys-<ver>` **拷成私有副本**（`<repo>/.gm-build/`），补丁只打在副本上，cargo 由**私有 `CARGO_HOME`**
（`config.toml` 的 `[patch.crates-io]`，且**逐字继承**真实 config 的镜像源）指过去 ⇒ 共享 registry **全程不被触碰**，
「跑完忘了还原 ⇒ 默认构建被静默改成 SM4 页 / macOS 上像加密库坏了」这一整类状态**不可能发生**；
`--revert` 退化成"删一个目录"。**实测**（macOS，未做任何 revert）：国密构建 `security::` **22/0** ⇒ 紧接着跑**默认**构建
`security::` 仍 **22/0**，共享源码 SM3 命中恒为 **0**，`gm-registry-clean` 同时为绿。
本门禁**仍在岗**（防线是双层的：机制让它不发生 ＋ 门禁发现任何遗留），并新增判据：`sm-library-isolate.test.mjs`
（核心一条：跑完隔离，共享那份**逐字未变**）＋ Rust 侧 `gm_patch_probe` 三条（副本路径 / `CARGO_HOME` 判定 / 产物 include）|
| Windows MSVC 版 Tongsuo | **Windows 侧** | 据信箱 **AMD 2026-09-18 已报 `msvc=ok`**（Tongsuo 8.5.0-pre2 / SM3＋SM4 读数、三条前置踩坑）；⚠️ **本侧无独立复核** |
| ★ **Windows 的库级读数**（上面那条"无独立库级读数"**已不成立**，2026-09-22） | **AMD 已出读数**（见 §四）；**剩余两格不归 AMD** | 已出：`--features sm-library` ＋ 打补丁下 `455 passed / 34 failed / 18 ignored`，其中 **34 条全是 `plugins::`**（需真宿主进程），**国密各组 0 失败**。两格**都已收口**（2026-09-23）：① **门禁通过标准已定并落地** —— win32 上显式 `--skip plugins::`（自报排除了什么，而不是数字豁免），且门禁现在**自己产读数**（Windows 侧给跑器加了 `-PrintExePath` / `-Skip`，门禁跑那个已注入 v6 清单的副本并自判；macOS 侧 `9ff04af9`）；② **静态前缀**：**发版链已经在用**（`release.yml` 的 Windows job 装 vcpkg `openssl:x64-windows-static-md` 并跑 `--prepare --require-static`，`v1.91.24/25/26` 三次 tag run 全绿）—— 剩下的只是「**本机默认环境**是动态前缀」这一条边界。★★ **2026-09-23：win32 的"自产读数"已经真出来了**（AMD 那台，MSVC Tongsuo 前缀 `…\.third\tongsuo-msvc-out`）：`node scripts/check-gm-wired.mjs` ⇒ 门禁**自己**跑跑器给的已注入 v6 清单的副本（`--skip plugins::`）**398 passed / 0 failed**（下限 380）＋ **③ link-search 逐字等于钉的前缀** ⇒ `GATE_EXIT=0`；并且他**顺手验了收尾的干净度**：共享 `sqlite3.c` sha256 跑前跑后**逐字节相同**（`EA0BF0B088…`）、SM3 命中 0、`.gm-build/` 已删。⚠️ 398 与 macOS 的 520 **不可直接比**（平台与跳过集都不同）；能比的是两边都满足「`failed == 0` 且 `passed ≥ 380`」|
| ★ **Windows 发版必须先备一个静态前缀**（本侧实测：本机**全局** `OPENSSL_DIR` 是**动态**前缀）　🟡 **2026-09-23 收窄**：发版链**已经**覆盖（CI 用 vcpkg 静态档 ＋ `--require-static` 绿）；「**本机**复现」这一半是**可选**的（AMD 确认他那份 Tongsuo 前缀也是**动态**：`bin\libcrypto-3-x64.dll` 6.95 MB ＋ `lib\libcrypto.lib` 1.37 MB 导入库 ⇒ 关不了这格）；要闭合只有两条：`vcpkg install openssl:x64-windows-static-md`（几百 MB 下载＋编译）或另做静态 Tongsuo —— **等 owner 一句话**，他随手可做 | **owner 拍（AMD 可执行）** | `OPENSSL_DIR=C:\Program Files\OpenSSL-Win64` ⇒ `requireStaticCrypto` **拒绝**：`lib\libcrypto.lib` 是**导入库** ＋ `bin\libcrypto-3-x64.dll` ⇒ 在**本机默认环境**下编出来的国密包**依赖构建机那份 DLL**（到用户机器上要么找不到、要么用到另一份 OpenSSL），正是「单一口味要自包含」要拦的形态。发单一口味包前先备一个只含 `libcrypto.a`/`libcrypto.lib`、且 `bin/` 无 crypto DLL 的前缀（vcpkg 静态档即这种形态），并用 `--require-static` 卡住（判据与读数见 §四） |
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
