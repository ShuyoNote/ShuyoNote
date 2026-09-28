// 「cargo 将要编译的那份 SQLCipher 源码在哪」——**单一实现，两处消费**：
//   · `src-tauri/build.rs`（`include!` 进来，构建期那一格用它）—— 那是**另一次编译**；
//   · 本 crate 的单元测试（判据直接驱动它）。
// 为什么要放成一个普通模块再 `include!`：这套解析逻辑**必须能被判据驱动**。
// 2026-09-19 macOS 侧用一个受控实验证明了我第一版是错的（见下），而那一版**没有任何判据**，
// 只能靠人拿真机器去踩。
//
// ★ **2026-09-25 清理**：在本 crate 里它**只有判据在用** ⇒ `lib.rs` 把它声明成 `#[cfg(test)] mod`
// （产品二进制里根本不存在），因此本文件里那 8 处逐项 `#[allow(dead_code)]` / `cfg_attr(…allow…)`
// **一次删掉**；只剩 `registry_src_roots` 那一条**跨编译边界的结构性收据**（理由写在它上方）。
// ⚠️ 别把它理解成"可以随便删这个文件" —— `build.rs` 的 `include!` 一直需要它，
// 而那个 `include!` 不看 `cfg(test)`（构建脚本里 `cfg(test)` 恒假）。
//
// ## 第一版错在哪（macOS 侧 `2026-09-19-gm-p1-application-layer.reply-9.md` §一）
// 我按「registry 里 mtime 最新的那个 `libsqlite3-sys-<版本>` 胜出」挑目录。他那台机器上
// **0.30.1 的目录 mtime 比 0.38.2 新**（陈旧副本），而本仓 `Cargo.lock` 锁的是 **0.38.2**、
// 真正被编译的也是 0.38.2。于是：
//   · 假阴性：补丁正确打在 0.38.2 上 ⇒ 我看 0.30.1 ⇒ 报"没有标记" ⇒ **构建被拒**；
//   · 假阳性（他演示的）：只往 **0.30.1** 注入标记 ⇒ 我的检查通过、构建还打出"补丁已应用"
//     ⇒ 而将被编译的那份源码里**一个字都没改**。
// ⇒ 取法的可信度顺序：**`Cargo.lock` 的版本**（权威、在仓里、可复核）＞ 依赖自己的构建产物
//   `cargo:include=…`（那是"真正被编译的那份"的自我陈述）＞ mtime（只配当兜底，且**永不单独判 ✓**）。
//
// 这里实现第一优先（`Cargo.lock`）；构建产物那条留作 `build.rs` 里的交叉核对（有产物时比对，
// 不一致就**报错**，而不是挑一个继续）。

use std::path::{Path, PathBuf};

/// 从 `Cargo.lock` 文本里读出 `libsqlite3-sys` 的版本。
///
/// 手写解析（不引 toml 依赖）：`Cargo.lock` 的形状是稳定的 `[[package]]` 块，
/// 每个块里 `name = "…"` + `version = "…"` 各一行。**只认第一个匹配的包**（本仓只有一个）。
pub fn lock_version(cargo_lock: &str) -> Option<String> {
    let mut in_pkg = false;
    let mut is_target = false;
    for raw in cargo_lock.lines() {
        let line = raw.trim();
        if line.starts_with("[[package]]") {
            in_pkg = true;
            is_target = false;
            continue;
        }
        if line.starts_with('[') {
            // 别的段（`[metadata]` 之类）—— 块结束
            in_pkg = false;
            is_target = false;
            continue;
        }
        if !in_pkg {
            continue;
        }
        if let Some(v) = line.strip_prefix("name = ") {
            is_target = v.trim().trim_matches('"') == "libsqlite3-sys";
            continue;
        }
        if is_target {
            if let Some(v) = line.strip_prefix("version = ") {
                return Some(v.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// 挑源码目录的结果。**"挑不到"与"挑到了但不是要的那个版本"必须分开** ——
/// 前者是环境问题，后者是"判据看的东西 ≠ 它声称看的东西"（正是那族事故）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourcePick {
    /// 命中：正是 `Cargo.lock` 锁的那个版本。
    Found { dir: PathBuf, version: String },
    /// registry 里有若干版本，但**没有**要的那个 ⇒ 绝不退而求其次。
    VersionMismatch { wanted: String, found: Vec<String> },
    /// 连版本都要不到（`Cargo.lock` 没这个包 / 解析不出）或 registry 里一个都没有。
    NotFound { wanted: Option<String>, found: Vec<String> },
}

/// 私有副本目录（`<repo>/.gm-build/libsqlite3-sys-<ver>/sqlcipher`）—— 2026-09-23「消灭补丁残留」那一格带来的新形态。
///
/// 背景：补丁不再打在**全机共享**的 registry 源码上，而是打在**私有副本**上，cargo 由私有 `CARGO_HOME`
/// （config.toml 里的 `[patch.crates-io]`）指过去。于是"将要编译的那份源码"有两种可能，必须**按证据选**：
///   · 隔离模式：进程环境里的 `CARGO_HOME` 指向 `<repo>/.gm-build/cargo-home`（调用方按 `--print-env` 导出的），
///     或依赖构建产物里的 `cargo:include=` 指向 `.gm-build/` ⇒ 编译的是**副本**；
///   · 老模式：都不是 ⇒ 编译的是 registry 那份（此时补丁必须打在它上面，否则当场失败）。
pub fn isolation_source_dir(repo_root: &Path, version: Option<&str>) -> Option<(PathBuf, String)> {
    let v = version?;
    let dir = repo_root.join(".gm-build").join(format!("libsqlite3-sys-{v}")).join("sqlcipher");
    if dir.is_dir() {
        Some((dir, v.to_string()))
    } else {
        None
    }
}

/// `CARGO_HOME` 是否指向我们的私有 `CARGO_HOME`（`<repo>/.gm-build/…`）。
pub fn cargo_home_is_isolated(cargo_home: &Path, repo_root: &Path) -> bool {
    cargo_home.starts_with(repo_root.join(".gm-build"))
}

/// 某个路径是否落在私有构建目录里（用于读依赖产物那条 `cargo:include=` 时判"cargo 编的是副本"）。
pub fn is_under_gm_build(dir: &Path, repo_root: &Path) -> bool {
    dir.starts_with(repo_root.join(".gm-build"))
}

/// 在若干 `registry/src/*` 根下找 `libsqlite3-sys-<version>/sqlcipher`。
///
/// ⚠️ `wanted` 为 `None`（拿不到锁版本）时**不猜**：返回 `NotFound`，由调用方带着说明失败。
pub fn pick_source_dir(registry_srcs: &[PathBuf], wanted: Option<&str>) -> SourcePick {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for src in registry_srcs {
        let Ok(entries) = std::fs::read_dir(src) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(ver) = name.strip_prefix("libsqlite3-sys-") else { continue };
            let dir = e.path().join("sqlcipher");
            if dir.is_dir() {
                found.push((ver.to_string(), dir));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let versions: Vec<String> = found.iter().map(|(v, _)| v.clone()).collect();

    let Some(wanted) = wanted else {
        return SourcePick::NotFound { wanted: None, found: versions };
    };
    match found.into_iter().find(|(v, _)| v == wanted) {
        Some((version, dir)) => SourcePick::Found { dir, version },
        None => SourcePick::VersionMismatch { wanted: wanted.to_string(), found: versions },
    }
}

/// 在源码目录里找 SM3 标签标记（返回命中的文件名）。
pub fn find_marker(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        let hit = p
            .extension()
            .map(|x| x == "c" || x == "h")
            .unwrap_or(false);
        if !hit {
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

/// 列出所有 `registry/src/*` 根（`$CARGO_HOME/registry/src` 下的每个 registry 目录）。
///
/// ⚠️ **2026-09-25 收据（本文件里唯一留下的一条）**：这一条是**本 crate 的判据不驱动**的 ——
/// 它真正的调用方是 `build.rs`，而那是**另一次编译**，所以在测试构建里它必然"没人用"。
/// 这不是"还没接线"，是**跨编译边界的结构性事实**，所以留无条件豁免而不是 `#[cfg(test)]`。
/// **它不会自己到期**：哪天 `build.rs` 不再需要"列出 registry 根"，就删函数本身，
/// 而不是把这一行留给下一个人（那正是这条豁免当初存在的坏处）。
#[allow(dead_code)]
pub fn registry_src_roots(cargo_home: &Path) -> Vec<PathBuf> {
    let base = cargo_home.join("registry").join("src");
    let Ok(entries) = std::fs::read_dir(&base) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份**形状真实**的 Cargo.lock 片段（含别的包，免得解析"恰好只认第一行"也能过）。
    const LOCK: &str = r#"
version = 4

[[package]]
name = "rusqlite"
version = "0.40.0"
dependencies = ["libsqlite3-sys"]

[[package]]
name = "libsqlite3-sys"
version = "0.38.2"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.200"

[metadata]
checksum = "abc"
"#;

    fn tmp_roots(tag: &str, versions: &[&str]) -> (PathBuf, Vec<PathBuf>) {
        let dir = std::env::temp_dir().join(format!(
            "shuy_gmprobe_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let reg = dir.join("registry-src-one");
        std::fs::create_dir_all(&reg).unwrap();
        for v in versions {
            let sc = reg.join(format!("libsqlite3-sys-{v}")).join("sqlcipher");
            std::fs::create_dir_all(&sc).unwrap();
            std::fs::write(sc.join("sqlite3.c"), "/* amalgamation */\n").unwrap();
        }
        (dir, vec![reg])
    }

    #[test]
    fn lock_version_reads_the_right_package() {
        assert_eq!(lock_version(LOCK).as_deref(), Some("0.38.2"));
        assert_eq!(lock_version("[[package]]\nname = \"serde\"\nversion = \"1\"\n"), None);
    }

    /// ★ 判据（这条就是 macOS 侧那个受控实验的回归）：**registry 里有个 mtime 更新的陈旧版本时，
    /// 仍然要挑 `Cargo.lock` 锁的那个版本。**
    ///
    /// 他当时的现场：`0.30.1/sqlcipher` 的目录 mtime(2026-09-07 18:01) **比** `0.38.2/sqlcipher`(14:33) 新
    /// ⇒ 旧实现挑 0.30.1 ⇒ 只往 0.30.1 注入标记也能让构建打出"补丁已应用"（假阳性），
    /// 而补丁正确打在 0.38.2 上时反而被拒（假阴性）。
    #[test]
    fn picks_the_locked_version_not_the_newest_mtime() {
        let (dir, roots) = tmp_roots("pick", &["0.30.1", "0.38.2"]);
        // 让陈旧副本"看起来更新"（touch 一下目录 mtime 到很晚）
        let stale = roots[0].join("libsqlite3-sys-0.30.1");
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        let _ = filetime_set(&stale, future);

        match pick_source_dir(&roots, Some("0.38.2")) {
            SourcePick::Found { dir: d, version } => {
                assert_eq!(version, "0.38.2", "必须挑锁定的那个版本");
                assert!(d.ends_with("libsqlite3-sys-0.38.2/sqlcipher"), "挑到了：{}", d.display());
            }
            other => panic!("应当命中 0.38.2，实际 {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 锁定的版本在 registry 里**不存在** ⇒ 绝不退而求其次挑别的版本（那是"判据看的东西 ≠ 它声称看的"）。
    #[test]
    fn refuses_to_fall_back_to_another_version() {
        let (dir, roots) = tmp_roots("mismatch", &["0.30.1"]);
        match pick_source_dir(&roots, Some("0.38.2")) {
            SourcePick::VersionMismatch { wanted, found } => {
                assert_eq!(wanted, "0.38.2");
                assert_eq!(found, vec!["0.30.1".to_string()]);
            }
            other => panic!("应当报版本不匹配（而不是挑 0.30.1），实际 {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿不到锁版本（`Cargo.lock` 里没这个包）⇒ **不猜**，返回 NotFound（调用方当场失败）。
    #[test]
    fn does_not_guess_when_the_version_is_unknown() {
        let (dir, roots) = tmp_roots("nover", &["0.38.2"]);
        match pick_source_dir(&roots, None) {
            SourcePick::NotFound { wanted, found } => {
                assert_eq!(wanted, None);
                assert_eq!(found, vec!["0.38.2".to_string()]);
            }
            other => panic!("拿不到版本时不许猜，实际 {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_the_marker_only_in_c_or_h_files() {
        let (dir, roots) = tmp_roots("marker", &["0.38.2"]);
        let sc = roots[0].join("libsqlite3-sys-0.38.2").join("sqlcipher");
        assert_eq!(find_marker(&sc), None, "还没打补丁时不该有标记");
        std::fs::write(sc.join("crypto_openssl.c"), "/* SQLCIPHER_HMAC_SM3_LABEL */\n").unwrap();
        assert_eq!(find_marker(&sc).as_deref(), Some("crypto_openssl.c"));
        // 非 .c/.h 不算（别让一个 .txt 里的字面量骗过它）
        let (dir2, roots2) = tmp_roots("marker2", &["0.38.2"]);
        let sc2 = roots2[0].join("libsqlite3-sys-0.38.2").join("sqlcipher");
        std::fs::write(sc2.join("notes.txt"), "SQLCIPHER_HMAC_SM3_LABEL\n").unwrap();
        assert_eq!(find_marker(&sc2), None, "只有 .c/.h 才算 —— 标记必须出现在会被编译的文件里");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// 把目录 mtime 设到指定时刻（不引第三方 crate：直接用 `std::fs::File::set_modified`）。
    fn filetime_set(p: &Path, t: std::time::SystemTime) -> std::io::Result<()> {
        let f = std::fs::File::open(p)?;
        f.set_modified(t)
    }

    // ---- 隔离副本（2026-09-23「消灭补丁残留」） ------------------------------------------

    #[test]
    fn isolation_source_dir_points_at_the_private_copy() {
        let dir = std::env::temp_dir().join(format!("gm-iso-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sc = dir.join(".gm-build").join("libsqlite3-sys-0.38.2").join("sqlcipher");
        std::fs::create_dir_all(&sc).unwrap();
        let got = isolation_source_dir(&dir, Some("0.38.2"));
        assert_eq!(got.map(|(d, v)| (d, v)), Some((sc.clone(), "0.38.2".to_string())));
        // 版本对不上 ⇒ None（绝不退而求其次）
        assert!(isolation_source_dir(&dir, Some("0.30.1")).is_none());
        // 没有版本 ⇒ None
        assert!(isolation_source_dir(&dir, None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cargo_home_is_isolated_only_inside_gm_build() {
        let repo = PathBuf::from("/repo");
        assert!(cargo_home_is_isolated(&repo.join(".gm-build").join("cargo-home"), &repo));
        assert!(!cargo_home_is_isolated(&PathBuf::from("/Users/x/.cargo"), &repo));
        // 前缀像但不是（`.gm-build-old`）⇒ 不算 —— 这条防的是"用 starts_with 判字符串"那类假阳性
        assert!(!cargo_home_is_isolated(&repo.join(".gm-build-old").join("cargo-home"), &repo));
    }

    #[test]
    fn is_under_gm_build_recognizes_the_copy_path() {
        let repo = PathBuf::from("/repo");
        assert!(is_under_gm_build(&repo.join(".gm-build").join("libsqlite3-sys-0.38.2").join("sqlcipher"), &repo));
        assert!(!is_under_gm_build(&PathBuf::from("/Users/x/.cargo/registry/src/i/libsqlite3-sys-0.38.2/sqlcipher"), &repo));
    }
}
