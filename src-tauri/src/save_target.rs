//! 「用户选的目标位置」的**唯一落地入口**——`picked_file` 的写侧孪生兄弟。
//!
//! 为什么需要它：Android 的**保存**对话框（`ACTION_CREATE_DOCUMENT`）和打开对话框一样，
//! 给回来的**不是路径**，而是 `content://…` URI（`tauri-plugin-dialog` 的
//! `DialogPlugin.kt::saveFileDialogResult`：`callResult.put("file", uri.toString())`）。
//!
//! 而我们的导出命令全都把那个字符串当路径用（`PathBuf::from` / `create_dir_all(parent)` /
//! `File::create`）。2026-09-14 真机实测（Mate 40 / Android 12 / 自检包 666c062）：
//!
//! ```text
//! 设置 → 空间 → 导出当前空间 → 保存 → 提示「空间导出失败：Read-only file system (os error 30)」
//! ```
//!
//! 原因不是权限、也不是存储卡只读：`Path::new("content://com.android.providers…")` 是个
//! **相对路径**（`content:` 是它的第一段），相对于进程 CWD——Android 上 CWD 是 `/`，只读 ⇒
//! **EROFS**。于是「导出空间 / 导出备份 / 下载附件 / 导出 HTML / 导出模板 / 导出标注副本」
//! 在 Android 上**全都失败**，而且失败信息完全指不到真正的原因。
//!
//! ## 为什么不能直接往 URI 里写整份 zip
//!
//! 写 URI 只有一条官方通路：`tauri-plugin-fs` 的 `Fs::open`（Android 侧经
//! `ContentResolver.openAssetFileDescriptor(uri, mode)` 拿 fd，再 `File::from_raw_fd`）。
//! 它给的是一个**只能顺序写**的流：`zip::ZipWriter` 需要 `Write + Seek`，直接套上去不行。
//! 所以分两步：**先在应用缓存目录里写一份真文件**（可 seek、出错也不留半个导出件），
//! **写完再整份流式拷进 URI**。
//!
//! 桌面路径**逐字节不变**：`looks_like_uri` 为 false 时就是今天的 `File::create(路径)`，
//! 一行行为都没改（那条判据有单测钉着，见 `picked_file::tests`）。

use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 目标位置的分类。**纯函数**，所以这条路由能被单测钉住（不需要 AppHandle）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Dest {
    /// 真实文件路径（桌面，或我们自己给的内部路径）：直接写。
    Path(PathBuf),
    /// Android 保存对话框给的 `content://` / `file://` URI：先写缓存再搬进去。
    Uri(String),
}

/// 判据与读侧共用一条：含 `://` 且 scheme ≥ 2 字符 ⇒ URI（`C:\…` 必须判成路径）。
pub(crate) fn classify(dest: &str) -> Dest {
    if crate::picked_file::looks_like_uri(dest) {
        Dest::Uri(dest.to_string())
    } else {
        Dest::Path(PathBuf::from(dest))
    }
}

/// 写侧的中转目录名（在 `tempdir` 根之下）。与读侧的 `picked` 分开：两件事、两处清理。
const STAGING_SUBDIR: &str = "save";

/// 一次「保存到用户选的位置」。
///
/// 用法固定成三步，**漏掉 `commit` 就等于什么都没保存**（所以 `commit` 消费 self，
/// 忘记调用时编译器会提醒 `unused_must_use`）：
///
/// ```ignore
/// let target = SaveTarget::new(&app, &dest_path, "shuyonote-space")?;
/// // …把内容写进 target.write_path()…
/// target.commit()?;
/// ```
pub(crate) struct SaveTarget {
    /// 真正要写入的路径：桌面就是目标本身；URI 目标是缓存里的中转文件。
    write_path: PathBuf,
    /// 只有 URI 目标才有：中转文件 + 目标 URI。
    staged: Option<Staged>,
}

struct Staged {
    app: AppHandle,
    uri: String,
    tmp: PathBuf,
}

impl SaveTarget {
    /// 目标就是一个**真实路径**：内容直接写在那里，`commit` 是空操作。
    ///
    /// 单独留这个构造器不只是为了桌面分支好读：它让"桌面这条路"变成**可以单测**的
    /// ——`new()` 需要 `AppHandle`，单测里造不出来，而 `direct()` 不需要。
    /// （`commit()` 需要把内容搬进 URI 的那一半仍然只有真机能验，见模块头注释。）
    pub(crate) fn direct(path: PathBuf) -> Self {
        Self { write_path: path, staged: None }
    }

    /// 解析目标位置。URI 目标会**立刻**在缓存里建中转目录（失败就别开始写）。
    pub(crate) fn new(app: &AppHandle, dest: &str, tmp_stem: &str) -> Result<Self, String> {
        match classify(dest) {
            Dest::Path(p) => {
                // 与导出命令今天的行为一致：父目录不存在就建。目录已存在时是空操作，
                // 所以桌面行为不变（只是把"父目录缺失 ⇒ 报错"变成"顺手建上"）。
                if let Some(parent) = p.parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                }
                Ok(Self::direct(p))
            }
            Dest::Uri(uri) => {
                let dir = crate::tempdir::subdir(STAGING_SUBDIR).map_err(|e| {
                    format!(
                        "建保存中转目录失败（{}）：{e}",
                        crate::tempdir::root().join(STAGING_SUBDIR).display()
                    )
                })?;
                // 固定前缀 + 唯一后缀：同一时刻多个导出互不覆盖，出事后也好认出是谁留下的。
                let tmp = dir.join(format!("{tmp_stem}-{}.part", uuid::Uuid::new_v4()));
                Ok(Self {
                    write_path: tmp.clone(),
                    staged: Some(Staged { app: app.clone(), uri, tmp }),
                })
            }
        }
    }

    /// 内容应当写到这里。
    pub(crate) fn write_path(&self) -> &Path {
        &self.write_path
    }

    /// 收尾：URI 目标把中转文件流式拷进 URI，然后删掉中转文件；路径目标是空操作。
    ///
    /// 注意**先写完整份再搬**：拷到一半失败时，用户的目标文件里不会有半个 zip
    /// （Android 的 `content://` 是截断后重写的，中断就只剩半份——这也是为什么
    /// 不在写入过程中直接对着 URI 流式生成）。
    #[must_use = "commit() 才是真正把内容交给用户的那一步；不调用等于没保存"]
    pub(crate) fn commit(mut self) -> Result<(), String> {
        let Some(staged) = self.staged.take() else {
            return Ok(()); // 桌面：内容已经写在目标路径上了。
        };

        let result = copy_into_uri(&staged.app, &staged.uri, &staged.tmp);
        // 中转文件无论成败都不留：它就是我们的缓存。
        let _ = std::fs::remove_file(&staged.tmp);
        result
    }
}

impl Drop for SaveTarget {
    fn drop(&mut self) {
        // 走到这里说明 `commit` 没被调用（提前 `?` 返回、或调用方忘了）。
        // 把半成品清掉，别让缓存目录里堆垃圾。**用户的原始数据一个字都不碰**。
        if let Some(s) = self.staged.take() {
            let _ = std::fs::remove_file(&s.tmp);
        }
    }
}

/// 把中转文件整份流式拷进 `content://` URI。
///
/// 走 `tauri-plugin-fs` 的 `Fs::open`（写侧）：Android 上它把 `OpenOptions` 折算成
/// `"wt"`（write+truncate）交给 `ContentResolver.openAssetFileDescriptor`，桌面则等价于
/// 普通的 `File::create`。**不要**退回 `std::fs::File::create(uri)`——那正是 EROFS 的来源。
fn copy_into_uri(app: &AppHandle, uri: &str, tmp: &Path) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_fs::FsExt;

    let fp = tauri_plugin_fs::FilePath::from_str(uri).expect("FilePath::from_str 是 Infallible");
    let mut opts = tauri_plugin_fs::OpenOptions::new();
    opts.write(true).truncate(true).create(true);
    let mut out = app.fs().open(fp, opts).map_err(|e| {
        format!(
            "写不进选中的位置（{uri}）：{e}\n\
             若是**整个目录**：Android 上保存对话框只给单个文件，不支持选目录，请改选一个文件。"
        )
    })?;

    let mut input = std::fs::File::open(tmp).map_err(|e| format!("打开中转文件失败：{e}"))?;
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MiB：备份/空间包可以很大，别整份读进内存
    loop {
        let n = std::io::Read::read(&mut input, &mut buf).map_err(|e| format!("读取中转文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("写入选中位置失败：{e}"))?;
    }
    out.flush().map_err(|e| format!("写入选中位置失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这条是**防误路由**的门禁（与读侧同源）：桌面路径绝不能被当成 URI，
    /// 否则桌面会被推到"先写缓存再拷"那条路上去——那是为了 Android 才存在的分支。
    #[test]
    fn desktop_paths_are_not_routed_to_uri_staging() {
        for p in [
            r"C:\Users\cnzen\a.zip",
            "C:/Users/cnzen/a.zip",
            r"\\server\share\a.zip",
            "/home/u/a.zip",
            "a.zip",
            "C:relative.zip",
        ] {
            assert_eq!(classify(p), Dest::Path(PathBuf::from(p)), "{p} 必须被判成路径");
        }
    }

    #[test]
    fn android_document_uris_are_routed_to_staging() {
        let uri = "content://com.android.providers.downloads.documents/document/msf%3A1000000042";
        assert_eq!(classify(uri), Dest::Uri(uri.to_string()));
        // file:// 也走 URI 分支（fs 插件两边都能处理）。
        assert_eq!(
            classify("file:///storage/emulated/0/Download/a.zip"),
            Dest::Uri("file:///storage/emulated/0/Download/a.zip".to_string())
        );
    }

    /// 桌面那条路的**契约**：内容写在目标路径上，`commit` 什么都不做（尤其不移动/不删除）。
    /// 这条挡的是"为了 Android 顺手把桌面也改成先写缓存再搬"——那会改变桌面的落盘时机
    /// 与失败表现（用户可能已经在保存对话框里建了文件）。
    #[test]
    fn direct_target_writes_in_place_and_commit_is_a_noop() {
        let dir = std::env::temp_dir().join(format!("shuyonote-save-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("space.zip");

        let target = SaveTarget::direct(out.clone());
        assert_eq!(target.write_path(), out.as_path(), "桌面必须直接写在目标路径上");
        std::fs::write(target.write_path(), b"payload").unwrap();
        target.commit().unwrap();

        assert_eq!(std::fs::read(&out).unwrap(), b"payload", "commit 不该动文件");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
