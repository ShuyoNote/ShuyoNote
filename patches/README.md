# `patches/` —— 我们对第三方源码的补丁

## 这里放什么

| 文件 | 内容 | 状态 |
|---|---|---|
| `0001-sqlcipher-sm3-provider.patch` | 给 **SQLCipher** 加国密两格：`cipher_hmac_algorithm = HMAC_SM3`、`cipher_kdf_algorithm = PBKDF2_HMAC_SM3`（方案 §3.1 那张表：枚举 ＋ 回显分支 ＋ OpenSSL provider 的 `hmac`/`kdf`/`get_hmac_sz` 回调 ＋ **一道能力门**） | **已写**（2026-09-20，20 段改动 / 213 行 diff；生成器 `patches/tools/make-sm3-provider-patch.mjs`） |

## 怎么用（应用与读法都固定下来）

```bash
node scripts/sm-library-build.mjs --openssl-dir <Tongsuo 前缀>   # 幂等打补丁 → 清 libsqlite3-sys/本 crate → 构建
node scripts/sm-library-build.mjs --print-source-sha256           # 打印"将要编译的那份源码"的哈希（**打完补丁后**那份）
node scripts/sm-library-build.mjs --openssl-dir <p> --check       # 只核对，不构建
node scripts/sm-library-build.mjs --revert                        # 删掉**私有副本**（.gm-build/）；共享 registry 本来就没被碰过
node scripts/sm-library-build.mjs --print-env                      # 打印 OPENSSL_*/CARGO_HOME 行（CI 写进 $GITHUB_ENV）
```

> ★ **2026-09-23 起：补丁不再接触全机共享的 registry 源码** —— 它只打在
> `<repo>/.gm-build/libsqlite3-sys-<ver>/sqlcipher/`（**私有副本**）上，cargo 由**私有 `CARGO_HOME`**
> （`config.toml` 里的 `[patch.crates-io]`）指过去 ⇒ 「跑完忘了还原、默认构建被静默改成 SM4 页」那一类
> 状态**不可能发生**（不是"被发现"，是不存在）。`--revert` 就是删那个目录。见 `sm-library-isolate.mjs`。
> 判据：`scripts/lib/sm-library-isolate.test.mjs`（核心一条：跑完隔离，共享那份**逐字未变**）。

- 应用者只有一个：`scripts/sm-library-build.mjs`（`git apply -p1`，失败退 `patch -p1`），三态如实报
  `already / applied / absent`；**打完会复扫标记**（"退出码 0" ≠ "文件里有那行"）。胶水自己的判据见
  `scripts/lib/sm-library-patch.test.mjs`（9 条：应用/幂等/`--no-apply`/打不上/复扫标记 ＋ 撤回/往返 —
  其中一条是**逐字节**断言，钉住"`git apply` 不许改行尾"）。
- 补丁**不手写**：`patches/tools/make-sm3-provider-patch.mjs` 用 20 段锚点替换生成，每段断言"锚点恰好出现一次"
  ⇒ SQLCipher 升级时它**当场失败**，而不是生成一份看着像补丁的废纸。
- 补丁对应 **libsqlite3-sys 0.38.2 的 SQLCipher 合并文件**（`sqlite3.c` 9.6 MB；方案 §3.1 记的行号
  L109358 / L112304 / L113961 / L114074 与它能对上）。
- **补丁的身份**（跨机核对"我们打的是同一份"）：
  `patches/0001-sqlcipher-sm3-provider.patch` sha256 =
  `337aac607727f038ade42de2dc0ac1ae47831a859d3897ab22ba7c08a576fc6f`（12,330 字节，**LF**）。
  ⚠️ **v1 → v2**（2026-09-20）：v1 的 sha256 是 `2515fa19…`（12,021 字节）；v2 修了能力门探测错常量那条 bug
  （见下面第三条实测）⇒ **两台机器上的 `src_sha256` 都换了新值**（v1 是 `150bc1ee…`，v2 见构建产物那行）。
  行尾可比是因为 `.gitattributes` 是 `* text=auto eol=lf` ⇒ 三平台检出的都是 LF
  （否则 Windows 上检出成 CRLF，`git apply` 的上下文行就对不上了 —— 这条我们专门查过一次）。
- **能力门（本补丁的关键一处）**：`sqlcipher_codec_ctx_set_hmac_algorithm` / `set_kdf_algorithm` 里加一句
  "当前 provider 算不了这个算法就**不落值**"（探测口是 `get_hmac_sz()`，它对不支持的算法返回 0）。
  没有它，光加标签的话，在 CommonCrypto / libtomcrypt 后端上 `PRAGMA cipher_hmac_algorithm = HMAC_SM3`
  也会**被接受**——回显 SM3、实际算别的（或 `hmac_sz=0` 把保留区算错）。
  ⚠️ **探测的必须是"这次要设的那个算法"，不是 SM3 常量**（v1 就是这么写错的，见下面第三条实测）。
  改对之后，对既有三种算法**零行为变化**。

⚠️ **实测（2026-09-20，mac 在 macOS 上抓出、AMD 在 Linux 上受控复现）：v1 的能力门曾把「默认库」弄坏 ——
根因是"探测错了常量"，不是"补丁不该留在共享 registry 上"。**

- **现象**（macOS，Apple ⇒ CommonCrypto）：`security::` **7 passed / 12 failed**、`gm_provider` 2 passed / 7 failed，
  现场 `PRAGMA key = "x'<hex>'"` 报 `requires a key of one or more characters` ⇒ **加密库直接打不开**；
  把源码还原成原版后同一条命令 **19 passed / 0 failed**。
- **根因**：`sqlcipher_codec_ctx_set_kdf_algorithm` 里的能力门**写死探测 SM3 常量** ⇒ 在没有 SM3 的 provider 上
  **连默认的 PBKDF2-HMAC-SHA512 都被拒** ⇒ `ctx_init` 失败 ⇒ `PRAGMA key` 不认那把 key。
- **AMD 的受控复现**（不需要 macOS：把 OpenSSL provider 的 `get_hmac_sz(SM3)` 改成返回 0 = "provider 在场但没有 SM3"）：

  | 用例 | registry 源码 | provider | `security::` | `gm_provider::`（含 ignored） |
  |---|---|---|---|---|
  | v1 + CCSIM | v1 补丁 | 没有 SM3 | **7 passed / 12 failed** | 3 passed / **10 failed** |
  | v2 + CCSIM | v2 补丁（探测 `algorithm`） | 没有 SM3 | **19 passed / 0 failed** | 12 passed / 1 failed（那一 1 条是生成器**按设计拒绝**） |
  | v2（交付状态） | v2 补丁 | 有 SM3（Tongsuo） | 19 passed / 0 failed | **13 passed / 0 failed** |

  （v1 那一行与 mac 在 macOS 上的数字**逐条相同** —— 两台机器、两条独立的 provider 路径、同一个根因。）
- ⇒ 两条结论：① 能力门必须探测"**本次请求的算法**"；② 补丁留在共享 registry 上**本身是行为中性**的（v2 之后），
  但"能一键回到原版"仍然要有 —— `node scripts/sm-library-build.mjs --revert`。

⚠️ **顺带一条同族的（2026-09-20，被本仓自己的判据抓到）**：Windows 上 `core.autocrlf=true` 时，
`git apply` 会把**输出**整体写成 CRLF ⇒ 同一份源码在三平台**哈希不同**（`src_sha256` 的跨机比对失效）、
之后的 `git apply -R` 上下文行也对不上。⇒ 胶水已钉成 `git -c core.autocrlf=false apply`，
并加了一条**逐字节**判据（`scripts/lib/sm-library-patch.test.mjs`）守着它。

⚠️ **实测（2026-09-20，WSL/Tongsuo 第一轮）：产物标记 ≠ "编出来了"。** 那一轮 `libsqlite3-sys` **编译失败**
（生成器漏抄了 `#define SQLCIPHER_HMAC_SHA512` 那两行原样上下文），而本 crate 的构建脚本照样打出了
`cargo:warning=… patch applied …` —— 因为那一格判的是"**源码里有没有标记**"，不是"SQLCipher 编没编过"。
⇒ 读法：`② 补丁在不在` 只证"源码那一份是对的"；**"国密版真的编出来了"要由构建退出码 ＋ `① 后端是谁` ＋ `③ 真的生效没有` 一起回答**。

⚠️ **P3（SM4 页加密）不是"顺手加一个分支"**（2026-09-20 实测源码结构）：`sqlcipher_provider` 的 `cipher` 回调
签名是 `(ctx, mode, key, key_sz, iv, in, in_sz, out)` —— **没有 algorithm 参数**；页加密算法由
`#define OPENSSL_CIPHER EVP_aes_256_cbc()` 在**编译期**钉死；而本版 SQLCipher **没有** `cipher_algorithm` PRAGMA
（`cipher_settings` 也只回显 hmac/kdf 两张表）。⇒ 上 SM4 页加密要么走**编译期切换**（`#ifdef` 换
`EVP_sm4_cbc()`，宏经 `CFLAGS` 传进去），要么给 provider 结构体**加 algorithm 参数并打通 codec 层**（更贵、
更远离上游）。这比方案 §3.1 第 4 项那句"同一文件同一结构体"要重，**P3 排期要按它重估**。

补丁对象 = **`libsqlite3-sys` 将要编译的那份 SQLCipher 源码**（默认在 cargo registry：
`~/.cargo/registry/src/*/libsqlite3-sys-<版本>/sqlcipher/`）。

⚠️ **"哪份"是算出来的，不是猜出来的**（2026-09-19 macOS 侧用受控实验抓到我第一版错了）：
取法是 **① `src-tauri/Cargo.lock` 里锁的版本**（权威、在仓里、可复核）→ ② 依赖构建产物
`target/**/build/libsqlite3-sys-*/output` 里的 `cargo:include=` 交叉核对（按平台过滤）→
**③ mtime 永不单独判 ✓**。按 mtime "最新胜出"会挑到**陈旧副本**（他那台：0.30.1 的 mtime 比 0.38.2 新）：

- **假阴性**：补丁正确打在 0.38.2 上 ⇒ 检查去看 0.30.1 ⇒ 报"没有标记" ⇒ 构建被拒；
- **假阳性**：只往 0.30.1 注入标记 ⇒ 构建通过并打出"补丁已应用"，而将被编译的那份**一个字没改**。

同一份规则有**两处实现**，都由判据守着：`src-tauri/src/gm_patch_probe.rs`（`build.rs` 用 `include!`，
crate 里跑判据；含"陈旧副本 mtime 更新也要挑锁定版本"的回归判据）＋ `scripts/sm-library-build.mjs`。

⚠️ **实测（2026-09-19）：那一版是"合并文件"形态** —— 目录里只有
`sqlite3.c`（9.6 MB）/ `sqlite3.h` / `sqlite3ext.h` / `LICENSE` / `bindgen_bundled_version.rs`，
**没有**单独的 `crypto_openssl.c` ⇒ **补丁打在 `sqlite3.c` 里**（方案 §3.1 那些行号 L109365 / L113961
也正是这份合并文件的行号，能对上）。`src-tauri/build.rs` 会去**那份源码里**找标记
`SQLCIPHER_HMAC_SM3_LABEL`，找不到就**当场失败**（`sm-library` 构建）。

## 两条必须一起做的配套（都踩过，别省）

1. **改了补丁必须清库重建。** 补丁文件不被 `libsqlite3-sys` 的任何 `rerun-if-changed` 覆盖 ⇒
   cargo 认为"什么都没变"，**改了补丁不重编**。这比 `OPENSSL_DIR` 那个坑更隐蔽：连"设环境变量"这个动作都没有。
   ⇒ 固定动作：
   ```
   cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml
   ```
   （`scripts/sm-library-build.mjs` 已经把这一步固化进去了。）

   ⚠️ **第二条同族的坑（2026-09-19 在两侧读数时踩到）**：构建脚本**不重跑**时，cargo 会把
   **上一次的 `cargo:warning` 输出从缓存里重放**出来 —— 于是"没有补丁的构建"也会打出"补丁已应用"那行，
   看起来像通过。⇒ 要拿构建期那一格的**可信读数**，先 `cargo clean -p shuyonote`（清掉本 crate 的构建脚本输出）。

2. **产物要留一个可断言的口子。** 光看 `cargo:rustc-link-lib` 只能回答"OpenSSL 还是 CommonCrypto"，
   回答不了"补丁 apply 上没有" ⇒ `build.rs` 在补丁存在时打一行
   `cargo:warning=shuyonote: sm3/sm4 provider patch applied (patch=<补丁文件 sha256 前 8 位> target=<os> libsqlite3-sys=<版本> via=<cargo.lock|产物兜底> marker=<file> src_sha256=<64hex>)`，
   `scripts/check-crypto-backend.mjs`（macOS 侧）据此把判据从"后端对不对"扩到"**补丁在不在**"。
   ⚠️ `patch=` 这一格 **2026-09-20 改过**（macOS 侧自查）：原来写死字面量 `patch=v1`，补丁升到 v2 之后
   它**不再标识任何补丁** ⇒ 现在由 `build.rs` **现算补丁文件的 sha256 前 8 位**（同一个补丁文件 ⇒ 同一个标签，
   跨机核对"我们打的是同一份吗"因此有**两根**柱子：`patch=` 与 `src_sha256=`，都不需要人来同步）。

⚠️ **版本对照表**（跨机核对的唯一一张表；看到 `src_sha256` 与手里记的不等，**先看是哪一版**，别急着判"过期标记"）：

| 版本 | 补丁 sha256（前 8） | `src_sha256`（打过补丁的源码） | 改了什么 |
|---|---|---|---|
| v1 | `2515fa19` | `150bc1ee…` | P2 主体（SM3 HMAC/KDF ＋ 能力门） |
| v2 | `337aac60` | `6ec0a114…` | 修能力门**探测错常量**（macOS 抓出、我在 Linux 受控复现） |
| v3 | `040387ab` | `76e1a108…` | P3 快路：`OPENSSL_CIPHER` **无条件**换 `EVP_sm4_cbc()`（只改定义一处） |
| **v4** | **`72df3f9a`** | **`741d999b…`**（macOS 侧实测） | 默认值也设成 SM3（按 `#ifdef SQLCIPHER_CRYPTO_OPENSSL` 守卫）⇒ 裸钥不设任何 `cipher_*` 也回显 SM3 |

产物标记的形状也随 v4 多了一格（macOS 侧加的）：`patch=<前8> target=<os> **page_cipher=sm4** …`。

## 三格核对（缺一格就会出现"安静地没有国密"的库）

| 格 | 谁判 | 判什么 |
|---|---|---|
| ① 后端是谁 | `scripts/check-crypto-backend.mjs` | 编进去的是 OpenSSL/Tongsuo 还是 CommonCrypto（**拿产物说话**） |
| ② 补丁在不在 | `src-tauri/build.rs::require_gm_provider_patch` | 将要编译的那份源码里有没有 SM3 标签 ＋ 打产物标记 |
| ③ 真的生效没有 | `src-tauri/src/gm_provider.rs`（运行期判据） | 回显必须是 `HMAC_SM3`/`PBKDF2_HMAC_SM3`；并守「静默降级」那条（实测：不校验标签、回显不变、盘上仍是 SHA512） |
