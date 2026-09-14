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
//!
//! ## 为什么这里还要管"名字和类型"（2026-09-17 修的那条真机 bug）
//!
//! 只把包里拷成临时文件是不够的：原来的临时文件名是**裸 UUID、无扩展名**，而下游
//! `attachments.rs` 拿 `file_name()` 当附件名、拿 `mime_from_path()`（**只看扩展名**）
//! 定 mime ⇒ Android 上导进来的附件显示成
//! `📎41449ced-d44e-4d3c-8e14-7c6733ad042a 未整理 文件 1.8 KB`，
//! 前端的 `file.mime` 分支（内置文件预览 / PDF 阅读器 / 照片墙）全都进不去。
//!
//! 所以 **URI 输入**要多问一句"这是什么文件"，三层，逐层变弱（桌面一层都不走 ⇒
//! 行为逐字节不变）：
//!
//! 1. **问系统**：Kotlin 侧 `ContentResolver.query(OpenableColumns.DISPLAY_NAME)`
//!    与 `getType(uri)`——**唯一可靠来源**，理由见 `android_fs.rs`；
//! 2. **URI 尾段启发**（[`name_from_uri`]）：纯字符串活，外置存储那条能成功；
//! 3. **内容嗅探**（[`crate::magic`]）：连名字都没有时至少把类型认出来，让
//!    "图片能预览、PDF 能进内置阅读器"**不依赖 Android 专属代码**。
//!
//! 另外，临时文件名仍然唯一（uuid）但**带上扩展名**：下游除了 `mime_from_path`，
//! 还有 `plugins.rs` 的"是不是 `.zip` 插件包"**只看扩展名**——Android 上装 zip 插件包
//! 之所以必然失败，根因就在这条链上（它当时看的是 `content://…` 那个 URI 字符串）。

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

/// 显示名的长度上限。名字会进数据库、也会进列表 UI；Android 上 provider 给的名字
/// 理论上能很长（而 `OpenableColumns.DISPLAY_NAME` 是**别人给的字符串**），截一下。
const MAX_NAME_CHARS: usize = 200;

/// 把 provider / URI 里拿到的名字**消毒**成可以直接当显示名的东西。
///
/// - 去掉路径分隔符与 NUL（名字里带 `/` 只可能来自 `%2F` 解码，绝不能让下游把它
///   当成路径的一部分）；
/// - 去掉首尾空白与首部的 `.`（`.` / `..` 这类名字没有意义，也容易被下游当路径用）；
/// - 截长。
///
/// 返回空串表示"这个名字不可用"。
pub(crate) fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != '\0')
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    trimmed.chars().take(MAX_NAME_CHARS).collect::<String>()
}

/// 从 URI 尾段**尽力**恢复原始文件名（拿不到就 `None`）。
///
/// ⚠️ **这只是兜底，不是可靠来源**：能不能恢复出真名全看 provider 是谁——
///
/// | provider | 尾段（percent 解码后） | 结果 |
/// |---|---|---|
/// | `com.android.externalstorage.documents` | `primary:Download/photo.png` | ✅ `photo.png` |
/// | `com.android.providers.media.documents` | `image:1234` | ❌ id，不是名字 |
/// | `com.android.providers.downloads.documents` | `msf:1000000042` | ❌ id |
///
/// 所以它只挡**外置存储那条**（AOSP「文件」应用浏览内部存储，最常见的走法）；
/// MediaStore/Downloads 那半边只能靠 Kotlin 问 `ContentResolver`（见 `android_fs.rs`）。
/// 纯函数，可单测——这也是它值得单独存在的原因。
pub(crate) fn name_from_uri(uri: &str) -> Option<String> {
    // 只处理 `content://`：`file:///storage/…/a.png` 也能解，但那种 URI 在 Android 上
    // 本来就带路径，交给它自己的路径语义更合适（Tauri 会按 Url 变体处理）。
    if !uri.starts_with("content://") {
        return None;
    }
    // 尾段 → 去掉 query/fragment（`ContentResolver` 的 URI 一般没有，但别假设）
    let tail = uri.rsplit('/').next()?;
    let tail = tail.split(['?', '#']).next().unwrap_or(tail);
    let decoded = percent_encoding::percent_decode(tail.as_bytes()).decode_utf8_lossy();
    // document id 形如 `primary:Download/photo.png`（`%3A` 解出来就是 `:`）；
    // 冒号后面还可能是一条相对路径，取最后一段。
    let after_colon = decoded.rsplit(':').next().unwrap_or(&decoded);
    let base = after_colon.rsplit('/').next().unwrap_or(after_colon);
    let name = sanitize_name(base);
    if name.is_empty() || looks_like_id(&name) {
        return None;
    }
    Some(name)
}

/// 这段"名字"其实是个 id 吗（`1234` / `1000000042`）？
///
/// 判据：**一个字母都没有**（Unicode 意义上的字母，所以 `测试.png` 不算 id，
/// 而 `1234` 算）。宁可不给名字，也别把一个 id 当成文件名显示给用户——
/// 那比裸 UUID 更容易让人以为"这就是原名"。
fn looks_like_id(name: &str) -> bool {
    !name.chars().any(|c| c.is_alphabetic())
}

/// 取一个**可用**的扩展名（1..=10 个 ASCII 字母数字），拿不到返回 `None`。
///
/// 为什么不用 `Path::extension()` 就完事：它会把 `report.final version` 的
/// `final version` 当扩展名（含空格），而我们会把返回的扩展名**拼进落盘文件名**。
/// 判据收紧之后，"扩展名"才是我们敢用的东西。
fn usable_ext(name: &str) -> Option<String> {
    let ext = name.rsplit_once('.')?.1;
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// 一次「落地」的结果。非 URI 时 `copy` 为 `None`（**什么都没做**），
/// `name`/`system_mime`/`sniffed` 也全为 `None` ⇒ 桌面行为**逐字节不变**。
pub(crate) struct PickedFile {
    path: PathBuf,
    copy: Option<PathBuf>,
    /// 选择器给的**原始显示名**（问系统问到的，或从 URI 尾段恢复的）。
    /// 桌面恒为 `None` —— 那时调用方沿用 `path().file_name()`，与今天一致。
    name: Option<String>,
    /// 系统说的 mime（`ContentResolver.getType`）。**只有 Android 会有**。
    system_mime: Option<String>,
    /// 扩展名是**嗅探**出来的时留着的类型：下游要用它的 mime —— `mime_from_path`
    /// 只认它自己那张扩展名表（例如 `ogg` 就不在表里，光靠扩展名会把 mime 丢掉）。
    sniffed: Option<crate::magic::Magic>,
}

impl PickedFile {
    /// 可以按普通文件路径使用的真实路径。
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// 选择器给的原始显示名（没有就 `None`）。
    ///
    /// ⚠️ 只有 Android 那条路会填它，所以这个取值口本身只在 `cfg(test)` 里被用到；
    /// 生产代码一律走 [`Self::effective_name`]（它把"没有名字"这件事也一起处理了）。
    #[cfg(any(target_os = "android", test))]
    pub(crate) fn picked_name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// 系统说的 mime（没有就 `None`）。
    pub(crate) fn system_mime(&self) -> Option<&str> {
        self.system_mime.as_deref()
    }

    /// 按内容嗅探出来的类型（没有就 `None`）。
    pub(crate) fn sniffed(&self) -> Option<crate::magic::Magic> {
        self.sniffed
    }

    /// 「用户选的那个东西叫什么」：优先选择器给的名字，否则退回路径里的文件名。
    ///
    /// 桌面（`name` 为 `None`）拿到的就是 `path().file_name()`，与改这行之前**完全一致**。
    pub(crate) fn effective_name(&self) -> String {
        if let Some(n) = &self.name {
            return n.clone();
        }
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string())
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
///
/// URI 分支会**顺带**把「这是什么文件」问清楚，因为这是唯一一次能问到系统的地方
/// （理由见 `android_fs.rs` 与 `magic.rs` 的模块头注释）。三层，逐层变弱：
///
/// 1. 问 Kotlin 要 `DISPLAY_NAME` / `ContentResolver.getType`（**只有 Android**；
///    拿不到就 `None`，**不影响导入**）；
/// 2. 从 URI 尾段恢复名字（纯字符串活，外置存储那条能成功）；
/// 3. 按**内容**嗅探（魔数）—— 让"图片能预览、PDF 能进内置阅读器"这件事
///    不依赖任何 Android 专属代码。
pub(crate) fn materialize(app: &AppHandle, picked: &str) -> Result<PickedFile, String> {
    if !looks_like_uri(picked) {
        // 桌面路径 / 我们自己的内部路径：原样返回，不做任何多余的事。
        return Ok(PickedFile {
            path: PathBuf::from(picked),
            copy: None,
            name: None,
            system_mime: None,
            sniffed: None,
        });
    }

    // ① 问系统。桌面没有这一层（`#[cfg]` 掉了，连类型都不存在）。
    #[cfg(target_os = "android")]
    let (system_name, system_mime) = match crate::android_fs::picked_file_info(app, picked) {
        Some(info) => (
            Some(sanitize_name(&info.name)).filter(|s| !s.is_empty()),
            usable_mime(&info.mime),
        ),
        None => (None, None),
    };
    #[cfg(not(target_os = "android"))]
    let (system_name, system_mime): (Option<String>, Option<String>) = (None, None);

    // ② 尾段启发（系统的答案优先）。
    let name = system_name.or_else(|| name_from_uri(picked));

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
    // `/tmp`，而 **Android 根目录下没有 `/tmp`** ⇒ `create_dir_all` 直接失败，真机上表现为
    // 「建临时目录失败」——选文件这条链路（② §2.2）就断在这最后一步。
    //
    // 现在统一走 `tempdir`（根目录 = 应用自己的缓存目录，启动时在 `lib.rs` 里定向）。
    // 这里用**固定名字**的 `subdir`：目录稳定、文件名唯一，选多个文件也不会互相覆盖。
    let dir = crate::tempdir::subdir("picked").map_err(|e| {
        format!(
            "建临时目录失败（{}）：{e}",
            crate::tempdir::root().join("picked").display()
        )
    })?;
    // 文件名仍然是**唯一**的（uuid）——用户原始文件名可能重复（两次选到不同目录下的
    // `photo.png`），拿它当临时文件名会让后一个**覆盖**前一个，导进来的内容就串了。
    // 但扩展名要尽量带上：下游的 `mime_from_path` 与"是不是 .zip 插件包"都**只看扩展名**。
    let id = uuid::Uuid::new_v4().to_string();
    let name_ext = name.as_deref().and_then(usable_ext);
    let dst = match &name_ext {
        Some(ext) => dir.join(format!("{id}.{ext}")),
        None => dir.join(&id),
    };
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

    // ③ 还没有扩展名（名字里没有、或名字本身就没带）⇒ 按内容嗅探补一个。
    //    补出来的扩展名让下游的 `mime_from_path` 与「是不是 .zip 插件包」都重新能用，
    //    而 sniffed 也一并交给下游（`ogg` 这类不在扩展名表里的才不会丢 mime）。
    let mut path = dst.clone();
    let mut sniffed = None;
    if name_ext.is_none() {
        if let Some(m) = crate::magic::sniff_file(&dst) {
            let with_ext = dir.join(format!("{id}.{}", m.ext));
            if std::fs::rename(&dst, &with_ext).is_ok() {
                path = with_ext;
            }
            sniffed = Some(m);
        }
    }

    Ok(PickedFile {
        copy: Some(path.clone()),
        path,
        name,
        system_mime,
        sniffed,
    })
}

/// 系统给的 mime 能不能用？空串、`application/octet-stream`（"我也不知道"）、
/// 以及任何不是 `type/subtype` 形状的串都不算。
///
/// 只有 Android 那条路会问系统，所以桌面**非测试**构建里它没有调用点 —— 用 `cfg` 收窄，
/// 免得留下一条 dead_code 警告（测试里要单测它，所以带上 `test`）。
#[cfg(any(target_os = "android", test))]
fn usable_mime(raw: &str) -> Option<String> {
    let m = raw.trim();
    if m.is_empty() || m.eq_ignore_ascii_case("application/octet-stream") {
        return None;
    }
    let (ty, sub) = m.split_once('/')?;
    if ty.is_empty() || sub.is_empty() || !m.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    Some(m.to_ascii_lowercase())
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

    /// **这条钉的是真机那条 bug 的另一半**：`📎41449ced-…` 这种没有扩展名的
    /// 附件，在 URI 尾段能恢复出真名时，名字与扩展名都要恢复出来。
    #[test]
    fn uri_tail_gives_back_a_real_name_when_the_provider_has_one() {
        // 外置存储（AOSP「文件」应用浏览内部存储）——最常见的能救回来的那条
        assert_eq!(
            name_from_uri("content://com.android.externalstorage.documents/document/primary%3ADownload%2Fphoto.png")
                .as_deref(),
            Some("photo.png")
        );
        // 中文名（percent 编码的多字节 UTF-8）不能被截坏
        assert_eq!(
            name_from_uri("content://com.android.externalstorage.documents/document/primary%3ANotes%2F%E6%B5%8B%E8%AF%95.md")
                .as_deref(),
            Some("测试.md")
        );
        // 名字里带 query 也不能把它带进来
        assert_eq!(
            name_from_uri("content://a.b.c/document/primary%3AD%2Fx.pdf?foo=1").as_deref(),
            Some("x.pdf")
        );
    }

    /// **纯 id 的 provider 必须被拒**：`image:1234` / `msf:1000000042` 是 id，
    /// 把它当文件名显示比显示裸 UUID 更容易让人误以为"这就是原名"。
    #[test]
    fn uri_tail_that_is_only_an_id_is_refused() {
        assert_eq!(name_from_uri("content://com.android.providers.media.documents/document/image%3A1234"), None);
        assert_eq!(
            name_from_uri("content://com.android.providers.downloads.documents/document/msf%3A1000000042"),
            None
        );
        // 不是 content:// 的一律不走这条（file:// 有自己的路径语义）
        assert_eq!(name_from_uri("file:///storage/emulated/0/a.zip"), None);
        assert_eq!(name_from_uri("content://"), None);
    }

    /// 消毒：`%2F` 解出来的 `/` 绝不能留在名字里（下游会把它当路径分隔符）。
    #[test]
    fn recovered_names_are_sanitized() {
        assert_eq!(sanitize_name("  a/b\\c\0d  "), "abcd");
        assert_eq!(sanitize_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_name("..."), "");
        assert_eq!(sanitize_name(&"x".repeat(500)).chars().count(), MAX_NAME_CHARS);
        // 恢复出来的名字必须已经是消毒过的（`%2F` 那条）
        assert_eq!(
            name_from_uri("content://a.b/document/primary%3AD%2F..%2F..%2Fevil.png").as_deref(),
            Some("evil.png")
        );
    }

    /// 扩展名可用性：扩展名会被**拼进落盘文件名**，所以含空格的"扩展名"不算扩展名。
    #[test]
    fn only_plausible_extensions_are_used_for_the_temp_file() {
        assert_eq!(usable_ext("photo.PNG").as_deref(), Some("png"));
        assert_eq!(usable_ext("a.tar.gz").as_deref(), Some("gz"));
        assert_eq!(usable_ext("noext"), None);
        assert_eq!(usable_ext("report.final version"), None);
        assert_eq!(usable_ext("trailing."), None);
        assert_eq!(usable_ext(".png").as_deref(), Some("png"));
        assert_eq!(usable_ext("x.verylongextension"), None);
    }

    /// 系统的 mime 只有真的是 `type/subtype` 才算数；`octet-stream` 等于"我也不知道"。
    #[test]
    fn only_usable_system_mimes_are_trusted() {
        assert_eq!(usable_mime("image/png").as_deref(), Some("image/png"));
        assert_eq!(usable_mime(" IMAGE/PNG ").as_deref(), Some("image/png"));
        assert_eq!(usable_mime(""), None);
        assert_eq!(usable_mime("application/octet-stream"), None);
        assert_eq!(usable_mime("application/Octet-Stream"), None);
        assert_eq!(usable_mime("png"), None);
        assert_eq!(usable_mime("image/"), None);
    }

    /// **桌面不变**的门禁：非 URI 输入必须原样返回，一个字段都不许多出来。
    /// （`materialize` 需要 `AppHandle`，所以这里钉的是它依赖的那几个纯函数 +
    /// `effective_name` 的桌面语义。）
    #[test]
    fn desktop_paths_never_gain_a_name_or_mime_from_the_uri_layer() {
        // 桌面路径根本不是 URI ⇒ 既不会问系统，也不会走尾段启发
        assert!(!looks_like_uri(r"C:\Users\cnzen\report.pdf"));
        assert_eq!(name_from_uri(r"C:\Users\cnzen\report.pdf"), None);

        // effective_name 在"没有选择器名字"时就是路径的文件名（桌面恒为此）
        let pf = PickedFile {
            path: PathBuf::from(r"C:\Users\cnzen\report.pdf"),
            copy: None,
            name: None,
            system_mime: None,
            sniffed: None,
        };
        assert_eq!(pf.effective_name(), "report.pdf");
        assert_eq!(pf.picked_name(), None);
        assert_eq!(pf.system_mime(), None);
        assert_eq!(pf.sniffed(), None);
    }
}

