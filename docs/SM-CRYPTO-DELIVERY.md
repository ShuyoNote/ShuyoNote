# 国密（SM 系列）交付说明 —— **按平台分列**

> 日期：2026-09-19　｜　被验 commit：`7b6d98a7`（dev，两远端一致）
> 权威方案与全部口径：[`plans/2026-09-16-sm-crypto-full-plan.md`](plans/2026-09-16-sm-crypto-full-plan.md)（§0 拍板 / §0.1 常量表 / §0.2 P1 落地记录 / §3.1 provider 线 / §7 验收标准）
> 图例：**✅ 已取证**（附判据与读数）｜**🔶 机制已落地、默认未启用**｜**❌ 未做**（写明归属与所需条件）

---

## 一、边界声明（**交付文本照这段写，不要含糊成"全链路国密"**）

| 面 | 是否国密 | 说明 |
|---|---|---|
| **数据面**：静置密文（附件）、导出包、同步载荷 | ✅ **是** | 应用层 AEAD 全换（SM4-CBC ＋ HMAC-SM3，见 §三） |
| **传输层** | ⚠️ **数据面国密、传输层标准 TLS**（方案 §5.2 已定：走"路径 2"） | 链路上的**载荷**是 SM4 密文；协议本身仍是 TLS 1.3。**不要写成"全链路国密"** |
| **控制面**：更新包签名（minisign/Ed25519）、插件索引签名 | ❌ **不是**（已决定） | 不在甲方系统边界内；内网离线部署下自动更新本就不可用 |
| 内容寻址摘要（附件 SHA-256） | ❌ **保持 SHA-256**（有意为之） | 换成 SM3 = 全库附件改名 ＋ 同步标识全失；要换需单独立项 |
| 库级页加密 / 页 HMAC / 库 KDF | 🔶 **尚未**（见 §三"库级"列） | 由 SQLCipher 的编译期 provider 决定，属 P2/P3（**AMD**），不在本版 |

---

## 二、这一版交付的**接口**（换成"有哪些算法"的问题时照这里答）

**密文格式**（`MAGIC = 0x53`，头 2 字节，文本路径整体 base64、二进制路径直接用 —— 同一套编码）

| 版本 | 布局 | 用途 |
|---|---|---|
| `v0` | 无头 `nonce(24) ‖ ct` | P0 之前的老数据，**永远可读**（含"首两字节恰好撞 magic+版本"的回退） |
| `v1` | `0x53 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305 ct` | 默认构建写这个 |
| `v2` | `0x53 0x02 ‖ iv(16) ‖ SM4-CBC(PKCS#7) ct ‖ HMAC-SM3 tag(32)` | `--features sm-crypto` 的国密构建写这个 |

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

| 平台 | 应用层 SM4（附件/导出/同步载荷） | 库级（页加密 · 页 HMAC · 库 KDF） | 构建前置 | 归属 | 取证状态 |
|---|---|---|---|---|---|
| **macOS** | ✅ | ❌ **仍是 CommonCrypto（只有 AES）** | Tongsuo **已在本机构建**（commit `540603a3`）；切后端**已证明可行且与既有库兼容**；`sm-library` 打开时 `build.rs` **fail-fast**（不给 `OPENSSL_DIR` 就当场失败） | 本侧 | 应用层 ✅；库级 🔶 机制已备 |
| **Windows** | ✅（纯 Rust，全平台同一份实现） | ❌ | **MSVC 版 Tongsuo 未构建**（P3 第一关） | **Windows 侧** | 应用层：本机跑不了 `cargo test`（`0xC0000139`）⇒ 行为由 Linux/CI 证 |
| **Linux** | ✅ | ❌ | 后端**已是 OpenSSL**（读 `libsqlite3-sys/build.rs` 的最后一支：非 Apple/非 Windows 且未给 `OPENSSL_DIR` ⇒ `link-lib=dylib=crypto`；Linux CI 的 `rust-test` 常绿也印证系统 `libcrypto` 在位）；换 Tongsuo 只需 `OPENSSL_DIR` | AMD（provider） | 应用层 ✅（Linux 376/376） |
| **Android** | ✅（纯 Rust） | ❌ | Tongsuo 交叉编译**已被 AMD 证过**（NDK r29）；真机验收未做 | 真机＝**人手** | ❌ 未取证 |
| **iOS** | ❌ | ❌ | 无 `ios.yml`、未开始；Apple 平台与 macOS 同一个 CommonCrypto 坑 | 未立项 | ❌ 范围外（方案 §1 已写明） |
| **Web** | ❌ | ❌ | 不提供静态加密与多设备同步 | — | ❌ 范围外（方案 §1） |
| 同步**服务端** | ❌ | ❌ | 只转发密文，不改 | 另一仓库 | ❌ 范围外 |

> **一句话读法**：**应用层已经全平台国密（纯 Rust，一份实现）；库级一列全是 ❌ —— 那一列要等 P2/P3 的
> provider 补丁（AMD）＋ 各平台 Tongsuo 构建把前置补齐**。本说明的作用之一就是**不让这两件事被读成一件**。

---

## 四、已取证清单（每条都能跑；读数带被验 commit）

| 结论 | 判据 / 命令 | 读数 |
|---|---|---|
| 密文带版本头、两条路径同一编码 | `cargo test --lib crypto::` | 10/10（`--features sm-crypto` 时） |
| **无头老数据永远可读**（含撞头回退，对 v1、v2 各验一遍） | 同上（金标夹具 `tests/crypto-legacy-v0.json`，三格真实密文） | ✅ |
| **EtM 正确**：篡改版本头/IV/密文/ tag 都必须**先失败且不解密**；两把密钥不可互换 | `crypto_sm::tests::tampering_anywhere_fails_before_decrypting` 等 | ✅ |
| **未知版本给可操作错误**（不是"数据损坏"） | `unknown_future_version_gets_an_actionable_error`；默认构建读 v2 | ✅ |
| 三条路径（附件 / 同步载荷 / 导出副本）全覆盖 | `security::tests::national_crypto_covers_all_three_paths_…`、`attachments::…national_crypto…` | ✅（只在 `--features sm-crypto` 下编） |
| **库级密钥未被国密密钥顶替**（顶替＝既有加密库全打不开） | `security::tests::national_crypto_…_keeps_the_library_key_unchanged` | ✅ |
| KDF 常量写死 ＋ 防改小 ＋ 跨实现黄金向量（含**切片**口径） | `kdf_rounds_are_the_pinned_value`、`kdf_golden_vector_and_key_slicing` | 变异证明：改切片只有黄金向量红 |
| **跨实现对拍**（GM/T 0002/0004 ＋ RustCrypto↔Tongsuo 双向互解 ＋ 两侧密文逐字节相同 ＋ PBKDF2 与拆 key 口径） | `SHUYONOTE_TONGSUO_OPENSSL=<Tongsuo>/bin/openssl node scripts/check-gm-conformance.mjs` | **12/12**（macOS 与 AMD 的 WSL2 各一次，同源码 commit） |
| **换加密后端前后旧库仍可读**（页加密读写回归） | `security::tests::fixture_db_written_by_the_other_provider_still_opens`（夹具 `tests/sqlcipher-backend-fixture.db` 由 **CommonCrypto 后端**写下） | Tongsuo 后端下 `security::` **14/14** |
| 实际编进去的是哪个后端（不是看你设了什么环境变量） | `node scripts/check-crypto-backend.mjs` | 双向实测：产物 openssl＋声明 openssl ⇒ 绿；产物 CC＋声明 openssl ⇒ **红** |
| 门禁 | `pnpm verify`（23）/ `node scripts/test-report.mjs --group rust`（**6 条**，含 `rust-sm-crypto`、`check-crypto-backend`、`gm-conformance`） | 全绿 |
| **老端在动手之前就拒绝**（§0-C）：同步**整批拒绝**、空间级标识、附件拒绝（不是逐条失败） | `sync::tests::prescan_payload_formats_refuses_the_whole_batch`、`security::tests::space_guard_…`、`…attachment_bytes_of_an_unsupported_format_are_refused…` | ✅（默认构建拒绝 / 国密构建放行，两半都有 cfg 判据） |

---

## 五、未取证清单（含**归属**与**所需条件**，不冒领）

| 项 | 归属 | 还差什么 |
|---|---|---|
| 库级 SM4 页加密 / HMAC-SM3 / PBKDF2-HMAC-SM3（P2＝SM3 系、P3＝SM4 页） | **AMD** | provider 补丁（同一文件同一结构体）；本版只加了构建侧接缝与门禁 |
| 「页加密确为 SM4」的直接判据（读文件头 / 用错算法打不开） | AMD ＋ 本侧 | 依赖上一条落地 |
| Windows MSVC 版 Tongsuo | **Windows 侧** | MSVC 构建（历史未做） |
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
cargo test --manifest-path src-tauri/Cargo.toml --features sm-crypto     # ← 应用层国密的开关（§0-E）

# ② 跨实现对拍：需要一份真 Tongsuo 的 CLI
SHUYONOTE_TONGSUO_OPENSSL=<Tongsuo>/bin/openssl node scripts/check-gm-conformance.mjs
#   本机没有 Tongsuo ⇒ 那 9 项自报跳过（不装绿）；**指名了却用不了 ⇒ 判红**

# ③ macOS 库级接缝（**只对国密版**；默认包按拍板维持 CommonCrypto，不会被这一步影响）
#    `sm-library` 打开 ⇒ 没给 OPENSSL_DIR 会**当场失败**（build.rs 的 fail-fast），不留"静默没有国密"的结局
cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml    # ← 这一步不能省，理由见 ④
OPENSSL_DIR=$HOME/tongsuo-macos/install \
  cargo build --lib --features sm-library --manifest-path src-tauri/Cargo.toml
node scripts/check-crypto-backend.mjs                                 # ← 拿产物说话

# ④ 门禁：默认组 / rust 组（含国密两条）
pnpm verify && node scripts/test-report.mjs --group rust
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
4. **性能**：解锁＝Argon2id ＋ PBKDF2-HMAC-SM3 200000 轮，本机（M4 Max，release）合计 ≈ **112 ms**；
   中端机按单核比**外推** ≈ 0.4–0.7 s（**外推，不是实测**，真机读数属真机验收）。
