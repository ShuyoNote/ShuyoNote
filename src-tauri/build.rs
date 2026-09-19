//! 构建脚本。
//!
//! 除了 `tauri_build::build()`，这里只做**一件事**：`sm-library` feature 打开时，
//! 强制要求构建者**显式指定加密后端**（`OPENSSL_DIR`），不许落在 Apple 的 CommonCrypto 默认上。
//!
//! ## 为什么需要这个"提前一步的失败"
//!
//! SQLCipher 的页加密后端是**编译期**决定的（`libsqlite3-sys/build.rs`）：
//!   · Apple 平台、没给 `OPENSSL_DIR` ⇒ `SQLCIPHER_CRYPTO_CC` ＋ `Security.framework`，而 **CommonCrypto 只有 AES**；
//!   · 显式给 `OPENSSL_DIR` ⇒ 链 `libcrypto`（**Tongsuo 才有 SM4/SM3**）。
//!
//! 而"没给 OPENSSL_DIR"这件事**不会报错**：它只是安静地编出一个**没有国密算法**的库。
//! ⇒ 库级国密版（`sm-library`）必须**要么显式给后端、要么当场失败**，不能有第三种结局。
//!
//! ⚠️ 配套的坑（实测，2026-09-19）：**只设 `OPENSSL_DIR` 也不会真的换后端** ——
//! `libsqlite3-sys` 的 build.rs 没有为它声明 `rerun-if-env-changed`，cargo 认为环境没变、
//! 构建脚本不重跑。所以下面这条报错里必须带 `cargo clean -p libsqlite3-sys`。
//! 事后核对交给门禁 `node scripts/check-crypto-backend.mjs`（**拿产物说话**，不看环境变量）。
//!
//! 为什么是 feature 而不是"无条件检查"：默认包**刻意**不背国密构建链的风险（方案 §0-E
//! "国密版另发"）⇒ 只有 `sm-library` 打开时才强制显式，默认构建行为**一点不变**。

fn main() {
    enforce_explicit_crypto_backend_for_sm_library();
    tauri_build::build()
}

fn enforce_explicit_crypto_backend_for_sm_library() {
    // `CARGO_FEATURE_*` 由 cargo 按启用的 feature 注入（feature 名大写、`-` → `_`）。
    if std::env::var_os("CARGO_FEATURE_SM_LIBRARY").is_none() {
        return;
    }
    if std::env::var_os("OPENSSL_DIR").is_some() {
        return;
    }
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    panic!(
        "启用了 `sm-library`（库级国密：SQLCipher 的页加密 / 页 HMAC / 库 KDF），但**没有显式指定加密后端**。\n\
         \n\
         目标平台 = {target_os}。而 SQLCipher 的后端是**编译期**定的：\n\
         · Apple（darwin）不给 OPENSSL_DIR ⇒ 编成 CommonCrypto（`SQLCIPHER_CRYPTO_CC`），**它只有 AES** ——\n\
           也就是说这个构建**根本不含国密算法**，而且它**不会报错**，只会安静地产出一个没有 SM4 的库；\n\
         · 其它平台不给 ⇒ 链系统 OpenSSL（**编得过，但不是我们 pin 的那份 Tongsuo**）。\n\
         \n\
         修法（以 macOS 为例，Tongsuo 装在哪由你定）：\n\
           1) 编一份 Tongsuo（Gitee 镜像；实测 commit 540603a3 / 底层 OpenSSL 3.5.4）：\n\
              ./Configure --prefix=<p> no-tests && make -j8 && make install_sw    # ⚠️ macOS 装到 <p>/lib\n\
           2) ⚠️ **先清掉 libsqlite3-sys 的构建产物**（它的 build.rs 没为 OPENSSL_DIR 声明\n\
              rerun-if-env-changed ⇒ 只设环境变量时 cargo 不会重跑构建脚本，后端会**悄悄保持原样**）：\n\
              cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml\n\
           3) 带着环境变量重新构建：\n\
              OPENSSL_DIR=<p> cargo build --features sm-library --manifest-path src-tauri/Cargo.toml\n\
           4) 事后核对（**拿产物说话**）：node scripts/check-crypto-backend.mjs\n\
         \n\
         （详见 docs/SM-CRYPTO-DELIVERY.md §六 与 docs/development.md「工具坑」第 5 条。）"
    );
}
