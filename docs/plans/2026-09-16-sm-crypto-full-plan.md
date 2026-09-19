# 国密（SM 系列）全链路支持 · 落地方案（档 3 ＋ 国密传输）

> 状态：**已拍板（2026-09-16）：走档 3（库级静置密文也用国密）＋ 传输层也要国密。** 本文件是落地设计。
> ✅ **已确认（2026-09-16）：客户要的是"用国密算法"，不要求"通过认证的商用密码产品"**
> ⇒ §3 路线 A（自研 provider ＋ 开源国密库）成立，**不需要采购认证模块**。这条确认消掉了本方案原先最大的不确定性。
> 传输层与签名口径见 §0 与 §5；**原先的"仍待确认"已全部拍掉**（见 §0）。
> 上位决策文档：[国密 + PDFium 方案](2026-09-16-sm-crypto-and-pdfium-plan.md)。引擎侧见 [PDFium 落地方案](2026-09-16-pdfium-engine-plan.md)。
> **利弊与跨平台影响**见 [国密方案 vs 原方案](2026-09-17-sm-crypto-tradeoff.md)（含各平台 Tongsuo 构建面、数据面「不存在部分设备升级」、路径 3 对 Android TLS 栈的连带影响）。

---

## 0. 拍板记录（2026-09-17，**五条，施工前必读**）

这一步专门把"方案里留了口子的地方"钉死，否则写代码的人只能自己猜，而猜错的代价是**密文格式改不动**或**老用户数据打不开**。

| # | 决定 | 为什么这么定（代价已称过） | 带来的施工要求 |
|---|---|---|---|
| **A** | **密文格式头 = 2 字节（1 字节 magic ＋ 1 字节版本）** | 文本路径（`encrypt_str` → base64）与二进制路径（`encrypt` → 附件/导出/同步载荷）**用同一套编码**；字符串前缀只对文本友好，二进制得再设一套 ⇒ 等于两套格式 | P0 的第一件事；`decrypt` 必须先读 2 字节再分派；旧数据无头 ⇒ 按版本 `0` 处理 |
| **B** | **应用层 AEAD = SM4-CBC ＋ HMAC-SM3（encrypt-then-MAC）** | 不选 SM4-GCM：国密没有 XChaCha20 那种 24B 随机 nonce 的余量，12B nonce 撞重是**毁灭性**的；EtM 与库级同一套原语（`EVP_sm4_cbc` ＋ `HMAC(SM3)`） | 两个**独立**密钥（加密/MAC）；MAC 必须覆盖**版本头 ＋ IV ＋ 密文**；先验后解（不许先解密再验） |
| **C** | **算法标识除了密文头，还要落到「空间状态 ＋ 同步载荷」** | 老端才能在**整空间/同步之前**明确拒绝并提示升级，而不是逐条解密失败、让用户以为**数据坏了** | `EncryptionStatus` 加算法字段；空间元数据记录本空间算法；同步载荷带标识；服务端**不用改**（只转发密文） |
| **D** | **PBKDF2 迭代次数与口令下限：先压测、再写死 ＋ 加门禁断言** | 国密**无内存硬化**（§2 已记为确定的安全降级），这一处是**唯一**的补偿手段，最容易被敷衍掉 | 压测目标：中端机解锁 **< 1 秒**；结果写成一个常量，并加断言防止后人随手改小 |
| **E** | **主干国密路径 = feature 门控（`--features sm-crypto`）＋ 一条常开的国密 CI job** | 默认构建不被 Tongsuo/Perl 构建链风险绑架（外部贡献者前置不变）；代价是官方默认包不含国密，国密版另发 | 主干加 feature；**必须有那条常开 job**，否则国密路径会变成"没人编、坏了也没人知道"的死代码；见[利弊与跨平台 §7.1](2026-09-17-sm-crypto-tradeoff.md) |
| **F** | **应用层 AEAD 的实现来源 = RustCrypto（纯 Rust `sm3`/`sm4`/`cbc`/`hmac`）；库级 provider 仍走 Tongsuo（C）** | ① **解耦**：应用层不再等构建链，Mac 不被 Windows/AMD 的 Tongsuo 构建阻塞；② **跨端一致性更好**：应用层是跨设备互通的关键路径，纯 Rust 让**全平台同一份实现**，不存在"某平台编进了不同 provider"（§5.1 那个 Apple/CommonCrypto 的坑只影响库级）；③ 代价（**两份 SM4 实现**）是**可测的**；④ 削弱 Apple 后端问题的影响面 | 必须加**跨实现一致性用例**：GM/T 0002/0004 标准向量 + RustCrypto 与 Tongsuo 两侧对同一明文产出可互解（§4 第 5 条已要求）；文档里如实写"两份实现" |

> ⚠️ **A 是唯一"发布后改不动"的一条**：密文头一旦随发布出去，就被所有既有数据复制了。B 的 EtM 细节若实现错，是"看起来能用但可被篡改"——这两条都要有测试向量钉住（§7）。
>
> **F 推翻了 §3 里"应用层也统一走 Tongsuo"的原建议**（那条建议的出发点是"一套实现"，但它把纯 Rust 的应用层绑到了 C 构建链上）。
> 现在改为**按层分工**：**C 层用 Tongsuo，Rust 层用 RustCrypto**，两者用标准向量对拍钉住。

### 0.1 套件常量表（**这是接口，不是实现细节** —— 2026-09-17 定，AMD 提的）

理由是 AMD 那句话：**既然要"两份 SM4 实现"，"用哪个模式"就不再是实现细节**。
一处定义、处处引用（实现 / 对拍夹具 / 验收清单），**不许各写一份**。

| 项 | **钉死的值** | 依据 |
|---|---|---|
| **套件** | **SM4-CBC ＋ HMAC-SM3（encrypt-then-MAC）** | §0-B。⚠️ **不是 GCM / CCM** —— 早先文档里"或 SM4-GCM"那句**已作废** |
| 分组 / 模式 | SM4-CBC，块 **16 字节** | GM/T 0002 |
| 填充 | **PKCS#7**（CBC 必需，整块填充） | — |
| IV | **16 字节随机**，随密文一起存（**不保密**）；**同一密钥下不得复用** | — |
| MAC | **HMAC-SM3**，tag **32 字节** | GM/T 0004 |
| **MAC 覆盖范围** | **版本头 ＋ IV ＋ 密文**；**encrypt-then-MAC，先验后解** | §0-B。漏掉版本头会让降级攻击可行 |
| 密钥 | **两个独立密钥**（加密 key / MAC key），**不得同一个** | §0-B |
| KDF | **PBKDF2-HMAC-SM3**；盐 **16 字节**；输出 **64 字节 → 前 32 加密 / 后 32 MAC**；**迭代次数待压测后写死**（§0-D） | §0-D |
| 密文头 | **2 字节**（1B magic ＋ 1B 版本）；文本路径整体 base64、二进制路径直接用 | §0-A |
| 实现来源 | 应用层 **RustCrypto**；库级 **Tongsuo**；**双向对拍是验收项** | §0-F |
| RustCrypto 侧可用性（**2026-09-17 实测**） | `sm4 0.6.0`、`cbc 0.2.1`（含 `block-padding`）、`sm3 0.5.0`、`hmac 0.13.0` **全在**（`cargo add --dry-run`） | 回答 AMD 的"先确认 crate 齐不齐" |

> ⚠️ **上表"前 32 加密"这一格 P1 落地时发现是写错的**（SM4 是 **128 位 = 16 字节**密钥，不是 32 字节），
> 已按"**64 字节输出不变、SM4 取前 16 字节**"落地 —— 保留 64 字节是为了**两侧逐字节可比**
> （Tongsuo 侧同一句 `PKCS5_PBKDF2_HMAC(..., EVP_sm3(), 64, out)`），改输出长度会让对拍失去意义。
> 详见 §0.2「P1 落地记录」。

---

## 0.2 P1 落地记录（2026-09-19，Mac）

P1 = **应用层 SM4**（§6 表），交付形态是**编译期 feature `sm-crypto`**（§0-E）；默认包字节不变。

**密文格式 v2（落盘布局，`MAGIC=0x53`）**

```text
offset 0      : 0x53                      magic
offset 1      : 0x02                      版本 2 = 国密
offset 2..18  : iv(16)                    SM4-CBC 的 IV，随机、不保密、同密钥不复用
offset 18..N  : SM4-CBC + PKCS#7 密文     长度必为 16 的整数倍（PKCS#7 整块填充）
最后 32 字节  : HMAC-SM3 tag              覆盖 **前 N 字节全部**（含 magic+version+iv）
```

**两处常量表没写、P1 必须自己钉死的口径**（都会影响跨实现对拍，已同步信箱）：

1. **SM4 密钥 = KDF 输出的前 16 字节**（而不是"前 32"）：见上面那条 ⚠️。
   多出来的 16 字节不参与运算；`enc[16..32]` 纯粹是"输出 64 字节"这条接口的副产物。
2. **tag 放在尾部**：§0.1 只钉了"覆盖范围"，没钉位置。选尾部的理由：EtM 的自然写法是
   "先算完密文再算 MAC"，且**先验后解**时不依赖任何长度假设。

**版本分派（`crypto::decrypt`，双读 + 三条边界）**

| 头 | 走向 | 备注 |
|---|---|---|
| `0x53 0x01` | v1 XChaCha20-Poly1305（P0 起默认） | 用 `legacy` 密钥 |
| `0x53 0x02` | v2 国密 | 用 `sm.enc/sm.mac`；无国密实现或无密钥 ⇒ **可操作**报错（不装成"数据损坏"） |
| 无头 / 其它 | **先按 v0 试**（P0 之前的 `nonce‖ct`） | 撞头（首两字节恰好是 magic+版本号，概率 1/65536）必须仍可读 |
| `0x53 0x03+` | 明确报"请升级再打开" | 老端读新密文的唯一正确姿势（§0-C） |

**密钥材料**：`crypto::AppKeys { legacy, sm: Option<SmKeys{enc,mac}> }`，由 `derive_app_keys` 一次派生：

- `legacy` = **Argon2id**（口径**不许动**）：它同时是 SQLCipher 的 `PRAGMA key` 原始密钥，
  且是 v0/v1 双读的钥匙 ⇒ 国密构建里也**必须**是同一个值（`security.rs` 有用例钉住这一点）；
- `sm` = **PBKDF2-HMAC-SM3**（§0.1 那条），只喂应用层 AEAD。
- 两条 KDF 复用同一个 16 字节盐：域不同（Argon2id / PBKDF2-HMAC-SM3），复用不引入额外风险。

**§0-D 压测读数（这就是"写死"的依据）**

```text
cargo test --release --features sm-crypto --lib -- --ignored --nocapture kdf_cost
Apple M4 Max（macOS 15，release）
Argon2id（默认参数）        ：    19.7 ms
PBKDF2-HMAC-SM3   50000 轮  ：    32.5 ms
PBKDF2-HMAC-SM3  100000 轮  ：    50.6 ms
PBKDF2-HMAC-SM3  200000 轮  ：    91.8 ms
PBKDF2-HMAC-SM3  400000 轮  ：   183.6 ms   （≈4.6 ms / 万轮，线性区）
```

**取值：`SM_KDF_ROUNDS = 200_000`**（`crypto_sm.rs` 一个常量，配 `kdf_rounds_are_the_pinned_value` 断言防改小）。
本机解锁合计 ≈ **112 ms**；按单核性能比（M4 Max ≈ 中端 SoC 的 4–6 倍）**外推**中端机 ≈ **0.4–0.7 s**，
落在 §0-D 的"< 1 秒"内且留了一倍余量。

> ⚠️ **诚实标注两件事**：
> ① 上面那个中端机数字是**外推**，不是设备实测 —— 真机读数属于 Android/Windows 真机验收（§7），**未完成**；
> ② 20 万轮**低于** OWASP 对 PBKDF2-SHA256 的 600k 建议。理由是本方案的硬约束是"中端机 < 1 秒"，
> 且应用层 AEAD 之上还有 SQLCipher 自己的 256000 轮 PBKDF2-HMAC-SHA512。若甲方要求对齐 OWASP，
> 需要先拿到真机读数、并接受解锁可能 > 1 秒 —— **这是一个可以被推翻的决定**，不是既成事实。

**三条路径（§7 验收项逐条勾，都在 `--features sm-crypto` 下有用例）**

| 路径 | 入口 | 用例 |
|---|---|---|
| 附件静置（含同步上传/下载） | `security::encrypt/decrypt_attachment_bytes` | `security::tests::national_crypto_covers_all_three_paths_…` |
| 同步载荷 | `security::encrypt/decrypt_payload` | 同上 |
| 导出附件副本（导出包里那条读路径） | `attachments::export_attachment_to` | `attachments::export_attachment_tests::encrypted_export_under_national_crypto_…` |

**跨实现对拍在 macOS 上真跑（2026-09-19，本轮补）**

```text
# 先编 Tongsuo（见 §3 表里新加的那一行；装到 <p>/lib）
SHUYONOTE_TONGSUO_OPENSSL=$HOME/tongsuo-macos/install/bin/openssl node scripts/check-gm-conformance.mjs
  对拍另一方：Tongsuo: Tongsuo 8.5.0-pre2 (Library: Tongsuo 8.5.0-pre2) / OpenSSL 3.5.4
gm-conformance: ✅ 通过 —— 跑成 12 个用例（含跨实现对拍）
  T1–T5 Tongsuo 对拍：标准向量 / 双向互解 / 密文逐字节相同 / HMAC 一致 / PBKDF2-HMAC-SM3 与拆 key 口径
```

⇒ **④ 的 macOS 那一半取证完成**：Tongsuo 自己命中 GM/T 0002/0004 标准向量；两个方向都解得开对方的密文；
**两侧密文逐字节相同**（CBC＋PKCS#7 下的最强证据）；HMAC-SM3 tag 一致。与 AMD 的 Linux 读数同源同 commit。

> 合并说明（2026-09-19）：本节最初按 **9/9** 写（T1–T4 ＋ R1–R4）。同一天 AMD 在 dev 上
> （`748d6233`）**独立发现了同一个 8 字节探针 bug**，并补了 **T5 = PBKDF2-HMAC-SM3 跨实现 ＋
> 「SM4 取前 16 字节 / MAC 取后 32 字节」两条拆 key 口径**（正好是本轮信里请他们确认的那两条 ——
> 也就是说口径 1 现在**由可执行判据回答**，不靠回信承诺）。合并后 macOS 侧复跑 = **12/12**。

> ★ **这一跑顺带抓出一个我自己的判据缺陷（值得写下来）**：Tongsuo 探针原来喂的是 **8 字节**明文给
> `-nopad` 的 SM4-ECB —— 8 不是分组整数倍 ⇒ openssl 退出码非 0 ⇒ 探针**恒 false** ⇒
> **T1–T4 永远走"跳过"那一支**。后果不是红，而是"给了 Tongsuo 也照样绿并自报跳过"：
> 判据看着在岗，其实从来没开过火（而这台机器上一直没编 Tongsuo，所以谁都没发现）。
> 修了两处：① 探针喂**恰好一个分组**（就是标准向量那 16 字节）并断言等于期望密文；
> ② **指名了 `SHUYONOTE_TONGSUO_OPENSSL` 却用不了 ⇒ 红，不是跳过** —— 这两件事后果完全不同
> （没给路径＝这台机器没装；给了却打不开＝这一路判据失效），后者伪装成跳过时人会以为"对拍有了"。
> 三种状态都实测过：不设变量 3/3 绿并自报跳过；指名 `/nonexistent/openssl` 与 `/bin/cat` 各**红**
> （报错直接点出"这不是跳过"）；指名真 Tongsuo 12/12 绿。
> 另：探针**证不出对方身份** —— macOS 自带的 LibreSSL `/usr/bin/openssl` 也把 9 条全过了
> （它也有 SM4）。所以门禁现在会把**对拍另一方的版本行**打出来，让读数可复核，而不是靠名字。

**⑤ 的当前状态（本轮实测，不是转述方案的判断）**

`src-tauri/target/release/build/libsqlite3-sys-*/output` 里写着 `cargo:rustc-link-lib=framework=Security`
⇒ **macOS 上 SQLCipher 现在编的确实是 CommonCrypto 后端**（Apple 那套只有 AES），
方案 §3 第 5 条那句在**本机本构建**上成立。⇒ 要编进国密 provider，必须显式设 `OPENSSL_DIR` 到 Tongsuo，
并加一条"断言实际加密后端"的门禁（**未做**，属 ⑤）。

**仍然不在 P1 范围（下一轮 / 别人的格子）**

- §0-C 的**另外两条**：空间元数据记录本空间算法、同步载荷带算法标识（状态字段已加：`EncryptionStatus.format/algorithm`）；
- 库级页加密/HMAC 换 SM3 系（P2-P3，AMD 的 provider 补丁线）；
- macOS 库级 Tongsuo＋切掉 CommonCrypto 默认（§3 第 5 条）；
- 真机验收（§7 后两条）与"用旧版生成的加密库/附件在新版打开"的**端到端**回归。

---

## 1. 范围

档 3 = **四层全换**：① 口令派生 ② 应用层 AEAD ③ **库级静置密文** ④ 传输层。

| 覆盖面 | 在不在范围内 | 依据 |
|---|---|---|
| 桌面端（Tauri，Windows/macOS/Linux/Android） | ✅ | 加密开关与 `PRAGMA key` 都在 Rust 侧（`security.rs:126-128`） |
| **iOS** | ⚠️ **不在此次交付范围**（未开始），**但接入时必须一并解决** | 无 `ios.yml`、`MOBILE.md:35` 记 iOS 未开始；且 Apple 平台编译期走 **CommonCrypto（只有 AES）** ⇒ 见 §3 第 5 条与[利弊与跨平台 §5.1](2026-09-17-sm-crypto-tradeoff.md) |
| 导出包 / 整库备份 zip | ✅ | 走同一个 AEAD（`crypto.rs:62-89`） |
| 附件静置（`attachments/`） | ✅ | E1 起附件加密，同一套原语 |
| 同步载荷（push/pull） | ✅ | M2.2 起客户端加解密、服务端只转发密文 |
| **Web 版** | ❌ **不在范围** | `web.ts:2916` 的 `encryption_status` 恒为 `{enabled:false}`，`set_encryption`/`lock`/`unlock`/`disable` 均为空实现；且 Web 版不提供多设备同步 |
| 同步**服务端**自身 | ❌ 不在本次范围 | 只转发密文；其账号口令存储若也要国密，属另一仓库的独立话题 |

---

## 2. 算法映射（终版）

| 层 | 现在 | 换成 | 备注 |
|---|---|---|---|
| 口令 KDF（应用层） | Argon2id（`crypto.rs:40-46`） | **PBKDF2-HMAC-SM3** | 国密**没有** Argon2 的对应物（无内存硬化）⇒ 迭代次数要定值并压测解锁耗时，口令强度策略要补（**怎么定**见 §0-D） |
| 库 KDF（SQLCipher） | PBKDF2-HMAC-SHA512（默认 `PBKDF2_ITER`） | **PBKDF2-HMAC-SM3** | SQLCipher 侧属可扩展枚举（§3） |
| **库页加密** | AES-256-CBC（**编译期由 provider 决定**） | **SM4-CBC** | ⚠️ **运行期不可切**，必须新增 provider（§3、§4） |
| 库页完整性 | HMAC-SHA512（默认） | **HMAC-SM3** | 枚举新增一项，可 PRAGMA 指定 |
| 应用层 AEAD | XChaCha20-Poly1305，`nonce(24)‖ct`（`crypto.rs:61`） | ✅ **已定（2026-09-17）：SM4-CBC ＋ HMAC-SM3（encrypt-then-MAC）** | 密文格式**必然变化** ⇒ §0-A 与 §4 是前提；**为什么不选 SM4-GCM** 见 §0-B |
| 附件 / 导出 / 同步载荷 | 同上 | 同上 | **三条路径必须一起改**，漏一条就是"一半国密" |
| 更新包签名 | minisign（Ed25519） | **不做 SM2（已决定，2026-09-16）** | 理由见 §5.3：不在甲方的系统边界内，且内网离线部署下自动更新本就不可用 ⇒ 换签名要重做整条发布管线与密钥管理，**成本高、对客户零收益** |
| 传输层 | TLS 1.3（rustls / native-tls） | 国密 TLS（GM/T 0024） | **本方案最难的一块**，见 §6 |

**不变的一项（有意为之）**：附件内容寻址继续用 **SHA-256**（`attachments.rs:291-292` 的文件名即内容 sha256）。
换成 SM3 = 全库附件改名 + 同步标识全变 + 需要全库重命名迁移。SHA-256 是公开摘要算法，通常不在"密码合规"审查重点内；若客户明确要求摘要算法也国密，需单独立项（成本与档 3 同级）。

---

## 3. 库级加密：证据与路线（档 3 的核心）

**证据**（`~/.cargo/registry/src/…/libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c`）：

| 事实 | 位置 |
|---|---|
| 加密后端**编译期可插拔**：`SQLCIPHER_CRYPTO_OPENSSL` / `SQLCIPHER_CRYPTO_LIBTOMCRYPT` | L109507-109510、L109928-109931 |
| HMAC 算法是**带标签的枚举**，并且可 `PRAGMA cipher_hmac_algorithm` | L109357-109362、L112304-112325 |
| KDF 算法是**带标签的枚举**，可 `PRAGMA cipher_kdf_algorithm` | L109365-109370、L112350-112364 |
| 默认值：`default_hmac_algorithm = SQLCIPHER_HMAC_SHA512`、`default_kdf_iter = PBKDF2_ITER` | L109681-109684 |
| **没有 `cipher_algorithm` 这类 PRAGMA**（只有 `page_size` / `hmac_algorithm` / `kdf_algorithm` / `plaintext_header_size`） | L112162-112364 |

⇒ **结论：KDF 与 HMAC 可以运行期切，页加密算法不行 —— 它由编译期的 provider 决定。** 所以档 3 必须新增 provider，而不是加一条 PRAGMA。

### 三条路线（**已定：A**）

| | 做法 | 评价 |
|---|---|---|
| **A（已定，2026-09-16）** | **SQLCipher ＋ Tongsuo（OpenSSL 分支，原生带 SM2/SM3/SM4）＋ 新增一个薄 provider** | 顺着它**既有的接缝**做；Tongsuo 与现有 vendored-openssl 构建链同源（`Cargo.toml:102-111`），构建风险可控 |
| B | 只把 KDF 与 HMAC 换 SM3 系，页加密仍是 AES | **不满足档 3**（除非客户接受"派生与完整性国密、页加密 AES"）——不采用 |
| C | 采购支持国密的 SQLite 加密产品 | 仅在"要求认证产品"时才需要；**客户已确认"用国密算法"⇒ 不需要** |

### 库选型（**已定**）

**约束决定了选型**：SQLCipher 的 provider 层是 **C**，它调的是 OpenSSL EVP / libtomcrypt —— **纯 Rust 的 `sm4`/`sm3` crate 插不进这一层**。所以：

- **库级页加密 ⇒ 必须用 C 层国密库 ⇒ Tongsuo**（OpenSSL 分支，`EVP_sm4_cbc` / `HMAC(SM3)` / `PKCS5_PBKDF2_HMAC(SM3)` 都是现成的）；
- **应用层 AEAD ⇒ 建议也统一走 Tongsuo**（Rust 侧 FFI 调用）。理由：**一套实现、一套测试向量、一份合规说明**；若应用层另用 RustCrypto，就会出现**两份 SM4 实现**，对审计与跨端互通都是额外负担。
- 代价与既有前提：桌面/Android 本来就在编 vendored OpenSSL（`Cargo.toml:102-111`），**换成 Tongsuo 是同一条构建路径**，不是新增一条。

> 若后续发现 Rust 侧 FFI 成本不可接受，应用层可退回 RustCrypto，但**必须与库级实现做标准向量对拍**，并把"两份实现"写进文档。

### Tongsuo 构建情报（**AMD 实测，2026-09-17** —— P3 直接用）

| 项 | 实测结果 |
|---|---|
| **Linux 构建** | ✅ **成功，13 秒**（`-j32`，2086 个编译单元）⇒ **"Perl + Configure"那一关在 Linux 上不是问题**（历史上卡过的是 Android 的精简 Perl） |
| **macOS 构建（2026-09-19，Mac 实测，补）** | ✅ **成功**：`git clone --depth 1 https://gitee.com/mirrors/Tongsuo.git`（Gitee 镜像可达；克隆到源码 commit **`540603a3`**，与 AMD Linux 侧**同一个 commit**）⇒ `./Configure --prefix=<p> no-tests && make -j8 && make install_sw`。`openssl version` = **`Tongsuo 8.5.0-pre2`（底层 OpenSSL 3.5.4）**；SM3("abc") 命中 GM/T 0004 向量。⚠️ **安装目录 macOS 是 `<p>/lib`**（Linux 是 `lib64/`、Android 是 `lib/`）—— 三个平台三种，别照抄；二进制带 `@rpath` 到 `<p>/lib`（本机不用设 `DYLD_LIBRARY_PATH` 也能跑）。用它跑对拍：`SHUYONOTE_TONGSUO_OPENSSL=<p>/bin/openssl node scripts/check-gm-conformance.mjs` ⇒ **12/12（含 T1–T5 跨实现）** |
| 版本 | Tongsuo **8.5.0-pre2**（OpenSSL 3.5.4 底），源 = **Gitee 镜像** commit `540603a3` |
| ⚠️ **源码别从 GitHub 取** | **两侧的 GitHub 都不通**（Windows 是 DNS 污染、AMD 那台 443 直连失败）⇒ **统一用 Gitee 镜像** `https://gitee.com/mirrors/Tongsuo.git`（实测可用，`8.2-stable` 等分支在） |
| ⚠️ **安装路径** | `./Configure --prefix=<p> no-tests && make -j && make install_sw`；**装到 `<p>/lib64/`，不是 `lib/`**（AMD 第一次就栽在这） |
| ⚠️ **运行期** | Linux 要 `LD_LIBRARY_PATH=<p>/lib64`，Windows 是 `PATH`；否则会去链系统的 `libssl.so.3` |
| 算法自证 | **GM/T 0002 SM4 向量**（ECB 无填充）= `681edf34d206965e86b3e94f536e4246` **逐字一致**；**SM3("abc")** = `66c7f0f4…4ba8e0` **一致**；SM4-CBC 往返一致 |
| SM4 模式齐备 | CBC / CCM / CFB / CTR / ECB / GCM / OFB / XTS **全在**（含 OID：SM4-GCM `1.2.156.10197.1.104.8`、CCM `.104.9`、ECB `.104.1`） |
| ⚠️ **不要过度解读的** | **TLCP 协议层没验**（`openssl ciphers -tlcp` 无输出）—— 这只证明**算法原语**可用，**不能当成"TLCP 可用"**；SM2 只验了密钥生成，不作为结论 |
| **Android 交叉编译** | ✅ **成功**（`android-arm64=ok`，API 24，**NDK r29**，make 9 秒；产物 `lib/{libcrypto.a,libssl.a,libcrypto.so,libssl.so}` 与 `bin/openssl` 确认是 ELF aarch64）——**历史上卡过的那一关过了**。⚠️ **两个坑**：① **只认 `ANDROID_NDK_ROOT`**（`Configurations/15-android.conf`），只设 `ANDROID_NDK_HOME` 会死在 `$ANDROID_NDK_ROOT is not defined` ⇒ **三个都设**（`ROOT`/`HOME`/`NDK`）；② **安装目录：Linux 是 `lib64/`、Android 是 `lib/`**（按 Linux 经验找会误判成"没产出"） |
| ⚠️ **Android 的边界（别读成"跑得起来"）** | **交叉编译成功 ≠ 能执行**：Android 可执行体要 `/system/bin/linker64`，NDK sysroot 里没有 ⇒ qemu 起不来。**但这不是当前阻塞项**：真正的验收是**Android 真机跑应用**（§7「Android 真机回归」：口令 → 加密 → 重启解锁 → 读写），**不为"替代自证"去做模拟器或静态链接** |
| ⚠️ **NDK 版本口径** | 本地实测用 r29 = `29.0.14206865`，仓库 pin 的是 `29.0.13846066`（差一个小修订）⇒ **"能交叉编译"成立，但不能声称与 CI 逐字一致** |

### 3.1 ⚠️ P2 与 P3 是**同一条** provider 补丁线（2026-09-17 AMD 实测，**改排期**）

**被推翻的前提**：原方案把 P2 写成「改 PRAGMA 就能把 KDF/HMAC 换成 SM3 系」——**不成立**。
AMD 把 vendored amalgamation（`libsqlite3-sys-0.38.2/sqlcipher/sqlite3.c`，9.2 MB）翻了一遍：

| 事实 | 值 |
|---|---|
| 全文件 SM3 命中 | **0**（`SM3` / `sm3` / `EVP_sm3` 各 0 次） |
| `cipher_hmac_algorithm` 可取值 | 只有 `HMAC_SHA1 / HMAC_SHA256 / HMAC_SHA512` |
| `cipher_kdf_algorithm` 可取值 | 只有 `PBKDF2_HMAC_SHA1 / SHA256 / SHA512` |

⇒ **PRAGMA 层根本没有 SM3 这个取值**，它背后是**编译期 provider**（`sqlcipher_provider` 结构体，L109372 起：
`hmac` / `kdf` / `cipher` / `get_hmac_sz` 全是回调）。
**要上 SM3 必须动 provider，而 P3 的 SM4 页加密也动同一个结构体** ⇒ **P2/P3 合并为一条补丁线**（§6）。

**四处必改**（行号取自 0.38.2 的 `sqlite3.c`）：

| # | 位置 | 改什么 |
|---|---|---|
| 1 | L109358-109370 附近 `*_LABEL` 宏 ＋ 枚举 | 新增 `SQLCIPHER_HMAC_SM3_LABEL "HMAC_SM3"` / `SQLCIPHER_PBKDF2_HMAC_SM3_LABEL "PBKDF2_HMAC_SM3"` 与对应枚举 |
| 2 | **L112304+**（`cipher_hmac_algorithm` 解析/回显）、**L112350+**（`cipher_kdf_algorithm`） | 各加一个 SM3 分支 ＋ 回显分支 |
| 3 | **L113641**（`get_hmac_sz` → 返回 **32**）、**L113961-113976**（`kdf`：`PKCS5_PBKDF2_HMAC(..., EVP_sm3(), ...)`）、**L114074**（`hmac`：`HMAC(EVP_sm3(), …)`） | SM3 分支 |
| 4 | 页加密 `cipher` 回调（P3） | SM4-CBC（**这里才需要 Tongsuo/OpenSSL 的 `EVP_sm4_cbc`**）——与第 3 项同一文件、同一结构体 |

**应用侧要同步改（纯 Rust，可并行）**：

1. **开库 PRAGMA**：全仓现在只有一条 `PRAGMA key = "x'<hex>'"`（`security.rs:128`），**没有任何 `cipher_*` 设定**
   ⇒ 吃的是 SQLCipher 默认（PBKDF2-HMAC-SHA512 / HMAC-SHA512 / 256000 迭代）。
   P2 要**显式**写 `PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SM3;`（新库），并保留旧库的 SHA512 读取路径。
2. ⚠️ **P0 是硬前置（AMD 复核后确认"真的硬"，不是"最好有"）**：KDF/HMAC 一换，**旧库连页 HMAC 都验不过**——
   不是"读出乱码"，而是**直接打不开**。⇒ 必须走 `sqlcipher_export()` 重写库，或**按库记录算法**——
   **P0 的密文头/版本号正是干这个的**。
3. **迭代数**（§0-D）仍留空：AMD 的夹具**故意不断言迭代数**，只断言「给定 key/iv/明文的字节一致性」⇒ P2 落地时**夹具不需要改**。

**P2 交付时 AMD 承诺提供的验收**：对拍夹具（已在信箱 `gm-conformance/`）、**旧库→新库迁移用例**（要真跑 `cargo test`，正好在他那台）、
以及 **provider 反向验证门禁**——断言**编出来的二进制里 SQLCipher 真的用上了 SM3**（不是"独立 openssl 命令行能用"），
这条与 §7 的「断言实际 provider」是同一件事。

### 需要改的点（A 路线）

1. **新增 provider**：SM4-CBC 页加密 ＋ HMAC-SM3 页 MAC ＋ PBKDF2-HMAC-SM3 派生；
2. **`libsqlite3-sys` 构建侧**开放 provider 选择（当前只认 `openssl` / `libtomcrypt` 两条）；
3. **文件结构尽量不变**：16 字节 salt 头、页大小、保留区维持原样 ⇒ 迁移与备份逻辑基本可复用；
4. 迁移沿用既有双向迁移思路（`security.rs:148-172` 的 `sqlcipher_export`），但**跨算法导出**要先验证"一条连接里能否同时打开两种 cipher"。
5. ⚠️ **必须显式钉死加密后端（2026-09-17 补）**：`libsqlite3-sys` 在 **Apple 平台**（`host` 与 `target` 都是 Apple）且没设 `OPENSSL_DIR` 时，
   会被编译成 **CommonCrypto 后端**（`build.rs:246-249` 加 `-DSQLCIPHER_CRYPTO_CC` ＋ 链 `Security.framework`），
   而该后端**只有 AES**（`sqlcipher/sqlite3.c:114266` 硬编码 `kCCAlgorithmAES128`）
   ⇒ **macOS 今天根本不在 OpenSSL 后端上**（iOS 同理），不显式切换就**编不进国密 provider**。
   选路只看 `OPENSSL_DIR` 一个环境变量（`build.rs:350` 的 `find_openssl_dir()`），而 `release.yml:81-88` 只给 Windows 设了它
   （该处注释"mac/linux 系统自带"**对 macOS 不成立**）。
   ⇒ 要求：构建侧**显式指定** Tongsuo/OpenSSL 后端，并加一条**门禁断言实际编进去的是哪个 provider**
   ——「构建通过」与「能打开国密库」是两件事。

**风险与控制**：维护一份加密 provider 是**长期成本**，升级 SQLCipher 要重放补丁。控制手段：
- 补丁**尽量薄**——只加枚举项 + 调 Tongsuo 的 `EVP_sm4_cbc` / `HMAC(SM3)`，不自己实现分组算法；
- 把**补丁与 SQLCipher 版本号钉在一处**（一个常量 + 一条门禁断言），升级时必炸而不是静默漂移。

---

## 4. 应用层、迁移与兼容

沿用决策文档的迁移顺序（**顺序不能颠倒**）：

1. **密文格式版本化（P0，见 §7 与 §0-A）** —— 现在是裸 `nonce(24)‖ct`，无算法标识 ⇒ 不先做，换算法后**老数据无法双读**。
   **已定格式（2026-09-17）**：头部 **2 字节 = 1 字节 magic ＋ 1 字节版本**，文本与二进制两条路径共用；
   旧数据无头 ⇒ 视为版本 `0`（现状 XChaCha20）。**版本号同时承担"算法标识"的第一层职责**（第二层见 §0-C）；
2. **双读**：`decrypt` 先读 2 字节头再按版本分派（`0` = 旧 XChaCha20；`SM` = SM4-CBC＋HMAC-SM3）；
   **遇到不认识的版本/算法要明确报错，不许当成"数据损坏"**（同步侧同理：整空间层面就拒绝并提示升级，见 §0-C）；
3. **后台重写**（可中断/可恢复/带进度）：附件逐个重加密、导出包新写用新算法、**空间库按 §3 迁移**；
4. **回归 fixture**：用**当前版本生成的加密库与加密附件**做固定样本，断言"新版本仍能打开"——这是唯一能防"把老用户数据锁死"的手段；
5. ✅ **测试向量（Linux 侧已实做，2026-09-17，AMD）**：SM3（GM/T 0004）、SM4（GM/T 0002）用**标准测试向量**断言；再加一条**跨实现一致性**用例（RustCrypto ↔ Tongsuo），防两侧实现漂移。
   夹具在信箱仓 `gm-conformance/{Cargo.toml, src/main.rs, driver.sh}`（两侧可直接取）。**实测 ALL PASS 8/8**：
   SM4-ECB 标准向量**三方一致**（RustCrypto = Tongsuo = `681edf34…4246`）、SM3("abc") 一致、
   RustCrypto→Tongsuo 解密一致、**Tongsuo→RustCrypto 解密明文一致且两侧密文逐字节相同**（CBC+PKCS#7 下的最强证据）、
   HMAC-SM3 tag 一致（32 字节）。
   > ⚠️ 夹具里的口径（照 §0.1）：套件 SM4-CBC ＋ HMAC-SM3、PKCS#7 填充、IV 16B；
   > **加密/MAC 用同一把密钥只是为了证算法一致**，真正的 EtM 组装（**两把独立密钥 ＋ 版本头‖IV‖密文**）由 P1/P2 的调用方负责；
   > **迭代数没有进断言**（§0-D 留空，先压测再写死）。
   >
   > **三个会白折腾半小时的 crate/shell 坑**（AMD 实测）：
   > ① `sm4 0.6`/`cbc 0.2.1` 解析到 **`cipher 0.5.2`**（不是 0.4）⇒ 带填充的辅助方法是
   > **`encrypt_padded_vec::<P>()` / `decrypt_padded_vec::<P>()`（没有 `_mut`）**，且分别在
   > **`BlockModeEncrypt` / `BlockModeDecrypt`** 两个 trait 上；
   > ② **`new_from_slice` 在 `KeyInit` 上、不在 `Mac` 上**（写 `<HmacSm3 as Mac>::new_from_slice` 会报 **E0576**）；
   > ③ **`sh`(dash) 的 `printf` 不展开 `\xHH`** ⇒ 造二进制向量要用 `printf '%s' <hex> | xxd -r -p`，
   > 否则输入变成超长字符串，**对面会算出一个"看起来合理"的错误答案**（第一版就栽在这，SM4-ECB 出来 48 字节）；
6. **`ENC_VERIFY` sentinel**（`crypto.rs:16`）必须支持"按旧算法校验 → 用新算法重写"，否则老用户卡在解锁这一步。

---

## 5. 传输层国密

### 5.0 已确认的事实（2026-09-16）

- **甲方侧没有国密网关/密码机** ⇒ **路径 1 排除**（这一条原本是最低成本、最可能的形态，现在不成立）；
- 调研结论（**这条改变了判断**）：
  - **Tongsuo 支持 TLCP 与 TLS1.3+SM2**，而且**字节跳动的生产级 Rust 框架 `g3` 有现成做法**：`--features vendored-tongsuo`，文档写明用途就是 **GB/T 38636-2020（TLCP）与 RFC 8998（TLS1.3 + SM2）** —— 见 [g3/doc/openssl-variants.md](https://raw.githubusercontent.com/bytedance/g3/refs/heads/master/doc/openssl-variants.md)；
  - ⇒ **路径 3 不需要从零写 TLS connector**，而是"把 `native-tls`/`rustls` 换成 `rust-openssl` ＋ vendored Tongsuo，并开出 TLCP 套件"。**真正的瓶颈是构建链（Tongsuo 在 MSVC 上的构建），不是 API；**
  - 另有纯 Rust 的国密协议栈 [GM-Engineers/gm](https://gitcode.com/GM-Engineers/gm)（SM2/SM3/SM4/SM9 ＋ TLCP/GM-TLS ＋ HTTP 客户端），但 **0 star、无生产先例** ⇒ **不押在商用安全交付上**，仅作观察。

### 5.1 剩余两条路径

| 路径 | 做法 | 成本 | 评价 |
|---|---|---|---|
| **2（保底，随手就有）** | **应用层端到端国密**（档 3 已覆盖：载荷本身就是 SM4）＋ 传输层保持标准 TLS | ≈1 人日（几乎为零额外工作） | 若客户要求的实质是"**数据在链路上是国密密文**"，这条**已经满足** |
| **3（要做协议本身）** | 客户端 `rust-openssl` ＋ **vendored Tongsuo** 开 TLCP（**或 RFC 8998：TLS 1.3 ＋ 国密单证书**，与 TLS 1.3 同代）；**服务端也要换**（Tongsuo 版 Nginx 或 Rust 侧 vendored-tongsuo） | **1–2 周**（含两端 ＋ 构建链） | 客户明确要求"**传输层协议本身必须是国密**"时才做 |

### 5.2 决定（**已定，2026-09-17**）：**先做路径 2，路径 3 暂缓**

1. **路径 2 就是最终形态（本次交付）**：档 3 做完，链路上的载荷本身就是 SM4 密文
   ⇒ **不需要任何额外开发**，传输层保持标准 TLS。**P4 因此从「1 人日 / 1–2 周」降为 ≈0**（只剩 §5.3 的边界表要写）。
2. **路径 3 暂缓，不是否决**。重启条件写死，免得以后靠回忆决定：
   - 客户明确要求「**传输层协议本身必须是国密**」（而不只是「链路上是国密密文」）；
   - 或者某项测评/招标文件直接点名 TLCP / RFC 8998。
   满足其一 ⇒ 另立文档与排期（1–2 周，含两端 ＋ 构建链），**不在本次交付内**。
3. **原「先做 spike 定路径 3」的动作要拆成两半**（暂缓的是后者，不是前者）：
   - ⚠️ **Tongsuo 的构建（MSVC / Android NDK）仍在主线** —— 它是 **P3 库级 provider 的硬前置**
     （provider 要调 Tongsuo 的 `EVP_sm4_cbc` / `HMAC(SM3)`）。**暂缓路径 3 ≠ 可以不编 Tongsuo。**
   - ✅ **用 Tongsuo 开一条 TLCP 连接**那部分随路径 3 一起暂缓，只作「哪天要重启路径 3」的预研。
   风险预判仍有效：Tongsuo 与 OpenSSL 同源，构建同样要 **Perl + Configure**，本项目在 Android 上
   已因 Git-for-Windows 的精简 Perl 卡过一次（`Cargo.toml:108-109`）——**它是 P3 的第一关，别晚确认。**

> 顺带一个对 iOS 的好处（见[利弊与跨平台](2026-09-17-sm-crypto-tradeoff.md) §5.2）：路径 3 要换 TLS 栈、
> 会连带重做 Android 的 `rustls-platform-verifier`，在 iOS 上还要自管 SM2 信任链。
> **走路径 2 则完全不动 TLS ⇒ 这三个平台面都不受影响。**

### 5.3 国密边界声明（交付文档要照实写）

一条清晰、可辩护的边界，比"全都国密"的口号有用：

| 面 | 是否国密 | 说明 |
|---|---|---|
| **数据面**：静置密文（库/附件）、导出包、同步载荷 | ✅ **是** | 档 3 全链路 |
| **传输层** | ⚠️ **数据面国密、传输层标准 TLS（路径 2，已定）** | 链路上的**载荷**是 SM4 密文；协议本身仍是 TLS 1.3。**交付说明必须照这句写**，不要含糊成"全链路国密" |
| **控制面 / 基础设施**：更新包签名（minisign/Ed25519）、插件索引签名 | ❌ **不是（已决定，见 §2）** | 不在甲方系统边界内；内网离线部署时自动更新本就不可用 |
| 内容寻址摘要（附件 SHA-256） | ❌ 保持 SHA-256（**有意为之**，§2） | 换 SM3 = 全库改名 + 同步标识失效 |

> 原则：**该是国密的地方做实，不是国密的地方写清** —— 交付说明里如实列出这张表，比含糊其辞经得起问。

---

## 6. 分阶段任务清单（每阶段独立可交付、可回滚）

| 阶段 | 内容 | 估算 | 前置 |
|---|---|---|---|
| **P0** | **密文格式版本化**（`crypto.rs` + 迁移分派 + fixture） | **1 人日** | 无 —— **建议立刻做**，与档位无关、不改算法行为 |
| **P1** | 应用层 SM4：附件 / 导出包 / 同步载荷三条路径 ＋ 双读 ＋ 回归 | 2–3 人日 | P0 |
| **P2＋P3**（**2026-09-17 合并为一条线**，见 §3.1） | **provider 补丁线：SM3 先、SM4 后** —— 同一文件 `sqlcipher/sqlite3.c`、同一 `sqlcipher_provider` 结构体；分两次提交，但**同一分支、同一人** | 4–7 人日 | **P0（硬前置）** |
| **P4** | 传输层：**走路径 2（已定，2026-09-17）** ⇒ 无新开发，只把 §5.3 的边界表写进交付说明。路径 3 暂缓，重启条件见 §5.2 | **≈0**（原 1 人日 / 1–2 周） | ✅ 已定 |
| **P5** | 全链路真机验收 ＋ **老数据可读回归** ＋ 文档 | 1–2 人日 | P1–P4 |

**总估算**：**约 8–13 人日**（**路径 2 已定**，不含路径 3）；路径 3 若重启，另加 1–2 周。

---

## 7. 验收标准

> 状态更新（2026-09-19，Mac，dev `f4151be1` 之后）：打勾 = **有可执行判据且当前绿**（命令附在行内），
> 半勾 = 只完成了一半（写清缺哪一半）。**真机/端到端那几条一律不勾** —— 本机单测绿不等于真机绿。

- [x] **老数据可读**（**单测层**）：`crypto-legacy-v0.json` 金标夹具 3 格（文本/撞头/二进制）＋
      `legacy_headerless_data_still_reads` ＋ `legacy_data_whose_first_two_bytes_look_like_the_header_still_reads`
      （P1 起对 **v1 与 v2** 两个版本号各验一遍）—— `cargo test --lib crypto::`
      ⚠️ **端到端那半没做**：用旧版**真的**生成一个加密库 ＋ 加密附件再拿新版打开，属真机验收。
- [ ] 新装用户：口令 → 加密 → 重启解锁 → 读写正常（**桌面真机**，不只看单测）
- [ ] 加密开关双向迁移（开→关、关→开）数据不丢
- [x] 附件 / 导出包 / 同步载荷**三条路径全覆盖**（**应用层 AEAD 层**）：`security::tests::national_crypto_covers_all_three_paths_…`
      ＋ `attachments::export_attachment_tests::encrypted_export_under_national_crypto_…`
      （都只在 `--features sm-crypto` 下编，由 `rust-sm-crypto` 这条常开门禁跑）
- [ ] 页加密确为 SM4（直接读文件头/用错算法打开应失败，而不是"看起来能用"）
- [x] SM3 / SM4 标准测试向量通过（**RustCrypto 侧**）：`crypto_sm::tests::sm4_primitive_matches_the_gmt_0002_vector`
      ＋ `sm3_primitive_matches_the_gmt_0004_vector`；跨实现一致性见下一行
- [x] **跨语言一致性**：常开门禁 `gm-conformance`；macOS 上编出 Tongsuo（commit `540603a3`）后
      **12/12 全绿含 T1–T5**（标准向量 / 双向互解 / **两侧密文逐字节相同** / HMAC 一致 /
      **PBKDF2-HMAC-SM3 与拆 key 口径**）；
      不设 `SHUYONOTE_TONGSUO_OPENSSL` 的机器上仍是 3 条 ＋ 自报跳过（**指名却用不了则判红**）
- [x] 锁定态不读库（`vault.ts` 既有约束不回退）：`security::tests::lock_gates_key_and_sync` 仍绿
- [ ] Android 真机回归（SQLCipher/OpenSSL 在 Android 上是另一条构建链，见 `Cargo.toml:102-111`）
- [x] **格式头有测试向量钉住**：2 字节头的编码/分派、以及「无头 = 版本 0」的判定（§0-A）
      —— `new_ciphertext_carries_the_version_header_on_both_paths` ＋ 撞头回退两条
- [x] **EtM 正确性有测试**：MAC 覆盖版本头 ＋ IV ＋ 密文；**篡改任一处都必须先失败、且不解密**（§0-B）
      —— `crypto_sm::tests::tampering_anywhere_fails_before_decrypting` ＋ `encryption_and_mac_keys_are_not_interchangeable`
- [x] **未知算法明确拒绝**：老端读新密文/同步载荷时给出"请升级客户端"，**不是"数据损坏"**（§0-C）
      —— `unknown_future_version_gets_an_actionable_error` ＋ 默认构建读 v2 的 `…rejects_v2_with_an_actionable_error`
      ⚠️ §0-C 的另两条（**空间元数据**记录本空间算法、**同步载荷**带标识）**未做**；状态字段那条已加
      （`EncryptionStatus.format/algorithm`）
- [x] **KDF 迭代有断言**：常量写死 ＋ 断言防止被改小（`kdf_rounds_are_the_pinned_value`）；
      压测记录在 §0.2（本机 ≈112 ms 解锁；**中端机数字是外推、非实测**，见 §0.2 的两条诚实标注）（§0-D）
- [ ] **构建门禁断言实际加密后端**：确认编进去的是 Tongsuo/OpenSSL 而不是 Apple 的 CommonCrypto（§3 第 5 条）
      —— 现状**已实测**为 CommonCrypto（build output 里有 `framework=Security`），切后端与门禁**均未做**

---

## 8. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 客户实际要"**认证产品**" | 自研 provider 白做 | §10 优先确认；预留切到认证模块的接缝 |
| 自维护加密 provider | 长期正确性 + 升级成本 | 走 Tongsuo 提供算法原语，补丁只做"接线"；版本钉死 + 门禁 |
| 无版本号就换算法 | **老用户数据打不开** | P0 先做；fixture 回归 |
| 误把附件 SHA-256 一起换掉 | 全库改名 + 同步标识失效 | §2 明确不换 |
| 传输层选错路径 | 1–2 周白做 | §5 先确认口径与部署形态 |
| Android 构建链（vendored OpenSSL/Tongsuo + NDK Perl） | 已在历史上卡过（`Cargo.toml:108-109`） | P3 阶段先用桌面验证，再单独排 Android |
| **Apple 平台默认编成 CommonCrypto 后端（只有 AES）** | **macOS 上国密 provider 根本没被编进去**；「能编过」与「能开 SM4 库」不是一回事；同一平台不同机器可能编出不同后端 ⇒ 静默的数据不互通 | §3 第 5 条：显式设 `OPENSSL_DIR` 到 Tongsuo ＋ **门禁断言实际 provider**；验收项补一条「换后端前后旧库仍可读」 |

---

## 9. 分工与协作纪律

| 归属 | 范围 |
|---|---|
| **国密（A）** | `src-tauri/src/crypto.rs`、`src-tauri/src/security.rs`、`src/lib/vault.ts`、`libsqlite3-sys` provider 补丁、迁移与 fixture |
| PDFium（B） | `src-tauri/src/pdf_native.rs`、打包配置、对拍脚本（见 [PDFium 方案](2026-09-16-pdfium-engine-plan.md)） |
| **交界（`Cargo.toml` / `Cargo.lock`）** | **各自分支开发，合并时由一人统一处理冲突**（2026-09-17 明确：**不做"先 A 后 B"的硬阻塞**——国密的依赖在 P3，而 PDFium 的 `pdfium-render` 与之无关，硬串行会白等几周） |

### 9.1 三台机器的分工（**2026-09-17 定**，按机器能力排，不按人头）

| 模块 | 谁 | 依据（实测） | 依赖 / 何时能动 |
|---|---|---|---|
| **国密 P0** 密文版本化（纯 Rust） | **Mac** | 要能跑 `cargo test` 才能闭环（写＋测＋fixture）；**Windows 本机跑不了**（`0xc0000139`） | 无 —— **立刻能动** |
| **国密 P1** 应用层 SM4 三条路径 ＋ 双读 ＋ 回归 | **Mac** | 同上；且 **F 裁定后不再依赖 Tongsuo 构建链** ⇒ 可全程并行 | P0 |
| **国密 P2** SQLCipher KDF/HMAC 换 SM3 系 | **AMD** | 库级改动必须在能跑测试的环境验（WSL2 302 条） | P0 |
| **国密 P3** SM4 页加密 provider ＋ Tongsuo 构建 | **AMD 全包（provider 补丁 ＋ Linux/Android/MSVC 三侧构建，2026-09-17 起）** | provider 是 C 层、在 Linux 侧验证最顺；MSVC 侧**已移交 AMD**（owner 决定；Windows 不改本机系统环境）。Windows 侧已探明的前置：**Git for Windows 那个精简 Perl 就是第一关**（本项目在 Android 上已被它卡过）、`cl`/`nmake` 不在 PATH（要先 `vcvars64`）、**无 nasm**（否则要 `no-asm`）、源码走 **Gitee** | P2；**接口先定**：补丁文件 ＋ 版本钉死，Windows 消费 |
| **Apple 后端切换**（CommonCrypto → Tongsuo） | **Mac** | 只有它摸得到那台机的 Xcode/Perl/Homebrew 状况 | **第二波**（见下），是 macOS 库级国密的硬前置 |
| **PDFium P1–P3** 新模块 / 分派 / 对拍 | **Windows** | dll 已落盘、MSVC 能编能出包 | 无 —— **立刻能动**（分支 `feat/pdfium-engine`） |
| **PDFium 对拍报告** | **三边各跑自己平台** | 同一份样本集，各平台各自出结论 | H 决定的样本集 |
| **PDFium 多平台校验和**（§0.2-G） | **谁的平台谁补** | 要从 GitHub 下载，而**本机 DNS 被污染、出站受限** ⇒ 网络顺的那侧更快 | `fetch-pdfium.mjs` 已有 |
| **打包 P4** | Windows 包 / macOS 公证 / Linux·Android | 各平台自己 | P1–P3 |

**排期裁定：macOS 的库级国密放第二波**（不进首批交付）。理由：它是**唯一**需要为 Apple 单独解决"构建 ＋ 后端切换"的平台，
而首批交付的主战场是 Windows／信创桌面／Android。**应用层国密在 macOS 上照样生效**（附件/导出/同步载荷都是 SM4，F 裁定后是纯 Rust）
⇒ 边界表按平台分列即可，不用含糊。

⚠️ **验收纪律（硬要求）**：**Windows 跑不了 `cargo test`，所以 Windows 侧的改动必须由 AMD 或 Mac 复核**——
"在我这边编过了"不等于"测过了"，更不等于"能打开国密库"。

**git 纪律**：❌ 禁止 `git add -A`（本仓库有并发会话，曾误提交他人 WIP）；✅ 只 `git add <自己的文件>`，提交前对 `git status --porcelain`。

**发布纪律**：国密与 PDFium **不要同时合入 main 并发布** —— 一个动"数据能不能打开"，一个动"内容能不能显示"，同时上真机出问题时无法归因。

**归属与许可（2026-09-17 定）**：国密代码**进开源主干**（`feat/sm-crypto` → `dev` → `main`），**不分叉商业版**。
依据：CLA 已定稿（保留版权 ＋ 授予再许可权，同一份代码可出 AGPL 与闭源授权两版）；**Tongsuo 为 Apache-2.0**（OpenSSL 分支），与 AGPL-3.0 兼容，**不引入新的 copyleft**，登记进 `THIRD-PARTY-NOTICES` 即可。

连带要求（进主干不是只改一句话）：

1. **主干要有一条常开的国密构建 job**——否则国密路径会变成"没人编、坏了也没人知道"的死代码；
2. **Tongsuo 源码按 `fetch-pdfium.mjs` 的套路钉版本 ＋ 校验和**，不许"下载即用"；
3. **默认算法仍是 v1（XChaCha20）**，国密**按空间可选**，不做全局默认（KDF 降级不该强加给全体开源用户）。

仍待定：无。主干国密路径**已定用 feature 门控 ＋ 一条常开 CI job**（§0-E）。

---

## 10. 待确认 → **已全部关闭**（2026-09-17）

原第 4 条（构建门控）也已在 §0 拍掉，这一节保留为台账，**不再是开工前置**。

1. ~~"用国密算法" vs "通过认证的商用密码产品"~~ ✅ **已确认（2026-09-16）：用国密算法**
   ⇒ §3 走**路线 A**（SQLCipher ＋ Tongsuo ＋ 薄 provider），**不需要采购认证模块**，本方案其余部分不受影响；
2. ~~传输层走路径 2 还是路径 3~~ ✅ **已定（2026-09-17）：先做路径 2，路径 3 暂缓**
   —— 甲方**无**国密网关 ⇒ 路径 1 排除；**路径 2 为本次交付形态**（档 3 的载荷本身就是 SM4，零额外开发，P4 ≈0）；
   **路径 3 暂缓（非否决）**，重启条件 = 客户明确要求「传输层协议本身必须是国密」或招标/测评点名 TLCP / RFC 8998（§5.2）；
   ⚠️ 澄清：**Tongsuo 的构建仍在主线**（P3 硬前置），暂缓的只是「用 Tongsuo 开 TLCP 连接」那半；
   ⇒ 交付说明按 §5.3 如实写「**数据面国密 ＋ 传输层标准 TLS**」，不含糊成「全链路国密」；
3. ~~更新包签名是否也要 SM2~~ ✅ **已决定：不做**（§2 与 §5.3），并在交付说明的国密边界表里**如实列出**（不悄悄省略）；
4. ~~密文格式头、应用层 AEAD、算法标识落点、KDF 迭代、构建门控~~ ✅ **已定（2026-09-17）：见 §0 的五条**。
