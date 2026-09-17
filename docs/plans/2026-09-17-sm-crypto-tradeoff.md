# 国密方案 vs 原方案：利弊与跨平台影响（决策补充）

> 状态：**决策补充**（不改动落地设计、不触发代码改动）。
> 作用：给「换国密」这笔账一个可引用的对比——**利在哪、弊在哪、跨平台会不会破**。怎么落地看两份落地文档。
> 关联：[国密 + PDFium 决策文档](2026-09-16-sm-crypto-and-pdfium-plan.md) · [国密全链路落地方案](2026-09-16-sm-crypto-full-plan.md) · [PDFium 落地方案](2026-09-16-pdfium-engine-plan.md)

---

## 0. 一句话结论

国密的**收益几乎全在「合规准入」**（一张政企采购的门票），**代价全在「安全裕度 ＋ 长期维护」**。
算法本身不弱（SM3 / SM4 是公开标准、无已知实际弱点），但这次映射到的**具体替代品**里，有三处是实打实的降级（§2）。
**跨平台保得住**，真正会破的是**版本混部**与**空间库跨机器搬家**——两者都压在同一个前置上：**密文 / 算法版本化（P0）**。

---

## 1. 逐层对比（原方案 → 国密）

| 层 | 原来 | 换成 | 安全性 | 工程代价 |
|---|---|---|---|---|
| 口令派生 | **Argon2id**（内存硬化，`crypto.rs:40-46`） | PBKDF2-HMAC-SM3 | ⬇️ **降级**：国密**没有**内存硬化的对应物，抗 GPU/ASIC 差一档 | 低（要定迭代数 ＋ 压测解锁耗时 ＋ 补口令强度策略） |
| 应用层 AEAD | XChaCha20-Poly1305，**nonce 24B**（`crypto.rs:10,61`） | SM4-GCM（**nonce 12B**）或 SM4-CBC ＋ HMAC-SM3 | ↔️ 大致对等，但**管理更严**：12B 随机 nonce 撞了就是灾难，得写计数器 / 上限策略；SM4 密钥 **128 位** vs 现在 256 位 | 中（密文格式必变 ⇒ **先做版本化**） |
| 库级静置 | SQLCipher **AES-256-CBC** ＋ HMAC-SHA512（`security.rs:126-128`） | SM4-CBC ＋ HMAC-SM3（**新增 provider**） | ↔️ 对等；但页算法运行期**换不了** ⇒ 要自己养一份加密层 | ⬆️⬆️ **最贵**：3–5 人日 ＋ **长期**维护（每次升 SQLCipher 重放补丁） |
| 传输层 | TLS 1.3 | **已定（2026-09-17）：先做路径 2 —— 保持 TLS 1.3、数据面 SM4**；路径 3（**TLCP**（GB/T 38636-2020）或 **RFC 8998**（TLS 1.3 ＋ SM2 单证书））**暂缓** | 路径 2 不动 TLS 栈 ⇒ 无新增风险面；路径 3 若重启：TLCP 的框架是 TLS 1.1 时代的、**比 TLS 1.3 老一代**，**RFC 8998 则与 TLS 1.3 同代** | 路径 2 = **≈0**（原 1 人日 / 1–2 周）⇒ **P4 基本消失**；路径 3 重启时才 1–2 周，且**服务端也要换**（Tongsuo 版 Nginx） |
| 更新包签名 | minisign / Ed25519 | **不换**（已决定） | 不变 | 0 |
| 附件寻址 | SHA-256（`attachments.rs:291-292`） | **不换**（有意为之） | 不变 | 0（换 SM3 = 全库改名 ＋ 同步标识失效） |

---

## 2. 真弊（按严重度排）

1. **KDF 降级**——唯一「确定的」安全损失。内存硬化换成纯迭代，同样的解锁耗时下抗爆破更弱。
   缓解只有两条：迭代数压测到极限、口令强度下限提上去。
2. **自维护加密 provider 是长期责任**，不是一次性成本：密码实现的正确性、升级 SQLCipher 的重放补丁，会一直挂在身上。
3. **生态面窄**：出问题能帮的人少、可比对的审计资料少；构建链还带历史坑（Tongsuo 要 Perl ＋ Configure，
   本项目在 Android 上已因 Git-for-Windows 的精简 Perl 栽过一次，`Cargo.toml:108-109`）。
4. **口径翻车风险**：本次确认的是「用国密算法」。若甲方改口要「**通过认证的商用密码产品**」，自研 provider 全白做。
   ⚠️ 但 2026-09-17 核到一条**削弱该风险**的事实：Tongsuo 官方文档声明其「符合 **GM/T 0028**《密码模块安全技术要求》的
   『**软件密码模块安全一级**』资质」（[tongsuo.netlify.app/docs](https://tongsuo.netlify.app/docs/)）⇒ 底层库这一层**有可引用的资质**。
   但**我方新增的 provider 补丁不在该资质覆盖范围内**，仍需单独说明，不能替甲方下结论。
5. **性能要实测**：软件 SM4 没有 AES-NI 级别的硬件加速（x86 上 SM4 指令支持面窄），而它是**库页加密的热路径**。
   多半无感，但不能靠猜——P3 要带单页耗时对比。

## 3. 真利

1. **合规准入（唯一硬收益）**：等保 / 密评、政企采购的门槛条件。这一层不比较技术优劣——不做就拿不到单。
2. **叙事差异化**：静置 ＋ 外发都国密，Obsidian / 思源都没有；写进交付说明好看、好讲。
3. **构建链是复用不是新建**：Tongsuo 是 OpenSSL 分支，与现有 vendored-openssl **同源** ⇒ 不是多一条构建路径。
   这条把「弊 3」削掉一部分。
4. **许可面不变**：Tongsuo 为 **Apache-2.0**（上游仓库 `LICENSE.txt` 全文已核，见 §8），与 AGPL-3.0 兼容、**不引入新的 copyleft**。
   引入时仍需登记进 `THIRD-PARTY-NOTICES`。

---

## 4. 最该拿去谈的一点：档 2 vs 档 3

| | 档 2（外发数据国密） | 档 3（全链路，含库级静置） |
|---|---|---|
| 能对外说 | 「**外发数据**使用 SM4 加密」 | 「静置与外发**均**使用国密」 |
| 传输层 | 路径 2 **零额外开发**（载荷本身就是 SM4） | 同左（路径 3 要另加 1–2 周） |
| 估算 | **≈3–5 人日** | ≈8–13 人日（不含路径 3） |
| 风险 | 低 | **要自己养加密 provider** |

**档 3 的增量只有一句口径，代价却是最贵最险的那块。** 若甲方能接受档 2，省下 3–5 人日 ＋ 一份长期维护的加密层。
这是整份方案里性价比最高的一次谈判。

---

## 5. 跨平台影响

### 5.1 构建面：每个平台都要能编出 Tongsuo

| 目标 | 今天实际用哪套加密后端 | 换国密后 | 风险 |
|---|---|---|---|
| Windows (MSVC) | **OpenSSL**（vcpkg，`release.yml:81-88` 设 `OPENSSL_DIR`） | **自己编 Tongsuo**（MSVC ＋ **Perl**） | ⬆️ 高：Perl / Configure 是历史坑 |
| macOS (universal) | ⚠️ **CommonCrypto**（`-DSQLCIPHER_CRYPTO_CC` ＋ Security.framework）——**不是** OpenSSL | **必须先显式切到 Tongsuo/OpenSSL**，再编 x86_64 ＋ arm64 两个 slice 合并 | ⬆️⬆️ 高：见下方 ⚠️；另加公证签名要覆盖 |
| iOS | 同上（Apple 平台同一分支）——但 **iOS 整体未开始**（`MOBILE.md:35`、无 `ios.yml`） | 同 macOS；且要一并解决 Tauri iOS 工具链（`MOBILE.md` §5） | ⬆️⬆️ 高，且**不在当前交付范围** |
| Linux | 系统 OpenSSL（`-l crypto`） | 系统 Tongsuo 或自编 | 低 |
| Android | `bundled-sqlcipher-vendored-openssl`（NDK clang ＋ **Perl**，`Cargo.toml:110-111`） | 同一条路径换 Tongsuo | ⬆️ 高：已在精简 Perl 上栽过 |
| Web | **无静置加密**（`web.ts:2916`） | 不涉及 | — |

⚠️ **一个原方案没列到的坑：Apple 平台今天走的是 CommonCrypto，而它只有 AES。**

- `libsqlite3-sys` 的 `build.rs:246-249`：非 vendored 且 `host`/`target` 都是 Apple 时，编译期加
  **`-DSQLCIPHER_CRYPTO_CC`** 并链 `Security.framework` ＋ `CoreFoundation`；
- SQLCipher 的 CC 后端是硬编码 AES 的（`sqlite3.c:114266`：`CCCryptorCreate(op, kCCAlgorithmAES128, 0, key, kCCKeySizeAES256, …)`）
  ⇒ **CommonCrypto 没有 SM4，这个分支下根本编不进国密 provider**；
- 而**选哪条分支只看 `OPENSSL_DIR` 有没有设**（`find_openssl_dir()` 就只读这一个环境变量，`build.rs:350`）。
  `release.yml` 只给 Windows 设了它（注释写"mac/linux 系统自带"——**这句对 macOS 不成立**）
  ⇒ **今天 macOS 发布件实际跑在 CommonCrypto 上**，与 Windows/Linux 不是同一套页加密实现（同为 AES-256-CBC，
  所以数据今天仍互通，但**引入 SM4 后会变成静默的机器/平台差异**：一台编了 SM4 的库，另一台打不开）。

⇒ 结论：**国密落地必须"显式钉死后端"，不能靠自动挑选**；并要有一条门禁断言实际编进去的是哪个 provider
（否则"编过了"和"能开国密库"是两回事）。

关键事实：**桌面是 `features = ["bundled-sqlcipher"]`（自己挑后端），只有 Android 才是 `bundled-sqlcipher-vendored-openssl`**
（`Cargo.toml:25` vs `:111`）⇒ 换国密 = **四条构建链都要把加密后端换成 Tongsuo**，不是改一行依赖。

### 5.2 数据面：跨端要求「全端同时会 SM4」

| 面 | 跨平台影响 |
|---|---|
| **同步载荷** | 服务端只转发密文、**不用改**；但解密端必须会 SM4 ⇒ **不存在「部分设备升级」**。一台设备开了国密，同空间所有设备都得会 |
| **现在会不会静默坏** | 会。`EncryptionStatus` 只有 `enabled / locked`（`security.rs:473-476`），**协议里没有任何算法标识** ⇒ 老端只会当成「解不开」 |
| **本地库** | 平时各设备各自一份、不用跨机器读。**但「空间库搬家 / 导出」是自包含库文件**（`rebuild_space_db` 明确要求 fully self-contained、re-readable，`security.rs:144-189`）⇒ 搬到别的平台读，两边必须**同参数**（页算法 / 迭代 / HMAC / salt 头） |
| **导出包 / 附件** | 走应用层 AEAD，同一份 Rust 代码 ⇒ 跨平台格式天然一致 |
| **Web** | 本来就没有静置加密能力 ⇒ 加密包在 Web 打不开是**既有差异**，不是国密引入的 |

⚠️ **路径 3 是唯一会额外伤跨平台的**（TLCP 与 RFC 8998 两形态都一样）：它要换掉 TLS 栈（`rust-openssl`），于是 Android 上
`src/tls_android.rs` 那套 **`rustls-platform-verifier`（系统证书库，必须在首个 HTTPS 请求前初始化，`Cargo.toml:113-126`）要重做**，
服务端也要换成 Tongsuo 版 Nginx。**路径 2 完全不动 TLS ⇒ 对跨平台零影响**——这也是建议先走路径 2 的理由之一。
（补正：早先的说法是「路径 3 的协议基底老一代」——这只对 **TLCP** 成立；**RFC 8998 是 TLS 1.3 ＋ 国密单证书**，与 TLS 1.3 同代。）

✅ **路径 3 已暂缓（2026-09-17 定）⇒ 上面这一段今天不构成任何负担**：本次交付走路径 2（数据面国密 ＋ 传输层标准 TLS），
TLS 栈、Android 信任链、服务端 Tongsuo Nginx **一个都不用动**。真要重启路径 3 时，成本与前置见[落地方案 §5.2](2026-09-16-sm-crypto-full-plan.md)。

### 5.3 版本面：最容易踩的「不能跨」

1. ~~**国密版 ↔ 开源 / 社区版**：若国密只进商业版、不进主干，用户数据在两者之间**不通**~~
   ⇒ ✅ **已消除（2026-09-17 定：国密代码进开源主干，见 §7）**；
2. **老客户端**：1.91.x 不认识 SM4，混部时那台设备读不了；
3. ⇒ **P0 密文格式版本化不只是「防老数据打不开」，它也是跨平台 / 跨版本互通的唯一凭据。**

### 5.4 跨平台上的最小风险做法（四条）

1. **算法随空间记录**，不做全局开关：空间元数据里存 `cipher: v1 | sm`；
2. **老端遇到不认识的算法要「明确拒绝」**（同步带算法标识，不支持就拒收 ＋ 提示升级），而不是当成数据损坏；
3. **保留一段时间双读**：新端能读旧密文；旧端读不了新密文时给可理解的错误；
4. **国密默认关、按空间开**——这样 Mac 还没升级时，跨平台混部不会互相毁数据。

---

## 6. 四个对冲（不做就是真风险）

1. **版本化先行**（1 人日，与档位无关）：不先给密文带版本号，换算法后老数据**分不出新旧、无法双读**；
2. **fixture 回归**：用旧版生成的加密库 / 附件当固定样本，断言新版仍能打开——唯一防「把老用户数据锁死」的手段；
3. **Tongsuo 的构建要拆两半看**（2026-09-17 澄清，别读成"暂缓路径 3 就不用编 Tongsuo"）：
   - ⚠️ **把 Tongsuo 编出来（MSVC / Android NDK）＝ 仍在主线**，是 **P3 库级 provider 的硬前置**
     （要调它的 `EVP_sm4_cbc` / `HMAC(SM3)`）；第一关仍是 Perl ＋ Configure；
   - ✅ **用 Tongsuo 开一条 TLCP 连接**那半随路径 3 暂缓；其失败路径（退回路径 2）现在就是既定形态
     ⇒ 没有「必须成功」的压力。
4. **构建侧显式钉死加密后端**（2026-09-17 补）：Apple 平台默认编成 CommonCrypto（**只有 AES**，见 §5.1）
   ⇒ 必须显式把后端指向 Tongsuo，并加一条**门禁断言实际 provider**。
   不做这条，macOS 上会出现「构建通过、但打不开国密库」——而且**不同机器可能编出不同后端**，静默不互通。

## 7. 归属：**已定（2026-09-17）国密代码进开源主干**

不走「商业版专属分支」，国密实现与其它功能一样走 `feat/sm-crypto` → `dev` → `main`。

**为什么这条是对的：**

- CLA 已定稿（保留版权 ＋ 授予再许可权）⇒ 同一份代码既能出 AGPL 版、也能出闭源商业授权版，**不需要分叉**；
- 分叉的代价被 §5.3 那条硬约束放大：一旦分叉，两版用户的数据互不相通（算法不同，而协议里又没有算法标识）；
- 许可面干净：**Tongsuo 是 Apache-2.0**（OpenSSL 分支），与 AGPL-3.0 兼容，**不引入新的 copyleft**（登记进 `THIRD-PARTY-NOTICES` 即可）。

**但它同时把三条负担转到主干上，必须一起接受：**

| # | 含义 | 不处理的后果 |
|---|---|---|
| 1 | **主干 CI 要能编出国密路径** | 四条链（Windows MSVC / macOS universal / Linux / Android NDK）任一编不过，主干直接红 |
| 2 | **外部贡献者的构建前置变重** | 文档里要能一条命令装好 / 编好 Tongsuo，否则没人能验证国密改动 |
| 3 | **供应链要钉住** | Tongsuo 源码不能「下载即用」，要按 `fetch-pdfium.mjs` 的套路**钉版本 ＋ 校验和** |

### 7.1 连带引出的设计决定：**默认编** 还是 **feature 门控**？

| | **(a) feature 门控（`--features sm-crypto`）· 推荐** | (b) 默认编 |
|---|---|---|
| 主干 CI | 默认不编 Tongsuo ⇒ 不受四条链构建风险影响；**另开一条常开 job 专门编国密路径**（否则等于没覆盖） | 所有 job 都要先编出 Tongsuo |
| 开源用户构建前置 | **不变** | 变重：Windows 开发者要装 Perl ＋ 编 Tongsuo；Android 的 NDK Perl 坑人人踩 |
| 官方发布包 | GitHub 默认那份**不含国密**（国密版另发，或作为正式发布物之一） | 一份包全含 |
| 风险 | 国密路径的覆盖靠那条常开 job 自觉维持，容易失守 | 构建链一坏，所有平台的开发与发布全停 |

**推荐 (a)**：代码进主干、**构建可选、CI 常开一条国密 job**——既不把 Tongsuo 的构建风险强加给每个贡献者，
又不让它变成「没人编、所以坏了也没人知道」的死代码。

> **无论走哪条，默认算法仍是 v1（XChaCha20）**：国密**按空间可选**，不做全局默认——
> KDF 降级（§2 弊 1）不该强加给全体开源用户。
>
> **本条（feature 门控 vs 默认编）尚未拍板**，是动手前要定的最后一个前置。

---

## 8. 事实依据（都能核对）

| 结论 | 依据 |
|---|---|
| 密文现在没有版本号 | `src-tauri/src/crypto.rs:10,61-89`（裸 `nonce(24)‖ct`） |
| 协议里没有算法标识 | `src-tauri/src/security.rs:473-476`（`EncryptionStatus { enabled, locked }`） |
| 桌面 / Android 取 OpenSSL 的方式不同 | `src-tauri/Cargo.toml:25` / `:110-111` |
| 空间库是自包含、可搬移的库文件 | `src-tauri/src/security.rs:144-189`（`rebuild_space_db`） |
| Android 的 Perl 历史坑 | `src-tauri/Cargo.toml:108-109` |
| TLCP 会动到 Android 的 TLS 信任链 | `src-tauri/Cargo.toml:113-126` ＋ `src-tauri/src/tls_android.rs` |
| 附件寻址不换 SM3 | `src-tauri/src/attachments.rs:291-292` |
| Tongsuo 的能力面与资质口径 | [Tongsuo 官方文档·关于铜锁](https://tongsuo.netlify.app/docs/)：声明支持 **GB/T 38636-2020（TLCP）**与 **RFC 8998（TLS 1.3 ＋ SM2）**，并声明符合 **GM/T 0028** 的「软件密码模块安全一级」 |
| Tongsuo 的许可证 = **Apache-2.0** | 上游仓库根 **`LICENSE.txt`**（OpenSSL 3.x 系命名，故没有 `LICENSE`）全文即 Apache License 2.0，2026-09-17 经 jsDelivr 镜像取回逐条核对；对照 [GitHub 许可证页](https://github.com/Tongsuo-Project/Tongsuo?tab=Apache-2.0-1-ov-file) |
| **Apple 平台今天走 CommonCrypto（只有 AES）** | `libsqlite3-sys-0.38.2/build.rs:246-249`（Apple 分支加 `-DSQLCIPHER_CRYPTO_CC` ＋ `Security.framework`）；SQLCipher 的 CC 后端硬编码 AES（`sqlcipher/sqlite3.c:114266`）；选路只看 `OPENSSL_DIR`（`build.rs:350`），而 `release.yml:81-88` 只给 Windows 设它 |
| **iOS 未开始、没有 iOS 构建** | `docs/MOBILE.md:35`（iOS = 未开始）＋ 同文件 §5（那台 Mac 上 Tauri iOS 工具链结论）；`.github/workflows/` 只有 `android` / `ci` / `macos` / `pages` / `release` |
