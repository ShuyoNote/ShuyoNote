//! 磁盘剩余空间查询 —— **C1 预算刹车的硬性闸门**用。
//!
//! ## 为什么自己写（一手依据）
//!
//! `std` 没有"剩余空间"这个 API；而 `sysinfo` / `fs4` / `fs2` 都**不在依赖树里**
//! （查过 `Cargo.lock`）——引进来就是多一条供应链。而 `libc` 与 `windows-sys`
//! **本来就在 lockfile 里**（随 tauri / tokio / rusqlite 进来，`libc 0.2.189`、
//! `windows-sys 0.61.2`）。按本仓已有的约定（见 `Cargo.toml` 里 `tokio-util` 那行
//! 「它本来就在依赖树里，这里只是显式声明」），把它们显式声明、直接用系统调用，
//! 比引一个只为一次 `statvfs` 而存在的新包更省事、也更好审。
//!
//! 两个平台各一个调用：Unix / **Android** 走 `statvfs`，Windows 走 `GetDiskFreeSpaceExW`。
//!
//! ## 拿不到值怎么办：**fail-open**
//!
//! 返回 `None`（查询失败 / 平台不支持）时，调用方**不拦**——只记一行日志。
//! 理由是**这里没有安全的默认方向**：若 fail-closed，任何查询失败都会让同步彻底停摆
//! （用户看到的是"同步坏了"），而那比"少拦一次"严重得多。`None` 只应发生在
//! 系统调用失败这种异常路径上；**Android 是这条闸门的主要目标平台，它有实现**。

use std::path::Path;

/// 目标路径所在文件系统的可用字节数。失败返回 `None`（见模块头：fail-open）。
pub(crate) fn available_bytes(path: &Path) -> Option<u64> {
    imp::available_bytes(path)
}

#[cfg(unix)]
mod imp {
    use std::path::Path;

    pub(super) fn available_bytes(path: &Path) -> Option<u64> {
        use std::os::unix::ffi::OsStrExt;

        // `statvfs` 要一个 C 字符串；路径里的字节原样传（Android 上就是 UTF-8）。
        let mut buf = path.as_os_str().as_bytes().to_vec();
        buf.push(0);
        // SAFETY: `buf` 以 NUL 结尾、`st` 是本函数栈上的 `statvfs`（已零初始化），
        // 两个指针在调用期间都有效。
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(buf.as_ptr() as *const libc::c_char, &mut st) };
        if rc != 0 {
            return None;
        }
        // ⚠️ `f_bavail`（**非特权**用户可用块）而不是 `f_bfree`（含 root 保留块）：
        // 保留块我们用不到，用它会把余量算多、刹车踩晚。
        let bs = st.f_frsize as u64;
        Some((st.f_bavail as u64).saturating_mul(bs))
    }
}

#[cfg(windows)]
mod imp {
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    pub(super) fn available_bytes(path: &Path) -> Option<u64> {
        use std::os::windows::ffi::OsStrExt;

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // 传给系统的是**要查询的路径**（文件或目录都行，取它所在卷）。查不到就退到
        // 它自己；两者都查不到才算失败。
        let mut free_to_caller: u64 = 0;
        // SAFETY: `wide` 以 NUL 结尾且在本函数内存活；三个出参都是本函数栈上的 `u64`。
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_to_caller,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return None;
        }
        Some(free_to_caller)
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use std::path::Path;

    pub(super) fn available_bytes(_path: &Path) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机（开发机）必须能查到值：查不到就说明平台分支写错了，而不是"恰好没实现"。
    /// 这里**只断言"能拿到且不为 0"**——不断言具体数字，那种断言在任何机器上都脆。
    #[test]
    fn reports_a_positive_available_size_on_this_machine() {
        let tmp = std::env::temp_dir();
        let avail = available_bytes(&tmp);
        let avail = avail.unwrap_or_else(|| panic!("查不到 {} 的剩余空间（平台分支写错了？）", tmp.display()));
        assert!(avail > 0, "剩余空间应大于 0，实际 {avail}");
    }

    /// 不存在的路径**不许 panic**（上层是 fail-open，这里只需要"不炸"）。
    #[test]
    fn a_missing_path_does_not_panic() {
        let missing = std::env::temp_dir().join("shuyonote-definitely-missing-dir-xyz");
        let _ = available_bytes(&missing); // 有值/None 都可接受
    }
}
