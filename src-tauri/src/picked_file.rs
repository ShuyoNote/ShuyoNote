//! 「用户选的文件」的**唯一落地入口**。
//!
//! 为什么需要这一层：**Android 的系统选择器返回的不是文件路径。**
//! `tauri-plugin-dialog` 的 Android 实现（`DialogPlugin.kt::createPickFilesResult`）是
//! `uris.add(uri.toString())`——原样把 `content://com.android.providers.media.documents/...`
//! 交给前端；同一个文件里那个能反查真实路径的 `FilePickerUtils.getPathFromUri()`
//! **在这条路上根本没被调用**（2026-09-13 读源码确认，见 `docs/MOBILE.md` §2.2）。
//!
//! 而我们的导入路径全都按"文件路径"用它（`PathBuf::from` / `exists()` / `is_file()` /
//! `std::fs::File::open`），于是 Android 上「附件导入 / 装 zip 插件 / 备份恢复 / 空间导入」
//! 要么报"不存在"、要么报"读取失败"——**而且报的是误导性的话**。
//!
//! 官方通路是 `tauri-plugin-fs` 的 [`Fs::open`]：Android 上它经 Kotlin 的
//! `ContentResolver.openAssetFileDescriptor(uri, mode)` 取 fd，再 `File::from_raw_fd`；
//! 桌面上它就是 `std::fs::OpenOptions::from(opts).open(path)`——**与我们现在做的事完全等价**。
//!
//! **但桌面仍然走原路**：桌面选择器永远给真实路径，没必要为此多一条分支。
//! 只有值**看着像 URI** 时才走插件，所以桌面行为是**逐字节不变**的
//! （`looks_like_uri(r"C:\x")` 为 `false`，有单测钉着）。
//!
//! 为什么是"拷成临时真路径"而不是"改成到处读 fd"：这样**各入口只改一行**，
//! 下游那些 `exists()` / `is_file()` / `File::open` / `std::fs::read` 全都照旧能用，
//! 也就能被现有测试与代码审阅继续覆盖。代价是一次拷贝——这正是计划里早就写下的
//! "先拷到缓存"的退路。

use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 值是不是 URI（`content://…` / `file://…`）而不是文件路径？
///
/// 判据：含 `://` 且 `://` 之前的 scheme **至少 2 个字符**。
/// 那个长度条件很要紧——**Windows 的 `C:\…` 必须被判成路径**，否则桌面会被误路由到
/// URI 分支上去（Tauri 自己的 `FilePath::from_str` 用的就是"scheme 长度为 1 时当路径"）。**/
pub(crate) fn looks_like_uri(s: &str) -> bool {
    matches!(s.find("://"), Some(i) if i >= 2)
}

/// 一次「落地」的结果。非 URI 时 `copy` 为 `None`（**什么都没做**）。
pub(crate) struct PickedFile {
    path: PathBuf,
    copy: Option<PathBuf>,
}

impl PickedFile {
    /// 可以按普通文件路径使用的真实路径。
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PickedFile {
    fn drop(&mut self) {
        // 只删我们自己拷出来的那份；用户原始文件一个字都不碰。
        if let Some(c) = self.copy.take() {
            let _ = std::fs::remove_file(&c);
        }
    }
}

/// 把「用户选的东西」变成一条**真实文件路径**（见模块头注释）。
pub(crate) fn materialize(app: &AppHandle, picked: &str) -> Result<PickedFile, String> {
    if !looks_like_uri(picked) {
        // 桌面路径 / 我们自己的内部路径：原样返回，不做任何多余的事。
        return Ok(PickedFile {
            path: PathBuf::from(picked),
            copy: None,
        });
    }

    use std::io::{Read, Write};
    use std::str::FromStr;
    use tauri_plugin_fs::FsExt;

    // ⚠️ 必须走 `FilePath::from_str`，**不能**用 `Path::new(picked)`：
    // 前者会判断"这是 URL 还是路径"（`content://` → `FilePath::Url` → Android 走 ContentResolver），
    // 而 `From<&Path>` 会把它当成普通路径，等于白改。
    // 它的 `FromStr::Err` 是 `Infallible`，任何字符串都能转。
    let fp = tauri_plugin_fs::FilePath::from_str(picked).expect("FilePath::from_str 是 Infallible");

    let mut opts = tauri_plugin_fs::OpenOptions::new();
    opts.read(true);
    let mut input = app.fs().open(fp, opts).map_err(|e| {
        format!(
            "打不开选中的文件（{picked}）：{e}\n\
             若选的是**整个目录**：Android 上暂不支持按目录选（系统给的是 tree URI，读不出目录树），\
             请改用 .zip 包（插件包 / 备份 / 空间包）。"
        )
    })?;

    // ⚠️ **不要用 `std::env::temp_dir()`**（2026-09-13 真机实测的教训）：Android 上它是
    // `/tmp`（TMPDIR 未设时的等价物），而 **`/tmp` 在 Android 上不存在/不可写** ⇒
    // `create_dir_all` 直接失败，真机上表现为「建临时目录失败」——选文件这条链路
    // （② §2.2）就断在这最后一步。正解是走 Tauri 的路径 API：应用自己的 cache 目录。
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("拿不到应用缓存目录（Android 上不能用 /tmp）：{e}"))?
        .join("shuyonote-picked");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败（{}）：{e}", dir.display()))?;
    let dst = dir.join(uuid::Uuid::new_v4().to_string());
    let mut out = std::fs::File::create(&dst).map_err(|e| format!("建临时文件失败：{e}"))?;

    // 流式拷，别整份读进内存：备份/空间包可以很大。
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = input
            .read(&mut buf)
            .map_err(|e| format!("读取选中文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
    }
    out.flush().map_err(|e| format!("写入临时文件失败：{e}"))?;
    drop(out);

    Ok(PickedFile {
        path: dst.clone(),
        copy: Some(dst),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这条是**防误路由**的门禁：桌面路径绝不能被当成 URI。
    /// 一旦判错，桌面就会去走 fs 插件那条路——而那是"为了 Android 才存在的"分支。
    #[test]
    fn only_real_uris_are_treated_as_uris() {
        // 桌面路径：Windows 盘符（单字符 scheme）与两种分隔符、UNC、相对路径
        assert!(!looks_like_uri(r"C:\Users\cnzen\a.zip"));
        assert!(!looks_like_uri("C:/Users/cnzen/a.zip"));
        assert!(!looks_like_uri(r"\\server\share\a.zip"));
        assert!(!looks_like_uri("/home/u/a.zip"));
        assert!(!looks_like_uri("a.zip"));
        assert!(!looks_like_uri(""));
        // 含冒号但不是 URI（冒号后面没有 //）
        assert!(!looks_like_uri("C:relative.zip"));

        // Android 选择器给的
        assert!(looks_like_uri(
            "content://com.android.providers.media.documents/document/image%3A1234"
        ));
        assert!(looks_like_uri("content://downloads/public_downloads/42"));
        // file:// 也是 URI（Tauri 会把它当 Url 变体处理）
        assert!(looks_like_uri("file:///storage/emulated/0/a.zip"));
    }
}
