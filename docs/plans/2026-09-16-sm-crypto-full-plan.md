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
| **E** | ~~主干国密路径 = feature 门控（`--features sm-crypto`）＋ 一条常开的国密 CI job~~ **⚠️ 2026-09-20 已被 §3.4 取代（应用层那一半）**：`sm-crypto` 改成**默认特性**，默认构建写 v2；`--no-default-features` 只作回滚通道 | 原理由（默认构建不被 Tongsuo/Perl 构建链风险绑架）**对库级仍然成立** —— 应用层国密是**纯 Rust**，打开它不引入任何构建链风险；库级（`sm-library`）仍按本节形态，等 §3.2 A 路落地后再谈是否只发一个构建 | `sm-crypto` 进 `default`；原 `rust-sm-crypto`（跑 `--features sm-crypto`）因此与 `rust-test` **同值**，已**改名并改指回滚通道** ⇒ `rust-no-sm-crypto`（`--no-default-features`，2026-09-20）；见[利弊与跨平台 §7.1](2026-09-17-sm-crypto-tradeoff.md) |
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
| KDF | **PBKDF2-HMAC-SM3**；盐 **16 字节**；输出 **64 字节 → 前 16 加密 / 后 32 MAC**（⚠️ 2026-09-19 更正：SM4 是 **128 位**密钥，原来写的「前 32 加密」不成立；**输出长度仍是 64 字节**，见 §0.2 口径 1）；**迭代次数 = 200000**（已压测写死，§0.2） | §0-D、§0.2 |
| 密文头 | **2 字节**（1B magic ＋ 1B 版本）；文本路径整体 base64、二进制路径直接用 | §0-A |
| 实现来源 | 应用层 **RustCrypto**；库级 **Tongsuo**；**双向对拍是验收项** | §0-F |
| RustCrypto 侧可用性（**2026-09-17 实测**） | `sm4 0.6.0`、`cbc 0.2.1`（含 `block-padding`）、`sm3 0.5.0`、`hmac 0.13.0` **全在**（`cargo add --dry-run`） | 回答 AMD 的"先确认 crate 齐不齐" |

> ⚠️ **历史记录**：上表那一格原来写的是"**前 32** 加密"，P1 落地时发现它与"SM4"不能同时成立
> （SM4 是 **128 位 = 16 字节**密钥）⇒ 已**直接改格**（而不是只写在注里：只读表不读注的人会拿走旧口径，
> 而这条口径错了的症状正是"跨设备互相解不开"）。取法是"**64 字节输出不变、SM4 取前 16 字节**" ——
> 保留 64 字节是为了**两侧逐字节可比**（Tongsuo 侧同一句 `PKCS5_PBKDF2_HMAC(..., EVP_sm3(), 64, out)`），
> 改输出长度会让对拍失去意义。详见 §0.2 口径 1，判据见 T5② 与 `crypto_sm` 的黄金向量用例。

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

**KDF 黄金向量（两侧独立产出、逐字节相同 ⇒ 谁都能拿去钉）**

```text
参数：pass=a-typical-passphrase  salt=5a×16  iters=200000  out_len=64
KDF ：b5623ce8682771b65b7d72a9c0b707adad32fa36e0c03ee92f2832ac594ffad9
      9c3469e8dc977dd3fd159ef69d41d39742a54f140e932498e5b5c069fb0861d4
⇒ SM4 密钥 = 前 16 字节  b5623ce8682771b65b7d72a9c0b707ad
⇒ MAC 密钥 = 后 32 字节  d99c3469e8dc977dd3fd159ef69d41d39742a54f140e932498e5b5c069fb0861d4
```

这条向量是 **AMD 用真 Tongsuo 的 CLI 产出的**，本机再用自家 `tools/gm-conformance kdf` **复算一遍、
逐字节相同**才写进 `crypto_sm::tests::kdf_golden_vector_and_key_slicing`（两侧独立产出，不是抄数）。

**为什么非要有它**（AMD 2026-09-19 提出、本机实测确认）：T5 只证明"给同一个输入时两侧一致"，
证明不了"**应用里那两行切片取的是哪 16 个字节**"。承重证明（本机跑的变异）：
把 `sm4_key()` 从 `enc[..16]` 改成 `enc[16..32]`，**往返／确定性／EtM 那 8 条全绿**，
**只有这条黄金向量红** —— 也就是说没有它，改错切片会一路静默，而症状是跨设备互解失败。

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

**§0-C 最后两条落地（2026-09-19，Mac）**

§0-C 的原文要求是"算法标识除了密文头，还要落到**空间状态 ＋ 同步载荷**"，
目的只有一个：**老端在整空间/同步之前就明确拒绝并提示升级**，而不是逐条解密失败、让用户以为数据坏了。
落法（**不动服务端、不动线格式** —— 标识本来就藏在密文头里，缺的是"**动手之前**去看它"）：

| 机制 | 实现 | 判据 |
|---|---|---|
| 不解密就能读版本 | `crypto::peek_format` / `format_supported` / `unsupported_format_error` | `crypto::tests::peek_format_reads_the_header_without_a_key`（三格：无头/v1/v2 ＋ 未来版本 ＋ 非密文） |
| **同步整批拒绝** | `security::ensure_payloads_supported`；`sync.rs::do_pull` 在**应用循环之前**调 `prescan_payload_formats` | `sync::tests::prescan_payload_formats_refuses_the_whole_batch`（一批里夹一段 v2 ⇒ 整批 Err；明文/无载荷放行） |
| **空间级标识** | `meta.workspaces.cipher_format`（幂等迁移）＋ `space_format()` / `ensure_space_format_supported()`，并在 **`sync_gate`** 里挡住 | `db::tests::meta_migrate_adds_cipher_format_to_an_old_meta_db`、`security::tests::space_guard_refuses_v2_in_the_default_build`／`…allows_v2_in_the_sm_build` |
| **附件拒绝**（★ 堵住一个**安静损坏**） | `decrypt_attachment_bytes` **先看头**：认得出但本构建解不开的版本 ⇒ **拒绝**，不再"解不开就当明文" | `security::tests::attachment_bytes_of_an_unsupported_format_are_refused_not_passed_through` |

> ★ **附件那条是本轮最值得记的**：旧的"解不开 ⇒ 透传"逻辑对**明文附件**是对的（加密未开时存的就是明文），
> 但对"**本构建读不了的密文**"是灾难 —— 它会把密文当明文交给上层，**安静地写出一个损坏的文件**，
> 比报错更坏。所以改成："看着就是我们的密文、但版本解不开" ⇒ 拒绝并说清换哪个版本；
> "认得出的版本但解不开（口令不同）"与"根本不是密文" ⇒ 维持老的透传语义（不许把老行为改坏）。

> ⚠️ **诚实边界**：`prescan` 的判据只覆盖那个**纯函数**的语义；"必须在应用循环之前调用"由
> `do_pull` 里的调用点位置保证，**没有起真服务端做端到端**（属真机/集成验收）。附件的同类判据
> 也只在默认构建下断言"拒绝"，国密构建下的"放行"由 cfg 的另一半覆盖。

**⑤ 的当前状态（本轮实测，不是转述方案的判断）**

`src-tauri/target/release/build/libsqlite3-sys-*/output` 里写着 `cargo:rustc-link-lib=framework=Security`
⇒ **macOS 上 SQLCipher 现在编的确实是 CommonCrypto 后端**（Apple 那套只有 AES），
方案 §3 第 5 条那句在**本机本构建**上成立。

### F2 落地：E1（磁盘加密）下的「导出/备份」两条路（2026-09-20，Mac，commit `f64f2320`）

**问题（我自己列的待修项，两处都是「失败不显式」）**

| 路径 | 老行为 | 为什么不能接受 |
|---|---|---|
| `workspace_io::export_workspace` | E1 下**直接失败**：`backup is not supported with encrypted databases`（SQLCipher 在线备份要求**目标同钥**，代码给的目标不带钥） | 用户**根本导不出**自己的空间 |
| `backup::export_backup` | 同一原因 + 加密空间只在 stderr 打一行 `备份跳过加密空间 …` | 用户拿到一个「看起来成功」的包，**里面却没有那些空间的数据** |

**改法（只修"失败的表达"，不改语义）**

- `backup_db_to(src, dst, Option<&[u8;32]>)`：目标可选同钥（产物是**密文快照**）。
- `workspace_io::snapshot_plaintext`：同钥密文快照 → **copy 到 dst** → `security::convert_space_db(dst,false,key)` 就地解密
  → 末尾**契约自检**（非空 ＋ 非密文头 ＋ 不带 `PRAGMA key` 能读到表）。
  ⚠️ 两个自己踩到的坑写在这里：① `convert_space_db` 是**就地**转换，不先 copy 就会把明文写在中转文件上、
  `dst` 根本不存在；② 自检**不能**只靠「打开成功」—— `Connection::open` 会把不存在的文件建成空库，
  空明文库的 `SELECT COUNT(*) FROM sqlite_master` 也会成功返回 0。
- `backup::snapshot_spaces()`（抽出后可单测，不再需要 `AppHandle`）→ `(成功快照, skipped)`，
  `BackupResult.skipped` 带回界面；**单个空间失败不再中断整个备份**，而是记名跳过；
  `BackupButton` 有 skipped 时给**红字**并列出空间与原因。
- 邻接顺手补：`import_backup` 用**当前**会话钥读备份里的密文快照，另一台设备/另一个口令的备份会在读时失败，
  原始报错是 `file is not a database`（`PRAGMA key` 本身不报错，SQLCipher 到第一次读写才验钥）
  ⇒ `snapshot_read_diagnosis` 翻成「这套备份是另一套密钥写的 ＋ 该怎么办」；明文快照**不套**这个解释。

**取证（本机 macOS 默认构建，读数带 commit）**

| 结论 | 判据 | 读数 |
|---|---|---|
| E1 导出仍然给**明文**快照（导入契约） | `workspace_io::tests::snapshot_plaintext_from_an_encrypted_source_is_readable_without_a_key` | ✅ |
| 加密空间**真的进备份**（目标同钥、密文可读）＋ 锁定态**记名跳过** | `backup::tests::snapshot_spaces_keys_the_encrypted_space_and_names_what_it_skips` | ✅ |
| 跨密钥快照给**可操作**错误（不是 `file is not a database`） | `backup::tests::cross_key_encrypted_snapshot_gets_an_actionable_diagnosis` | ✅ |
| **变异证明**（不是"看着像能盖住"） | ① 把 `snapshot_plaintext` 退回「不给钥」⇒ 红，报错正是 `backup is not supported with encrypted databases`；② 锁定态退回「只打日志」⇒ 红（`跳过必须被记下来：[]`） | ✅ 两次都红 |
| 门禁 | `pnpm verify` ／ `node scripts/test-report.mjs --group rust` | **23/23** ／ **6/6**（rust-test **394/394**、rust-sm-crypto **407/407**） |

> 诚实边界：以上都是**单测 + 变异**。真机上的「导出 → 换机/换口令 → 导入」仍属**人手验收**（见 §7 未勾项）。

### ⑤-1 换后端（2026-09-19 落地，含一个**必须写下来的坑**）

**坑（本条的真正价值）**：方案说"选路只看 `OPENSSL_DIR` 一个环境变量"——**选路逻辑**是这样，
但**只设它没用**：`libsqlite3-sys` 的 `build.rs` 只为 `SQLITE_MAX_*` / `LIBSQLITE3_FLAGS` /
`SQLCIPHER_{INCLUDE,LIB}_DIR` 这些声明了 `rerun-if-env-changed`，**没有为 `OPENSSL_DIR` 声明** ⇒
cargo 认为"环境没变" ⇒ **构建脚本根本不重跑**。实测现场（本机）：

```text
OPENSSL_DIR=$HOME/tongsuo-macos/install cargo test …   ⇒ 编译通过、测试全绿
产物 target/debug/build/libsqlite3-sys-*/output       ⇒ **仍然是 framework=Security**（CommonCrypto）
```

⇒ **"设了环境变量" ≠ "换了后端"**。必须逼构建脚本重跑：

```text
cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml
OPENSSL_DIR=$HOME/tongsuo-macos/install cargo build --lib --manifest-path src-tauri/Cargo.toml
node scripts/check-crypto-backend.mjs        # 拿产物说话，不看你设了什么
# 期望：✓ … ⇒ **openssl**（link-search=…/tongsuo-macos/install/lib，路径含 tongsuo）
```

**兼容性（换后端最容易出事的地方）**：SQLCipher 的页加密参数（PBKDF2-HMAC-SHA512 轮数 /
AES-256-CBC / 页大小 / HMAC 大小）在两套 provider 上一致，所以**既有库仍应可读** —— 但这是判断，
不是证据，所以有夹具：`src-tauri/tests/sqlcipher-backend-fixture.db` 是 **2026-09-19 由 macOS 默认
（CommonCrypto）后端真实写下**的加密库（生成器 `security::tests::gen_backend_fixture`，key = `0x07 × 32`）。
判据 `security::tests::fixture_db_written_by_the_other_provider_still_opens` 断言：**两行内容逐字相同、
且还能继续写**。读数（2026-09-19）：在 **Tongsuo/OpenSSL 后端**下 `cargo test --lib security::` = **14/14 通过**
（含上面这条 ＋ `encrypted_db_roundtrip_and_sniff` / `convert_space_db_*` / `full_loop_enable_restart_unlock_readable_disable`）
⇒ **换后端前后旧库仍可读**这条验收项**取证完成**。

> ⚠️ **国密（Tongsuo）构建上核对这一格，要同时给两个声明**（2026-09-20 我自己踩了一次）：
> `SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl SHUYONOTE_EXPECT_SM_PATCH=applied node scripts/check-crypto-backend.mjs`。
> 另外：产物标记里的 `patch=` 自 2026-09-20 起是**补丁文件 sha256 的前 8 位**（`patch=337aac60` = 补丁 v2），
> 不再是写死的 `v1` —— 写死的字面量在补丁升级后就不再标识任何东西，跨机核对会只剩 `src_sha256` 一根柱子。
> 只给 `SHUYONOTE_EXPECT_SM_PATCH` 会**假红** —— macOS 的平台默认是 `commoncrypto`，
> 门禁会如实报「声明要 commoncrypto，但最新产物是 openssl」。一键自证 `gm-version-selfcheck`
> 里这两个声明都已写死，所以它不会踩；**手敲单条命令时会**。

**门禁**：`check-crypto-backend`（rust 组）—— 读 `libsqlite3-sys` 的构建产物，断言
**实际编进去的后端 == 声明**；`SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl` 是国密构建的严格模式。
状态分得很清：**没有本平台产物 ⇒ `!` 自报"未实查"**（没编过 ≠ 编错；只编了别的平台也算没查）；
**最新产物 ≠ 声明 ⇒ 红**；**认不出后端 ⇒ `!` 未实查**（不装绿）；
**旧产物分类不同 ⇒ `!` 提示**（那是"沉默不换后端"的现场痕迹）。

**★ 第二个坑（AMD 2026-09-19 在 WSL 上把我抓出来的，比第一个更隐蔽）**：第一版把 target 目录写死成
`<root>/src-tauri/target` 且"最新 mtime 胜出"。AMD 那台用 `CARGO_TARGET_DIR=/home/tester/shuyonote-target`
（ext4，避免与 Windows 共用目标目录）⇒ 门禁**去读了仓库里那份 Windows 产物**，报出 `✓ openssl`，
而 Linux 产物一个字没读。⇒ **"绿得不是它声称的那件事"**。已修（三条都是他建议的）：
① 认 `CARGO_TARGET_DIR`；② 按当前平台过滤候选（Windows 产物带盘符反斜杠路径）；③ 过滤后只剩别的平台 ⇒ **未实查**。
判据侧补了 4 条（`check-crypto-backend.test.mjs`，共 19 条），端到端也实测了三态：
真实产物 ⇒ ✓；`CARGO_TARGET_DIR` 只含 Windows 产物 ⇒ 未实查；混合目录且 Windows 那份 mtime 更新 ⇒ **仍挑 unix 那份**。承重证明（本机双向实测）：
产物 openssl ＋ 声明 openssl ⇒ 绿；产物 CC ＋ 声明 openssl（**正是我自己踩的那一脚**）⇒ 红并附清库命令。

**库级国密的构建侧开关（2026-09-19 补）**：新增 feature **`sm-library`**（与 `sm-crypto` 分开：
应用层不吃构建链，库级才吃）。打开它 ⇒ `src-tauri/build.rs` **fail-fast**：
没给 `OPENSSL_DIR` 就**当场构建失败**，并把 Tongsuo 构建 ＋ `cargo clean -p libsqlite3-sys` 的完整修法打进报错里。
三种状态实测：① 不带 `sm-library` ⇒ 默认构建照旧（后端 CC，符合声明）；② 带 `sm-library` 不给 `OPENSSL_DIR`
⇒ 当场失败；③ 带 `sm-library` ＋ `OPENSSL_DIR=<Tongsuo>`（clean 后）⇒ 编过，门禁确认后端为 **openssl**。
> 这条的设计理由：**"没给 OPENSSL_DIR"本身不会报错**，它只是安静地编出一个没有国密算法的库 ——
> 库级国密版不能有这种结局（要么显式指定、要么当场死）。

**⚠️ 已拍板：macOS 的默认构建不翻到 Tongsuo（owner，2026-09-19，选项 A）**，
维持"默认包＝Apple CommonCrypto ＋ 国密版另发"（§0-E 的形态）；改判触发条件写在 §7 对应项里。
当时的判断依据（现已成为定论，保留以供复核）：**没有**把 macOS 的**默认**构建翻到 Tongsuo。两个理由：
① 翻了就等于要求**每个 macOS 开发者与默认 CI**都先编一份 Tongsuo —— 与 §0-E「国密版另发、默认包不背构建链风险」直接冲突；
② 库级 SM4/SM3 的 provider 补丁（P2/P3）**还没落地**，此时翻默认**用户可见行为零变化**，只多一个
`libcrypto.3.dylib` 的打包/签名/公证负担。⇒ 正确形态是**国密版 macOS 构建显式设 `OPENSSL_DIR` 并用本门禁的严格模式断言**；
这件事与 P2/P3 一起做（**归属**：构建侧与门禁＝本侧；provider 补丁＝AMD）。

**CI 读数（GitHub check-runs API，2026-09-19 配额恢复后取到）**

| commit | checks（单测/冒烟/契约） | mobile | Rust job | build-macos / android |
|---|---|---|---|---|
| `f4151be1`（上一轮） | ✅ | ✅ | ✅ **success** | ✅ / ✅ —— **5/5 全绿** |
| `ba7d889a` | ✅ | ✅ | ❌ **failure**：`rust-sm-crypto`（真红，见下） | 当时仍在跑 |
| `4c0ef41b`（修复后） | ✅ | ✅ | ✅ **success**（**含 `rust-sm-crypto`**） | 该 commit 只触发 3 个 job（未改打包面） |
| `4b5eceec`（⑤⑥ 落地后） | ✅ | ✅ | ✅ **success**（含 `rust-sm-crypto`、**`check-crypto-backend`**） | 当时仍在跑 |
| `f4151be1`（已记） | — | — | — | — |

⚠️ **这一格我先前写过头了，此处更正**：我原话是"`check-crypto-backend` 在 Linux 上转绿 ⇒ 跨平台证据"。
AMD 在 WSL 上用同一条门禁实测后指出：**在 target 目录被重定向或与别的平台共用时，它会读错平台的产物** ——
他那台的 `✓` 报的其实是**仓库里那份 Windows 产物**（link-search 还是 `Files\OpenSSL-Win64\lib`），
**Linux 产物一个字都没读**。也就是说：那一格绿**绿得不是它声称的那件事**（比红更难发现）。
CI 那一格之所以还算数，只是因为 runner 上 `CARGO_TARGET_DIR` 没改、且只有 Linux 产物 ——
**是环境帮了忙，不是判据本身站得住**。修法见下（认 `CARGO_TARGET_DIR` ＋ 按平台过滤 ＋ 只剩别的平台 ⇒ 未实查），
修完这条才真的有资格跨平台说话。

⇒ **`rust-sm-crypto` 的第一条 CI 读数（Linux）就是绿的**，也正是 AMD 建基线所需的那份读数来源。

`f4151be1` 全绿这件事本身很重要：它是上一轮那三处修复（P3 对拍缺库**响亮跳过** ＋ CI 取库 ＋
cargo 类门禁的失败证据通道）的**收官证据** —— 在那之前 rust job 从 `97583c57` 起连红四次。
⚠️ **一处不许含糊的**：同一批注解显示当时**两条**门禁一起红（`rust-test` 与 `rust-plugins-alone`），
而 `rust-test` 的根因（缺 PDFium 库）已由"修完即绿"证到；**`rust-plugins-alone`（`cargo test --lib plugins::`
在 Linux 上 101）的机制至今没有直接证据**（本机 macOS 含缺库状态都是 117/0，plugins 测试里也 grep 不到
PDFium 依赖）—— 现在的状态是"**跟着一起绿了**"，不是"查清了"。要收口它，得等它再红一次并拿到输出尾巴注解。

**`rust-sm-crypto` 这条新门禁的 CI 证据（含它第一次就抓到的真问题）**：它在 rust 组里，所以 CI 的 rust job
自动跑它（§0-E 要的"常开 job"，不需要另加 workflow）。它**第一次上 CI 就红了**，而那条红是**真的**：

- 注解指名 `rust-sm-crypto`，失败明细 5 条 `security::` 用例；⚠️ **同样用例在默认构建里是绿的**
  ⇒ 与算法无关，是**测试隔离**问题；
- 根因：`security.rs` 测试的 7 处临时目录名是 `{pid}_{now_ms()}`（**毫秒**分辨率），而 `temp_ws()`
  开头就 `remove_dir_all` ⇒ 两个测试落在同一毫秒时，B 删掉 A 的库文件、且两边**共用一个 meta.db**
  ⇒ A 写了 `ENC_ENABLED=1`，B 的"未开启"用例读到"已开启"，一串跟着红；
- 复现方式是关键（**"调两次"是绿的，只有并发才红**）：8 线程 `Barrier` 同时进 `temp_ws()` ⇒ 改前 **5/5 红**、
  改后 3/3 绿；该探针留成常开判据 `temp_dirs_are_unique_under_concurrency`；
- 修法：`uniq_tmp(tag)` = `{pid}_{now_ms}_{AtomicU32 序号}`（保留 pid+毫秒便于事后定位）。
  读数：`rust-sm-crypto` **376/376**、`rust-test` **364/364**。

⇒ 这是"常开门禁"**自己挣回成本**的一例：这条测试隔离缺陷在默认构建下**永远不会露头**
（`clippy`/`tsc`/默认单测全绿），只有"把国密那一支也编出来跑"才会撞上。

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
| 导出包 / 整库备份 zip | ✅（**分项**，不能整体说国密） | 包里的**附件**是静置密文原样拷入 ⇒ `sm-crypto` 构建下是 v2 国密；但包里的**空间库 `shuyonote.db` 是明文**（导出/导入契约，`import_workspace` 按明文读）⇒ 只能答「附件国密、库那份明文」，见 §1.1 |
| 附件静置（`attachments/`） | ✅ | E1 起附件加密，同一套原语 |
| 同步载荷（push/pull） | ✅ | M2.2 起客户端加解密、服务端只转发密文 |
| **Web 版** | ❌ **不在范围** | `web.ts:2916` 的 `encryption_status` 恒为 `{enabled:false}`，`set_encryption`/`lock`/`unlock`/`disable` 均为空实现；且 Web 版不提供多设备同步 |
| 同步**服务端**自身 | ❌ 不在本次范围 | 只转发密文；其账号口令存储若也要国密，属另一仓库的独立话题 |

---

## 1.1 导出包到底「国密」在哪 —— 别把它整体读成一件事（2026-09-20 补）

**事实（可复跑）**：

| 包里的东西 | 加密状态 | 判据 |
|---|---|---|
| `attachments/<hash>` | **静置密文原样拷入** ⇒ `sm-crypto` 构建下是 `v2`（SM4-CBC ＋ HMAC-SM3） | `workspace_io::export_workspace` / `backup::export_backup` 的附件合并路径 |
| 空间库 `shuyonote.db` / `spaces/<id>.db` | **明文**（导入契约要求明文：`import_workspace` 按「imported plaintext DB」读） | `workspace_io::snapshot_plaintext` 末尾的**契约自检**（非空 ＋ 非密文头 ＋ 不带 `PRAGMA key` 能读到表） |
| 整库备份 zip | 同上（meta.db 明文、各空间库为**密文快照**、附件为静置密文） | `backup::snapshot_spaces` |

**为什么库那份是明文**：`import_workspace` 的契约就是「打开一个明文 SQLite 库」；改成密文包
要么动导入契约、要么额外加一层容器加密 —— 两者都不是「顺手改一行」，本次**明确不做**，
但**必须说清**：因此导出包**不能**整体宣称国密，且**包的安全性＝用户对这份 zip 的保管**
（这也是 e2e「导出→导入」在加密态下必须走真机验收的原因）。

---

## 2. 算法映射（终版）

| 层 | 现在 | 换成 | 备注 |
|---|---|---|---|
| 口令 KDF（应用层） | Argon2id（`crypto.rs:40-46`） | **PBKDF2-HMAC-SM3** | 国密**没有** Argon2 的对应物（无内存硬化）⇒ 迭代次数要定值并压测解锁耗时，口令强度策略要补（**怎么定**见 §0-D） |
| 库 KDF（SQLCipher） | PBKDF2-HMAC-SHA512（默认 `PBKDF2_ITER`） | **PBKDF2-HMAC-SM3** | SQLCipher 侧属可扩展枚举（§3） |
| **库页加密** | AES-256-CBC（**编译期由 provider 决定**） | **SM4-CBC** | ⚠️ **运行期不可切**，必须新增 provider（§3、§4） |
| 库页完整性 | HMAC-SHA512（默认） | **HMAC-SM3** | 枚举新增一项，可 PRAGMA 指定 |
| 应用层 AEAD | XChaCha20-Poly1305，`nonce(24)‖ct`（`crypto.rs:61`） | ✅ **已定（2026-09-17）：SM4-CBC ＋ HMAC-SM3（encrypt-then-MAC）** | 密文格式**必然变化** ⇒ §0-A 与 §4 是前提；**为什么不选 SM4-GCM** 见 §0-B |
| 附件 / 同步载荷（导出包里的附件同此） | 同上 | 同上 | **两条路径必须一起改**，漏一条就是「一半国密」；导出包里的**库文件**是明文，不在这一行 |
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

### 3.2 ⚠️ P3（SM4 页加密）不是"顺手加一个分支" —— 结构事实与两条路（2026-09-20 AMD 实测补充）

P2（SM3 页 MAC ＋ 库 KDF）**已落地**：`patches/0001-sqlcipher-sm3-provider.patch`（20 段 / 213 行，
打在 `libsqlite3-sys 0.38.2` 的合并文件 `sqlite3.c` 上）＋ 运行期判据 ＋ SM3 夹具双向读数；
`src-tauri/build.rs` 的产物标记行含 `src_sha256=<64hex>`（治"过期标记"）。**P3 与 P2 不是同一量级**，
下面是实测到的三条结构事实（行号对 0.38.2 的 `sqlite3.c`）：

| # | 事实 | 后果 |
|---|---|---|
| 1 | `sqlcipher_provider` 结构体（**L109373** 起）里的 `cipher` 回调签名是 `(void *ctx, int mode, const unsigned char *key, int key_sz, const unsigned char *iv, const unsigned char *in, int in_sz, unsigned char *out)` —— **没有 algorithm 参数** | provider **无法按调用**选页加密算法 |
| 2 | 页加密由 `#define OPENSSL_CIPHER EVP_aes_256_cbc()`（**L113769**）在**编译期**钉死，`cipher` / `get_cipher` / `get_key_sz` / `get_iv_sz` / `get_block_sz` **五处**都用它 | 换算法 = 换构建 |
| 3 | 本版**没有** `cipher_algorithm` PRAGMA：`cipher_settings` / `cipher_default_settings` 只回显 `kdf_iter` / `page_size` / `use_hmac` / `plaintext_header_size` / `cipher_hmac_algorithm` / `cipher_kdf_algorithm` 六项 | **运行期切不了页加密**（不是"没人写这条 PRAGMA"，是这一层不存在） |

**两条路（成本差要 owner 拍板）**：

> ✅ **已拍板（2026-09-20，owner）：走 A（编译期切换）。** 分工与落地顺序见本节末尾的「A 路施工单」；
> 交付/验收口径见 §3.3（迁移规格）与 §7；**B 不做**（记在这里以便将来改判时有依据）。


- **A. 编译期切换（薄，建议先做）**：补丁里把 `OPENSSL_CIPHER` 包成
  `#ifdef SQLCIPHER_SM4_CBC` → `EVP_sm4_cbc()`；构建时经 **`CFLAGS=-DSQLCIPHER_SM4_CBC`** 传进去
  （`cc` crate 认 `CFLAGS`，`scripts/sm-library-build.mjs` 加一个开关即可）。
  代价：**同一份 registry 源码只能有一种页加密** ⇒ 换算法要换构建（"改了补丁必须清库重建"那条纪律正好覆盖它）；
  门禁要按"这份构建是哪种页加密"分派。收益：不动结构体、不碰 codec 层。
- **B. 给 provider 加 algorithm 参数（厚）**：改 `cipher` 回调签名 ＋ **三个** provider 实现
  （openssl / CommonCrypto / libtomcrypt）＋ codec 层调用点，再新增 `cipher_algorithm` /
  `cipher_default_algorithm` PRAGMA 与回显分支。这是**上游级**改动（patch 面从 20 段涨到几十段），
  收益是"同一套库能同时有 AES 与 SM4 页加密"。

**已定 A**（2026-09-20，owner）。理由（当时给 owner 的那三条，原文留档）：
① 档 3 要的交付物是「**国密版构建**」，不是「一个库里同时两种页加密」；
② B 唯一真实场景是「同一台机器既要读老 AES 库、又要写 SM4 库」，而这恰好被 **A ＋ §3.3 的迁移路径**覆盖（迁移一次、之后单向）；
③ B 要动 provider 结构体 ＋ 3 个实现 ＋ codec ＋ 两个新 PRAGMA（patch 从 20 段涨到几十段），且**每次 `libsqlite3-sys` 升级都要重做** ——
成本落在我们这边，收益落在一个**产品形态不需要**的能力上。

**A 路施工单（2026-09-20 定，分工与顺序）**

| 步 | 内容 | 归属 | 前置 |
|---|---|---|---|
| ① | 补丁：把 `OPENSSL_CIPHER` 的**五处**用法包进 `#ifdef SQLCIPHER_SM4_CBC` → `EVP_sm4_cbc()`（键长/IV/块长三处也随之一致） | **AMD**（provider cell） | — |
| ② | 构建开关：`sm-library-build.mjs` 加 `--page-cipher sm4`，传 `CFLAGS=-DSQLCIPHER_SM4_CBC`；**开关打开而源码里没有那个守卫标记 ⇒ 当场失败**（否则就是「安静地没有国密」的同一族） | 我 | ① 的补丁里有可扫的标记 |
| ③ | 只读**产物**证明「这份构建是哪种页加密」＋门禁按页加密分派 ＋ 新增「页加密确为 SM4」那一格 | 我 | ① ② |
| ④ | §3.3② 的**可操作错误**（口令 vs 页加密算法两种成因 ＋ 下一步）；实测两种报错文本都要覆盖 | 我 | **不依赖 ①②③**（可先做） |
| ⑤ | 跨构建「明文中转」迁移端到端 ＋ §3.3 四条判据 ＋ 升级/回滚说明 | 我（AMD 复核） | ③ ④ |

⚠️ **③ 的诚实边界**：`cipher_settings` 里**没有** algorithm 字段（事实 3）⇒ 门禁**无法**从回显证明页加密算法；
唯一可信的判据是**实验**：拿一份已知 AES 页的库（`src-tauri/tests/sqlcipher-backend-fixture.db`）在本构建里打开 ⇒
**必须失败**；反向（SM4 页库在 AES 构建里打开）同样必须失败（§3.3 判据 1）。
⚠️ 同时要把一条容易读错的话写进交付文档：**页加密是整库属性，不是逐空间属性** ——
"按空间开国密"（§4 的最小风险做法）说的是**上层/应用层开关**；库级页加密一旦选定就是那个**库文件**的属性
（且协议里没有算法标识 ⇒ 解密端必须会 SM4）。这条不写清，"按空间开"会被读成"同一库混用两种页加密"。

**顺手记录一条 P2 的接线事实**（2026-09-20 实测更正，会改应用层接线点）：`PRAGMA key` **之前**设 `cipher_*`
会被**静默丢掉**（那时 codec ctx 还没建，`sqlcipher_codec_pragma()` 的 `if(ctx)` 整块被跳过）⇒
接线必须在 `set_cipher_key()` **之后**、第一次读写之前。详见 `src-tauri/src/gm_provider.rs` 文件头第二张表。

---

### 3.4 「没有真实用户、不考虑向后兼容」时的快路（2026-09-20 评估 → **同日 owner 已拍板：走快路**）

> ✅ **已拍板（2026-09-20，owner）**：按本节走「无兼容快路」。
> **已落地第 1 步**：应用层 `sm-crypto` 改成**默认特性** ⇒ **默认构建写 v2**（`src-tauri/Cargo.toml`），
> v0/v1 保留**只读**；旧行为 `--no-default-features` 保留作**回滚通道**。
> 库级（页加密 SM4）走 §3.2 的 A 路施工单，但**按快路简化为「无条件 SM4 页加密 ＋ 只有一种构建」**。
>
> 前提假设：**当前没有任何真实部署／试点数据**。这是一个**会过期**的前提 —— 一旦第一个真实部署产生数据，
> 本节整体作废（见节末「触发条件」）。本节只做分析，**不改变任何已定的东西**；拍板后才动代码。

**一句话结论**：兼容性负担**集中在四处**，其中三处会**直接消失**；而"每平台要带得起国密 C 库"这条
**一点都不会变便宜**（那才是关键路径）。⇒ 快路能省的是 **P3 的一半工作量（约 2–3 人日）与一半分支/判据**，
省不出"多平台出包 + 真机验收"。

| 层 | 保兼容方案（现状） | 无兼容快路 | 省 | 代价 |
|---|---|---|---|---|
| 应用层 AEAD | 写 v2、**双读** v0/v1、magic 撞头回退、`AppKeys` 双 KDF（Argon2id ＋ PBKDF2-SM3） | 写路径**只有 v2**、KDF 只有 PBKDF2-SM3 | 少一半写路径与 KDF 分支 | 失去"老密文"回退网（**建议保留只读分支**，见下） |
| 口令 KDF | Argon2id（legacy，库级密钥来源）＋ PBKDF2-SM3（应用层） | 只剩 PBKDF2-SM3 | 少一套 KDF 及其判据 | **无内存硬化**这条降级不变（与兼容无关） |
| 库级页加密 | **A 路**：`#ifdef SQLCIPHER_SM4_CBC` → 两种构建 ＋ 门禁分派 ＋ 迁移规格（§3.3 整节） | **无条件**换成 `EVP_sm4_cbc()`（key/iv/block 三处一并），**只有一种构建** | **§3.3 整项删除**（1–2 人日）＋ 门禁少一格分派 | 旧 AES 页库**永久不可读**（本前提成立时无所谓） |
| 库级 KDF＋页 MAC | 默认 PBKDF2-HMAC-SHA512 / HMAC-SHA512，需保留旧库读取 | 建库时即 `PBKDF2_HMAC_SM3` ＋ `HMAC_SM3` | 少一套"新库/旧库"分叉 | 同上（无旧库） |
| 传输层 | 载荷 SM4；协议仍是 TLS 1.3（路径 2，已拍板） | **不变**（真想全国密要 GM/T 0024：客户端 TLS 栈要换 Tongsuo 系，成本最高） | 0 | 「全链路国密」这句话仍要限定 |
| 控制面签名 | 更新包 minisign/Ed25519、插件索引签名 | **不变**（SM2 要重做发布管线与密钥管理） | 0 | 同上 |
| 打包与供应链 | 默认包走 Apple CommonCrypto（只有 AES）；国密版另发 | **每平台都必须带国密 C 库**（Apple 平台不能用 CommonCrypto）⇒ 从"可选"变成"发布前置" | CI/包矩阵从两种变一种 | 公证/rpath/jniLibs 体积等**工作量不变**，风险面变了 |
| 验收与门禁 | 双读/拒绝/格式分派/跨后端夹具/迁移四判据 | 只留"这一条路真的生效"的实验判据 | 判据与基线都要重写（`tests/baseline.json` 走 `--update-baseline`） | 删判据要按纪律说明理由 |

**⚠️ 无兼容也**不会**变便宜的四件事（别把它们算进"快路"）**

1. **每平台带得起国密 C 库**：SQLCipher 的页加密只能由 C provider 提供，Apple 平台不能用 CommonCrypto（只有 AES）
   ⇒ macOS/Windows/Android 必须随包 OpenSSL/Tongsuo，Linux 用系统 `libcrypto`。
   ⚠️ **一个待实查的事实**：数据面国密**不一定要 Tongsuo** —— 标准 OpenSSL ≥ 1.1.1 就有 SM3/SM4，
   `PKCS5_PBKDF2_HMAC(..., EVP_sm3(), ...)` 也可用；Tongsuo 主要在**国密 TLS（GM/T 0024）**那条线上不可替代。
   本机只有 LibreSSL，**未实查**；一条命令可证：`openssl list -cipher-algorithms | grep SM4-CBC` ＋ `list -digest-algorithms | grep SM3`。
2. **PBKDF2-SM3 没有内存硬化**：与兼容无关；实测 Argon2id 19.7 ms vs PBKDF2-SM3(200k) 91.8 ms（M4 Max，release），
   只能在迭代次数与口令策略上补。
3. **国密 TLS 与 SM2 签名**：都不是"兼容"造成的，属于另两条线（§5、§2）。
4. **真机验收**：桌面加密→重启解锁→读写、Android 一台、导出/导入往返 —— 人工，且**随包交付量只增不减**。

**★ 一条反直觉但省钱的建议：只删"写路径分叉 + 迁移 + 老端容错"，保留"读旧格式"**

"读旧格式"的能力**已经写好且已绿**（金标夹具 3 格 ＋ 撞头回退 ＋ 跨后端夹具），删它反而要动 7 条判据与基线，
而且它是最便宜的一张回退网：万一 v2/SM 实现出 bug，还能把数据读回来重写。
⇒ 真正该删的是：**双写分叉、迁移规格（§3.3）、为老端准备的整批拒绝与容错**。
⚠️ 但 `prescan`／"未知版本 ⇒ 可操作错误"那套**不许删**：它保护的是**未来**版本，不是向后兼容。

**触发条件（写进这里，定期复核）**：出现**第一个真实部署/试点数据**（哪怕是内部试用写进了不可丢的内容）
⇒ 本节作废，"无兼容"窗口关闭；届时按 §3.2 的 A 路施工单 + §3.3 迁移规格执行。

### 3.3 ⚠️ P3 的**迁移规格**（A/B 两条路都要，**不依赖 owner 先拍板哪条**）

> 为什么单列一节（2026-09-20，macOS 侧）：A/B 争论的是"**怎么把 SM4 页加密编进去**"，
> 而用户真正会撞上的是"**换了构建之后，我原来那些库怎么办**"。
> 这一节把迁移写死，owner 拍 A 还是 B 都不必重新讨论它；也顺手把 §7 里那句
> "老数据可读"改成它**实际的形态**：**经迁移后可读**。

**P3 前后到底变的是什么**：页加密算法是**库文件**的属性（§3.2 事实 2/3：编译期钉死、没有 `cipher_algorithm` PRAGMA）。
⇒ 一个把 `OPENSSL_CIPHER` 换成 `EVP_sm4_cbc()` 的构建，**打不开**别人用 AES 页加密写的库，反之亦然。
失败现场是 SQLCipher 的**笼统报错**（`file is not a database`）——**与"口令错"长得一模一样**。

**① 升级路径（两条，都要写进升级说明）**

| 路径 | 步骤 | 适用 |
|---|---|---|
| **明文中转**（推荐，唯一不依赖第二个构建的） | ① 用**能读老库的构建**（默认包）**关闭磁盘加密** ⇒ 走既有 `security::convert_space_db(path, false, key)`（它是**逐表重建**：自建 schema ＋ 逐表拷贝，**不依赖 `sqlcipher_export`**，所以**跨页加密算法**照样能把数据搬出来）；② 换国密构建；③ **重新开启**加密（`convert_space_db(path, true, key)`，此时写出来的是 SM4 页） | 单机升级、离线部署 |
| **导出/导入**（保留作兜底） | 老构建导出空间/整库包（注意：包里那份 `shuyonote.db` 是**明文**，见 §1.1）⇒ 国密构建 `import_workspace`（它会把明文库**按当前构建**重新加密） | 已经养成备份习惯的用户 |

> ⚠️ **"关加密"那一步必须在能读老库的构建里做** —— 这正是 A 路"同一份源码只能有一种页加密"的直接后果。
> 所以**升级说明里不能写"打开新版会自动迁移"**（做不到：新版根本读不出老库的行）。这一点必须显式告知，
> 否则用户会把它读成"升级坏了"。

**② 未迁移库必须给**可操作**错误（不是 `file is not a database`）**

要落在 `security::` 的开库失败路径（`unlock` / `open_space_conn` / 空间格式门）上，文本形态固定为三条：
**① 可能是口令不对；② 也可能是这个库用了另一种页加密算法（AES 页 vs SM4 页）；③ 下一步：用原构建打开并先"关闭磁盘加密"（或从导出包导入），见升级说明**。
- 判据形态（现在就能登记、**P3 之前不许标 ✅**）：解锁失败时错误文本必须同时含"口令"与"页加密算法"两种成因＋一句下一步；
  变异：把任一成因删掉 ⇒ 判据红。
- ★ **今天用"页参数不匹配"做的类比探针**（2026-09-20，macOS；页加密算法换不了，但 `cipher_page_size` 换得了）：
  · 用默认页大小打开一个 512 字节页的加密库 ⇒ 报错 **`file is not a database`**；
  · 用**错口令**打开同一个库 ⇒ **一字不差的同一句** `file is not a database`；
  · 另一种参数不匹配（页大小写对、但库是用默认页大小建的）⇒ 报错 **`database disk image is malformed`**。
  ⇒ 两条结论直接改进本节：**(a)** "口令错"与"页加密算法不同"在 SQLCipher 的报错层**完全不可区分**，
  所以只能**并列两种成因**（这正是本节要的形态，别无他法）；**(b)** 触发诊断的失败**不止
  `file is not a database` 一句** —— `database disk image is malformed` 同样要覆盖，否则会漏掉一半现场。
  （探针细节：512 页库**同一个连接内自读成立**、换连接用 512 再打开却报 malformed —— 那条不对称
  本 probe 没追根因，写在这里供 P3 实现时一并钉死。探针**未入库**，只在临时副本上跑过。）
- ⚠️ 诚实边界：**这条现在无法用真 P3 构建验证**（还没有 SM4 页加密构建）⇒ 本节只登记要求与判据形态，
  **不提前改用户可见文案**（否则会给一个当前不可能发生的成因发错误提示）。

**③ 回滚（比升级更容易被忽略）**

- **没开过库级加密**：直接装回旧版即可（明文库两边都能读）。
- **已经开了 SM4 页加密**：装回 AES 构建**打不开**该库 ⇒ 回滚说明必须要求**先在国密构建里关闭磁盘加密（转明文）**，
  或保留一份导出包。⇒ 发布说明里"一键回滚"那句话必须加限定：**回滚前先在国密构建里关加密**。

**④ 验收判据（登记为"待 P3"，四条）**

| # | 判据 | 形态 |
|---|---|---|
| 1 | **交叉打开必须失败** | 同一个明文库分别在 AES 构建与 SM4 构建里开启加密 ⇒ 两边 `PRAGMA cipher_*` 回显不同，且**互换构建打开必须失败**（明确"打不开"，**不是**"能开但读到乱码"） |
| 2 | **迁移往返数据一致** | 明文库 →（构建 X 加密）→（构建 Y 解密中转）→（构建 Y 加密）→ 逐行比对与原件一致；沿用 `convert_space_db` 既有判据的形态 |
| 3 | **错误可操作性** | §② 的文本三条齐备（含变异：删任一条 ⇒ 红） |
| 4 | **回滚可用** | 在国密构建里关加密之后，AES 构建能正常打开同一个库（§③） |

⇒ 这四条**都需要"国密页加密构建"作为对象**，因此**现在只登记、不勾选**；谁做 P3 谁把它们的真读数补进来。

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
| **数据面**：静置密文（库/附件）、同步载荷、导出包里的**附件** | ✅ **是** | 档 3 全链路 |
| 导出包里的**库文件** `shuyonote.db` | ❌ **明文**（导出/导入契约如此） | 导入端按明文读；且 SQLCipher 的在线备份要求目标同钥 ⇒ 真要「密文库包」得另设一层容器加密，本次不改（§1.1） |
| **传输层** | ⚠️ **数据面国密、传输层标准 TLS（路径 2，已定）** | 链路上的**载荷**是 SM4 密文；协议本身仍是 TLS 1.3。**交付说明必须照这句写**，不要含糊成"全链路国密" |
| **控制面 / 基础设施**：更新包签名（minisign/Ed25519）、插件索引签名 | ❌ **不是（已决定，见 §2）** | 不在甲方系统边界内；内网离线部署时自动更新本就不可用 |
| 内容寻址摘要（附件 SHA-256） | ❌ 保持 SHA-256（**有意为之**，§2） | 换 SM3 = 全库改名 + 同步标识失效 |

> 原则：**该是国密的地方做实，不是国密的地方写清** —— 交付说明里如实列出这张表，比含糊其辞经得起问。

### 5.4 「不做」的四项：为什么不做、要多久、什么情况下必须改判（2026-09-20 补）

> §5.3 那张表回答"**哪面是国密、哪面不是**"；本节回答"**为什么不去补齐它**"。
> 骨架是三条元理由，逐项的理由与触发条件都在表里。

**三条元理由**（先看这三条，逐项细节才不会被读成"怕麻烦"）：

1. **国密的价值主要是「合规口径被承认」，不是「更强」**。凡是落在**甲方系统边界之外**、
   或**交付形态根本用不上**的通道（内网离线部署的自动更新、社区共享的插件索引），花这笔钱买不到合规收益。
2. **真正的成本不在算法，而在「证书链 / 密钥管理 / 发布管线 / 共享格式 / 多平台验证」**——
   SM2/SM3/SM4 的实现到处都有，换算法是一行；把一条**已经通了的管线**换成 SM2，要重做的是它周边的全部设施，
   而且这些设施**要么与社区仓共享、要么依赖甲方的 CA**，成本不成比例地大。
3. **可辩护的边界比"全都国密"的口号有用**（§5.3 原话）：如实列出"哪面是、哪面不是、为什么"，
   比含糊成"全链路国密"经得起甲方追问；含糊一次的代价，是被追问时**我们**出人出时间解释。

| 不做的项 | 一句话是什么 | 为什么不做 | 现在做要多久 | **必须改判的触发条件** |
|---|---|---|---|---|
| **B 路**（给 provider 加 `algorithm` 参数） | 让**同一个库**同时支持 AES 页与 SM4 页（运行期可切） | 我们的产品形态是"国密版构建"，无兼容前提下**只有一种构建** ⇒ 这个能力**没人用**；而 patch 从 20 段涨到几十段，**每次 `libsqlite3-sys` 升级都要重做**（我们是给上游合并文件打补丁） | 3–5 人日 ＋ **长期维护税** | 现场**必须**同一安装包既读老 AES 页库、又写 SM4 页库（且无法离线迁移） |
| **国密 TLS**（TLCP / RFC 8998） | 让**协议本身**是国密（SM2 证书 ＋ SM4 套件） | ① 甲方侧**没有国密网关/密码机** ⇒ 最便宜的"把 TLS 交给现成网关"那条路**不存在**；② 数据面已端到端国密 ⇒ **链路上的内容本来就是 SM4 密文**，TLS 1.3 护的是元数据与凭据，强度不弱；③ 成本要**两端**（客户端 TLS 栈换 `rust-openssl`＋vendored Tongsuo，服务端也要换）＋ **SM2 证书链的签发与信任管理**，还会连带重做 Android 的 `rustls-platform-verifier`、iOS 自管 SM2 信任链 | **2–4 周**（含证书与联调；服务端不全在本仓） | 招标/测评文件**点名 TLCP 或 RFC 8998**；或客户明确「协议本身必须是国密」；或**密评**把传输层纳入范围 |
| **SM2 更新包 / 插件索引签名** | 把 minisign(Ed25519) 换成 SM2 | ① 更新通道**不在甲方系统边界内**，且**内网离线部署时自动更新本来就不可用**（为一条交付时用不上的通道做密码学改造 = 纯成本）；② 发布者私钥**都还没交接**（owner 待办）—— 在一条还没真正跑通的管线上换零件；③ 插件索引签名是**与社区仓共享的格式**，换算法要么双签、要么打断社区消费者 | 1–2 周 | 客户明确要求「更新包也必须国密签名」；或**信创渠道/密评**有硬性清单 |
| **SM3 内容寻址**（附件文件名 SHA-256 → SM3） | 摘要算法也换国密 | 换它 ＝ **全库附件改名 ＋ 同步标识全变 ＋ 一次全库重命名迁移**；而 SHA-256 是公开摘要算法，通常不在"密码合规"的审查重点内（§2 已记） | ≈1 周 ＋ **全库迁移风险** | 客户**点名**摘要算法也要国密，且接受一次全库迁移 |

**如果哪天必须补，建议的优先级**：**国密 TLS（被点名时）＞ SM2 更新签名（信创清单）＞ B 路（现场双算法）＞ SM3 寻址（成本最大）**——
前两项影响"链路/交付物本体"，第三项只影响"同一个包能不能读两种库"，第四项要动全部历史数据。

⚠️ **顺带一处更正（2026-09-20）**：§5.0/§5.2 里那句"provider 要调 **Tongsuo** 的 `EVP_sm4_cbc` / `HMAC(SM3)`"
在前置关系上说过头了 —— P3（页加密 SM4 ＋ 页 MAC SM3 ＋ 库 KDF SM3）需要的三个入口
**标准 OpenSSL ≥ 1.1.1 就有**（`EVP_sm4_cbc` / `EVP_sm3` / `PKCS5_PBKDF2_HMAC` with SM3）；
**Tongsuo 的不可替代性在国密 TLS（TLCP/RFC 8998）那条线上**，不在数据面。
⇒ 数据面：`OPENSSL_DIR` 指向任一支持 SM3/SM4 的 OpenSSL 即可；Tongsuo 是"合规与一致性上的选择"，
不是 P3 的硬前置。（本机只有 LibreSSL，**该事实未在本机实查**；一条命令可证：
`openssl list -cipher-algorithms | grep SM4-CBC` ＋ `openssl list -digest-algorithms | grep SM3`。）

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

- [x] **老数据可读（应用层密文 v0/v1）**（**单测层**）：`crypto-legacy-v0.json` 金标夹具 3 格（文本/撞头/二进制）＋
      `legacy_headerless_data_still_reads` ＋ `legacy_data_whose_first_two_bytes_look_like_the_header_still_reads`
      （P1 起对 **v1 与 v2** 两个版本号各验一遍）—— `cargo test --lib crypto::`
      ⚠️ **端到端那半没做**：用旧版**真的**生成一个加密库 ＋ 加密附件再拿新版打开，属真机验收。
- [ ] 新装用户：口令 → 加密 → 重启解锁 → 读写正常（**桌面真机**，不只看单测）
- [ ] 加密开关双向迁移（开→关、关→开）数据不丢
- [ ] **库级页加密换算法后「老数据可读」＝经迁移后可读**（P3）：升级/回滚/未迁移库的可操作错误
      按 §3.3 的四条判据验收（**都需要国密页加密构建**，现在只登记、不许勾）；
      ⚠️ 措辞口径：**不能**写成「换构建后老库照读」—— 页加密是库文件属性，跨算法必须迁移（§3.3 ①）
- [x] 附件 / 同步载荷**两条路径全覆盖**（**应用层 AEAD 层**）：`security::tests::national_crypto_covers_all_three_paths_…`
      ＋ `attachments::export_attachment_tests::encrypted_export_under_national_crypto_…`
      （**默认构建即国密**；旧行为那一半由 `--no-default-features` 保留作对照／回滚）
      ⚠️ 2026-09-20 更正：原写「三条路径：附件/导出包/同步载荷」。导出包里的**库文件是明文**
      （导出/导入契约），所以第三条只能算「导出包里的附件」，见 §1.1。
- [x] **E1（磁盘加密）下导出/备份不再硬失败、也不再静默少空间**（2026-09-20，F2）：
      `workspace_io` 导出走「同钥密文快照 → 就地解密 → 明文契约自检」；
      `backup` 抽出 `snapshot_spaces()` 返回 `(成功, skipped)` 并把 `skipped` 带回界面。
      回归锚点 3 条 ＋ **变异证明**（退回老行为各红一次），见 §0.2 F2 条
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
      ✅ **§0-C 全落**（2026-09-19 补）：状态字段 `EncryptionStatus.format/algorithm`；
      **空间元数据**记录本空间算法（`meta.workspaces.cipher_format` ＋ 幂等迁移 ＋ `space_format()`）；
      **同步载荷与附件**的版本**不解密就能读**（`crypto::peek_format`），并做**整批拒绝**与
      **附件拒绝**（见下）
- [x] **KDF 迭代有断言**：常量写死 ＋ 断言防止被改小（`kdf_rounds_are_the_pinned_value`）；
      压测记录在 §0.2（本机 ≈112 ms 解锁；**中端机数字是外推、非实测**，见 §0.2 的两条诚实标注）（§0-D）
- [x] **构建门禁断言实际加密后端**（§3 第 5 条）：`check-crypto-backend` 已落地（rust 组），
      按**产物**断言"实际后端 == 声明"；两个方向都实测过（产物 openssl＋声明 openssl ⇒ 绿；
      产物 CC＋声明 openssl ⇒ 红并附 `cargo clean -p libsqlite3-sys` 的修法）——
      ⚠️ 它同时钉住了那条坑：**只设 `OPENSSL_DIR` 不会换后端**（build.rs 没声明 `rerun-if-env-changed`）
- [x] **「macOS 默认要不要切掉 CommonCrypto」——已拍板（owner，2026-09-19）：不切。**
      维持"**默认包走 Apple CommonCrypto、国密版另发**"（＝ §0-E 的形态）。
      依据（三条都已取证）：① 换后端**可行且与既有库兼容**（Tongsuo 后端下 `security::` 14/14，
      含 CommonCrypto 写下的夹具仍可读写）；② 但今天翻默认**用户可见行为零变化**（页加密仍 AES、
      页 HMAC 仍 SHA512、库 KDF 仍 PBKDF2-SHA512），唯一实质收益是"给 P2/P3 铺路"；
      ③ 代价却是**发行链**（dylib 打包/`@rpath`/签名/公证：Tongsuo 那份 `libcrypto.3.dylib` 的
      install_name 实测是**绝对路径**，只在我这台机器上成立）＋ **全员构建前置**（每个 macOS 开发者
      与默认 CI 都要先有 Tongsuo）。
      ⇒ 国密版的正确形态＝**显式 `OPENSSL_DIR` ＋ `sm-library` fail-fast ＋ `check-crypto-backend` 严格模式**。
      **改判触发条件**（写死，免得靠回忆）：client 要求「**装机即国密**」、或重启**路径 3（TLCP/RFC 8998）**
      （那时 Tongsuo 反正要进构建）、或双 provider 维护成本被证明高于打包成本。

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
