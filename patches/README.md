# `patches/` —— 我们对第三方源码的补丁（**目前是空的，第一个补丁还没写**）

## 这里将要放什么

| 文件 | 内容 | 状态 |
|---|---|---|
| `0001-sqlcipher-sm3-provider.patch` | 给 **SQLCipher** 加国密两格：`cipher_hmac_algorithm = HMAC_SM3`、`cipher_kdf_algorithm = PBKDF2_HMAC_SM3`（方案 §3.1 那张表：枚举 ＋ 回显分支 ＋ `provider.h` 的 `hmac`/`kdf`/`cipher`/`get_hmac_sz` 回调） | **未写**（P2/P3 主体，AMD 认领） |

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
   `cargo:warning=shuyonote: sm3/sm4 provider patch applied (patch=v1 target=<os> marker=<file>)`，
   `scripts/check-crypto-backend.mjs`（macOS 侧）据此把判据从"后端对不对"扩到"**补丁在不在**"。

## 三格核对（缺一格就会出现"安静地没有国密"的库）

| 格 | 谁判 | 判什么 |
|---|---|---|
| ① 后端是谁 | `scripts/check-crypto-backend.mjs` | 编进去的是 OpenSSL/Tongsuo 还是 CommonCrypto（**拿产物说话**） |
| ② 补丁在不在 | `src-tauri/build.rs::require_gm_provider_patch` | 将要编译的那份源码里有没有 SM3 标签 ＋ 打产物标记 |
| ③ 真的生效没有 | `src-tauri/src/gm_provider.rs`（运行期判据） | 回显必须是 `HMAC_SM3`/`PBKDF2_HMAC_SM3`；并守「静默降级」那条（实测：不校验标签、回显不变、盘上仍是 SHA512） |
