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
    require_gm_provider_patch();
    tauri_build::build()
}

// 与 crate 共用同一份"哪份源码 / 有没有标记"的解析逻辑（判据在 crate 里驱动它，见 `gm_patch_probe.rs`）。
// ⚠️ 必须**裹一层 `mod`**：被 include 的文件头上有 `#![allow(dead_code)]`（内层属性），
//    直接 include 到根上会报 "an inner attribute is not permitted in this context"。
mod gm_patch_probe {
    include!("src/gm_patch_probe.rs");
}
use gm_patch_probe::{find_marker, lock_version, pick_source_dir, registry_src_roots, SourcePick};

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

/// P2/P3 的第二格：**补丁到底 apply 了没有**（`sm-library` 构建时强制检查）。
///
/// ## 三段闭合（2026-09-19 与 macOS 侧分工）
/// ① 后端是谁 —— `scripts/check-crypto-backend.mjs`（拿产物说话）；
/// ② **补丁在不在** —— 本函数：检查 cargo 将要编译的那份 SQLCipher 源码里有没有 §3.1 的 SM3 标签；
/// ③ 真的生效没有 —— `src-tauri/src/gm_provider.rs` 的运行期判据（回显必须是 `HMAC_SM3`）。
///
/// ## 为什么必须在"编译前"就吵（而不是等运行期）
/// 实测（见 `gm_provider.rs` 文件头那张表）：SQLCipher **不校验**这两个标签 ——
/// 设了 `HMAC_SM3` 它不报错、回显仍是 `HMAC_SHA512`、盘上写的仍是 SHA512 那套。
/// ⇒ 一个"没有补丁的国密构建"会是一个**安静地没有国密**的库。这一格就是那句"要么有、要么当场失败"。
///
/// ## 为什么标记检查要看**将要被编译的那份源码**，而不是读一个环境变量
/// 环境变量只能证明"有人设了个值"，证明不了"编进去的东西变了" —— 这正是 macOS 侧踩过的那个坑
/// （只设 `OPENSSL_DIR` 而不 `cargo clean -p` ⇒ 后端悄悄保持原样）。所以这里检查**源码文件本身**。
fn require_gm_provider_patch() {
    if std::env::var_os("CARGO_FEATURE_SM_LIBRARY").is_none() {
        return;
    }

    // 外置（预编译）SQLCipher 这条路**还没有可核对的口子** ⇒ 明确拒绝，不拿环境变量冒充事实。
    if std::env::var_os("SQLCIPHER_INCLUDE_DIR").is_some() || std::env::var_os("SQLCIPHER_LIB_DIR").is_some() {
        panic!(
            "`sm-library` ＋ 外置 SQLCipher（`SQLCIPHER_INCLUDE_DIR`/`SQLCIPHER_LIB_DIR`）这条路**还没有核对补丁的口子**。\n\
             本脚本只认「cargo 将要编译的那份源码里有 SM3 标签」这一种事实；对预编译产物我无法在这里核对，\n\
             而**用一个环境变量声明来冒充事实**正是我们这一路反复吃亏的形态（只设 OPENSSL_DIR 那次）。\n\
             ⇒ 走 registry 源码 ＋ patches/（见 patches/README.md）那条路；要用外置产物，先把「补丁版本」做成\n\
             可以**从产物里读出来**的东西（例如 include 目录里的 `sm3_provider_version.h`），再扩这一格。"
        );
    }

    // ★ 版本取法的**可信度顺序**（macOS 侧 2026-09-19 用受控实验证明我第一版错了，见 `gm_patch_probe.rs` 头注）：
    //   `Cargo.lock` 的版本 ＞ 依赖构建产物里的 `cargo:include=` ＞ mtime（只配兜底、**永不单独判 ✓**）。
    let Some((dir, version, how)) = resolve_sqlcipher_source() else {
        panic!(
            "`sm-library`：**定位不到** cargo 将要编译的那份 SQLCipher 源码 —— 这一格无法核对 ⇒ **当场失败**，\n\
             而不是安静地编出一个没有国密的库。\n\
             \n\
             取法顺序：① `src-tauri/Cargo.lock` 里 `libsqlite3-sys` 的版本 → 对应 registry 目录；\n\
                       ② 依赖构建产物 `target/**/build/libsqlite3-sys-*/output` 里的 `cargo:include=`。\n\
             ⚠️ **不按 mtime 挑**：陈旧副本的 mtime 可能更新，那会挑到**另一个版本**（假阴性：补丁明明打了却报「没有」；\n\
                假阳性：只在陈旧副本里注入标记也能让构建打出「补丁已应用」）。详见 `src/gm_patch_probe.rs` 头注。"
        );
    };

    match find_marker(&dir) {
        Some(hit) => {
            // 产物标记：macOS 侧的 `check-crypto-backend` 据此把"后端对不对"扩到"**补丁在不在**"。
            // 一行、可 grep、带版本与目标平台 + **取法**（评审时能看出它凭什么认为这是那份源码）。
            let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
            println!(
                "cargo:warning=shuyonote: sm3/sm4 provider patch applied (patch=v1 target={target_os} \
                 libsqlite3-sys={version} via={how} marker={hit})"
            );
            // 补丁文件不被任何 rerun-if-changed 覆盖 ⇒ 这里显式盯住源码与 patches/ 目录，
            // 免得"改了补丁、cargo 不重编"（比 OPENSSL_DIR 那个坑更隐蔽：连设环境变量这个动作都没有）。
            println!("cargo:rerun-if-changed={}", dir.display());
            if let Ok(root) = std::env::var("CARGO_MANIFEST_DIR") {
                let patches = std::path::Path::new(&root).join("..").join("patches");
                println!("cargo:rerun-if-changed={}", patches.display());
            }
        }
        None => panic!(
            "启用了 `sm-library`，但**找不到 §3.1 的 SM3/SM4 provider 补丁** —— 这个构建里 SQLCipher 不认\n\
             `HMAC_SM3` / `PBKDF2_HMAC_SM3` 两个标签，而它**不会报错**：实测回显仍是 `HMAC_SHA512`、\n\
             盘上写的仍是 SHA512 那套（见 src-tauri/src/gm_provider.rs 文件头那张表）。\n\
             \n\
             查的是（cargo 将要编译的那份源码，libsqlite3-sys={version}，取法={how}）：\n  {}\n\
             找的标记：`SQLCIPHER_HMAC_SM3_LABEL`（方案 §3.1 的新增标签）。\n\
             \n\
             修法：\n\
              1) 打补丁：patches/0001-sqlcipher-sm3-provider.patch（见 patches/README.md）\n\
              2) ⚠️ **补丁文件不被任何 rerun-if-changed 覆盖** ⇒ 必须清库重建：\n\
                 cargo clean -p libsqlite3-sys --manifest-path src-tauri/Cargo.toml\n\
              3) 带环境变量重建：OPENSSL_DIR=<Tongsuo> cargo build --features sm-library\n\
                 （或直接用胶水：node scripts/sm-library-build.mjs）\n\
             \n\
             三格核对：check-crypto-backend（后端是谁）→ 本脚本打的标记（补丁在不在）→ gm_provider（真的生效没有）。",
            dir.display()
        ),
    }
}

/// 定位"将要编译的那份 SQLCipher 源码"，并把**取法**一并返回（写进产物标记，评审时可见）。
///
/// 顺序（可信度从高到低）：
///   1. **`Cargo.lock` 的版本** —— 仓里、可复核、就是"cargo 将要解析成什么"的权威；
///   2. **依赖构建产物** `cargo:include=…/libsqlite3-sys-<版本>/sqlcipher` —— 真正被编译的那份的自我陈述
///      （与 1 比对：不一致就**报错**，不挑一个继续）；
///   3. 都没有 ⇒ `None`（调用方当场失败）。
fn resolve_sqlcipher_source() -> Option<(std::path::PathBuf, String, &'static str)> {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let manifest = std::path::Path::new(&manifest);
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".cargo")))?;
    let roots = registry_src_roots(&cargo_home);

    // ① Cargo.lock
    let lock = std::fs::read_to_string(manifest.parent()?.join("Cargo.lock")).ok()?;
    let wanted = lock_version(&lock);
    let pick = pick_source_dir(&roots, wanted.as_deref());

    // ② 与依赖构建产物交叉核对（有产物时）
    let from_output = include_hint_from_build_output(manifest);
    if let SourcePick::Found { dir, version } = &pick {
        if let Some((hint_dir, hint_ver)) = &from_output {
            if hint_ver != version {
                panic!(
                    "`sm-library`：`Cargo.lock` 说 libsqlite3-sys={version}，但依赖的构建产物说 {hint_ver}\n\
                     （产物里的 cargo:include={}）⇒ **不挑一个继续**：这两者不一致说明有东西没重编/被改过，\n\
                     此时「检查哪份源码」本身就是不确定的。修法：`cargo clean -p libsqlite3-sys` 后重建。",
                    hint_dir.display()
                );
            }
        }
        return Some((dir.clone(), version.clone(), "cargo.lock"));
    }

    // 锁版本拿不到或不匹配时，退到产物那条（它同样可信，且是"真正被编译"的自我陈述）
    if let Some((dir, ver)) = from_output {
        return Some((dir, ver, "build-output"));
    }
    None
}

/// 从依赖构建产物里读 `cargo:include=…/libsqlite3-sys-<版本>/sqlcipher`。
///
/// ⚠️ 与 macOS 侧那条纪律一致：**按平台过滤**（同一 target 目录里可能躺着别的平台的产物）。
fn include_hint_from_build_output(manifest: &std::path::Path) -> Option<(std::path::PathBuf, String)> {
    let target = manifest.join("target");
    let host_is_windows = cfg!(windows);
    for profile in ["debug", "release"] {
        let build = target.join(profile).join("build");
        let Ok(entries) = std::fs::read_dir(&build) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("libsqlite3-sys-") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path().join("output")) else { continue };
            for line in text.lines() {
                let Some(rest) = line.strip_prefix("cargo:include=") else { continue };
                // 另一个平台的产物会带盘符/反斜杠（Windows）或 `/`（unix）——按当前平台粗筛
                let looks_windows = rest.contains('\\') || rest.contains(":\\");
                if looks_windows != host_is_windows {
                    continue;
                }
                let p = std::path::Path::new(rest);
                // `…/libsqlite3-sys-<版本>/sqlcipher` 或 `…/libsqlite3-sys-<版本>` 都要能认
                let (dir, ver) = if p.file_name().map(|f| f == "sqlcipher").unwrap_or(false) {
                    (p.to_path_buf(), p.parent()?.file_name()?.to_string_lossy().to_string())
                } else {
                    (p.join("sqlcipher"), p.file_name()?.to_string_lossy().to_string())
                };
                let version = ver.strip_prefix("libsqlite3-sys-").unwrap_or(&ver).to_string();
                if dir.is_dir() {
                    return Some((dir, version));
                }
            }
        }
    }
    None
}

/// cargo 将要编译的那份 SQLCipher 源码目录。
///
/// ⚠️ **已废弃（2026-09-19）**：这一版按 mtime 最新挑版本，macOS 侧用受控实验证明它会挑到**陈旧副本**
/// （0.30.1 的 mtime 比 0.38.2 新），造成假阴性 **与** 假阳性。取法已改为
/// `resolve_sqlcipher_source()`（`Cargo.lock` 版本优先 ＋ 构建产物交叉核对），本函数保留仅为留痕。
#[allow(dead_code)]
fn sqlcipher_source_dir_deprecated_mtime() -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    if let Some(p) = std::env::var_os("SHUYONOTE_SQLCIPHER_SRC_DIR") {
        let p = PathBuf::from(p);
        return if p.is_dir() { Some(p) } else { None };
    }

    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let vendored = Path::new(&manifest).join("vendor").join("sqlcipher");
        if vendored.is_dir() {
            return Some(vendored);
        }
    }

    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;
    let src_root = cargo_home.join("registry").join("src");
    let registries = std::fs::read_dir(&src_root).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for reg in registries.flatten() {
        let Ok(pkgs) = std::fs::read_dir(reg.path()) else { continue };
        for pkg in pkgs.flatten() {
            let name = pkg.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("libsqlite3-sys-") {
                continue;
            }
            let dir = pkg.path().join("sqlcipher");
            if !dir.is_dir() {
                continue;
            }
            // 多个版本时取最新那个（mtime）——与"将被编译的那份"最可能一致
            let m = std::fs::metadata(&dir).and_then(|md| md.modified()).ok();
            if let Some(m) = m {
                if best.as_ref().map(|(bm, _)| m > *bm).unwrap_or(true) {
                    best = Some((m, dir));
                }
            }
        }
    }
    best.map(|(_, d)| d)
}

/// 在源码目录里找 SM3 标签标记（返回命中的文件名）。
///
/// ⚠️ 实现已搬到 `src/gm_patch_probe.rs`（`include!` 进来的那份），这样**判据能直接驱动它**。
#[allow(dead_code)]
fn find_gm_marker_deprecated(dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        let is_c = p
            .extension()
            .map(|x| x == "c" || x == "h")
            .unwrap_or(false);
        if !is_c {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            if text.contains("SQLCIPHER_HMAC_SM3_LABEL") {
                return Some(p.file_name().unwrap_or_default().to_string_lossy().to_string());
            }
        }
    }
    None
}
