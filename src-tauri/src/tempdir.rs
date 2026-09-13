//! 应用临时目录：**生产代码不要再直接调 `std::env::temp_dir()`**。
//!
//! ## 为什么要有这个模块（2026-09-13 真机实测的教训）
//!
//! Android 上 `std::env::temp_dir()` 返回 **`/tmp`**，而 **Android 根目录下没有 `/tmp`**
//! （也没有设 `TMPDIR`）⇒ `create_dir_all` 立刻失败。桌面永远有 `/tmp`，所以这个坑
//! **只在手机上暴露**，而且症状离原因很远：
//!
//! - 选文件（`picked_file.rs`）→ 真机报「建临时目录失败」；
//! - 备份导出 / 恢复（`backup.rs`）；
//! - 插件包解压（`plugin_index.rs`）；
//! - 空间包导出 / 导入（`workspace_io.rs`）。
//!
//! ## 做法
//!
//! 启动时（`lib.rs` 的 `setup`）把**临时根目录**定向到应用自己的缓存目录
//! （`app_cache_dir()/tmp`；Android 上是 `/data/user/0/<pkg>/cache/tmp`，应用可写、
//! 系统允许回收）。之后所有临时文件都放它下面。
//!
//! 用全局 `OnceLock` 而不是给每个函数加参数：这些调用点散在很深的工具函数里，
//! 有的（如 `plugin_index::package_temp_dir`）连 `AppHandle` 都拿不到。
//!
//! **兜底**：没初始化时退回系统临时目录下的 `shuyonote/`，所以桌面行为不变、
//! 忘了 `init` 也不会崩（只是手机上会退回旧行为，因此 `init` 走 `setup` 是必经之路）。
//!
//! 测试代码里的 `std::env::temp_dir()` 保持原样：`cargo test` 只在桌面上跑，
//! `/tmp` 一直在。

use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 启动时调用一次。`OnceLock` 语义：重复调用不覆盖，也不会 panic。
pub fn init(root: PathBuf) {
    let _ = ROOT.set(root);
}

/// 未初始化时的回退位置（抽出来是为了能单测，不用碰全局状态）。
fn fallback_root() -> PathBuf {
    std::env::temp_dir().join("shuyonote")
}

/// 当前临时根目录。**不保证存在**；要往里面写请用 [`dir`] / [`file`]。
pub fn root() -> PathBuf {
    match ROOT.get() {
        Some(p) => p.clone(),
        None => fallback_root(),
    }
}

/// 唯一后缀：`pid` + 纳秒。用 `uuid` 也行，但这里不需要依赖就能保证不撞。
fn unique(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{tag}-{}-{nanos}", std::process::id())
}

/// 临时根下的一个**已建好**的唯一目录。
pub fn dir(tag: &str) -> std::io::Result<PathBuf> {
    let base = root();
    std::fs::create_dir_all(&base)?;
    let dir = base.join(unique(tag));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 临时根下的一个**固定名字**目录（已建好）。给"每次都往同一个目录里放不同文件"用
/// （例如选文件复制出来的副本：目录稳定、文件名唯一）。
pub fn subdir(name: &str) -> std::io::Result<PathBuf> {
    let dir = root().join(name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 临时根下的一个唯一路径，**只建父目录、不创建它本身**。
///
/// 给那些"要求目标尚不存在"的调用方：例如 `plugin_index::package_temp_dir()`
/// 明确要求解压前目录不存在（解压工具自己创建），先建好可能让它报"已存在"。
pub fn path(tag: &str) -> PathBuf {
    let base = root();
    let _ = std::fs::create_dir_all(&base);
    base.join(unique(tag))
}

/// 临时根下的一个唯一**文件**路径（父目录建好，文件不创建）。
pub fn file(tag: &str, ext: &str) -> PathBuf {
    let base = root();
    let _ = std::fs::create_dir_all(&base);
    let name = if ext.is_empty() {
        unique(tag)
    } else {
        format!("{}.{ext}", unique(tag))
    };
    base.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_under_system_temp_when_not_initialized() {
        // 不能断言"一定没初始化"（同进程的其它测试可能 init 过），所以只检查
        // 回退函数本身与 root() 的关系：要么是 init 设的，要么是回退值。
        let r = root();
        assert!(
            r == fallback_root() || r.starts_with(std::env::temp_dir()),
            "root() 应该要么是回退值、要么在系统临时目录下，实际是 {r:?}"
        );
    }

    #[test]
    fn dir_creates_a_unique_existing_directory() {
        let a = dir("t-dir").unwrap();
        let b = dir("t-dir").unwrap();
        assert!(a.is_dir() && b.is_dir(), "dir() 返回的目录必须已经存在");
        assert_ne!(a, b, "同名两次调用必须给出两个不同目录");
        assert!(a.starts_with(root()), "{a:?} 应该落在临时根下");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn path_leaves_the_leaf_absent_but_makes_the_parent() {
        let p = path("t-path");
        assert!(!p.exists(), "path() 不应创建叶子（解压前要保持不存在）");
        assert!(p.parent().unwrap().is_dir(), "父目录必须建好，否则解压建不动");
    }

    #[test]
    fn file_gets_the_extension_and_does_not_exist_yet() {
        let f = file("t-file", "db");
        assert!(!f.exists());
        assert_eq!(f.extension().and_then(|e| e.to_str()), Some("db"));
        assert!(f.parent().unwrap().is_dir());
    }

    #[test]
    fn subdir_is_stable_for_the_same_name() {
        let a = subdir("t-stable").unwrap();
        let b = subdir("t-stable").unwrap();
        assert_eq!(a, b, "同名 subdir 必须是同一个目录");
        assert!(a.is_dir());
        let _ = std::fs::remove_dir_all(&a);
    }
}
