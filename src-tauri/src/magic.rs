//! 按**文件内容**（magic bytes）判断类型。
//!
//! ## 为什么需要它（2026-09-17）
//!
//! Android 的系统文件选择器给我们的**不是文件路径**，而是一个 `content://` URI；
//! `tauri-plugin-dialog` 的 Android 实现只把这个 URI 字符串交出来，**连文件名都没有**
//! （`DialogPlugin.kt::createPickFilesResult` → `uris.add(uri.toString())`，
//! 2.7.3 版读源码确认；同一个包里的 `FilePickerUtils.getNameFromUri()` 在这条路上
//! **零调用点**）。于是 `picked_file::materialize` 只能把选中文件拷成
//! **裸 UUID、无扩展名**的临时文件，而下游的 `mime_from_path` **只看扩展名** ——
//! 结果就是真机上那条 `📎41449ced-… 未整理 文件 1.8 KB`：名字和 mime 同时丢，
//! 前端的 `file.mime` 分支（内置预览 / PDF 阅读器 / 照片墙）全都进不去。
//!
//! 名字那半边只能问系统（`ContentResolver.query(OpenableColumns.DISPLAY_NAME)`，
//! 见 `android_fs.rs` 与 `scripts/android-mobile-shell.mjs` 注入的 Kotlin）。
//! **但类型那半边不必依赖系统**：文件内容本身就在手上。这一层是**兜底层**——
//! 桥挂了、provider 答不上来、或者名字里根本没有扩展名时，它仍然能把
//! 「这是 PNG」认出来，于是"图片能预览、PDF 能进内置阅读器"这件事
//! **不依赖任何 Android 专属代码**，也就**能在本机单测里钉住**。
//!
//! ## 只认无歧义的签名
//!
//! 这里刻意**不**认 BMP / TIFF 那类弱签名（`BM`、`II*\0`）：误判的代价是把文本
//! 当成图片去渲染，而收益只是极少数格式 —— 宁可返回 `None`（下游退回
//! `application/octet-stream`，与今天完全一样）。同理，SVG 这种纯文本格式必须先
//! 从文本里认出来，否则会先被"看起来是文本"那条抢走。

use std::path::Path;

/// 嗅探只看开头这么多个字节：下面每个签名都落在前 16 字节内，512 是余量。
pub(crate) const HEAD_LEN: usize = 512;

/// 嗅探到的类型：MIME + **规范扩展名**（与 `attachments::mime_from_path` 同一套口径，
/// 因为它同样要被拼进落盘文件名 `attachments/<bucket>/<hash>.<ext>`）。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) struct Magic {
    pub mime: &'static str,
    pub ext: &'static str,
}

/// 读文件**开头** [`HEAD_LEN`] 字节再嗅探。打不开、读不动都返回 `None`（不是错误）。
pub(crate) fn sniff_file(path: &Path) -> Option<Magic> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD_LEN];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    sniff(&buf)
}

/// 只看这段字节判断类型。认不出来就 `None`（**不猜**）。
pub(crate) fn sniff(head: &[u8]) -> Option<Magic> {
    fn magic(mime: &'static str, ext: &'static str) -> Option<Magic> {
        Some(Magic { mime, ext })
    }

    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return magic("image/png", "png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return magic("image/jpeg", "jpg");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return magic("image/gif", "gif");
    }
    // RIFF 容器：第 8..12 字节是子类型（WebP 图片 / WAVE 音频）。
    if head.len() >= 12 && &head[0..4] == b"RIFF" {
        match &head[8..12] {
            b"WEBP" => return magic("image/webp", "webp"),
            b"WAVE" => return magic("audio/wav", "wav"),
            _ => {}
        }
    }
    if head.starts_with(b"%PDF-") {
        return magic("application/pdf", "pdf");
    }
    // ZIP 的三个签名：普通 / 空包 / 分卷。这条同时把 .docx/.xlsx/.pptx 归成 zip ——
    // 它们本来就是 zip；扩展名在的时候轮不到这里（见调用点）。

    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || head.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || head.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        return magic("application/zip", "zip");
    }
    if head.starts_with(&[0x1F, 0x8B]) {
        return magic("application/gzip", "gz");
    }
    if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return magic("application/x-7z-compressed", "7z");
    }
    if head.starts_with(b"OggS") {
        return magic("audio/ogg", "ogg");
    }
    // MP3：**只认带 ID3 标签的**。
    //
    // 刻意**不**认"裸帧同步字"（`0xFF` + 高 3 位为 1）：那条判据会把
    // **UTF-16 的 BOM（`FF FE` / `FE FF`）**以及任何以 `0xFF` 开头的二进制数据
    // 认成 MP3 —— 本模块单测里就钉着这一条（`unknown_bytes_stay_unknown_instead_of_guessing`
    // 最初就是被它判红的）。宁可少数没带 ID3 的 mp3 退回 octet-stream（与今天一样），
    // 也不要把别的文件谎报成音频。
    if head.starts_with(b"ID3") {
        return magic("audio/mpeg", "mp3");
    }
    // ISO BMFF（mp4 家族）：第 4..8 字节是 `ftyp`，第 8..12 是品牌；`qt  ` 是 QuickTime。
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return if &head[8..12] == b"qt  " {
            magic("video/quicktime", "mov")
        } else {
            magic("video/mp4", "mp4")
        };
    }
    // SVG 是文本，必须在"看起来像文本"之前认：`<svg` / `<?xml` 开头 **且** 开头这段里
    // 真的出现 `<svg`（只认 `<svg` 不够——XML 声明后面可能跟的是别的根元素）。
    if let Some(text) = leading_text(head) {
        let t = text.trim_start_matches('\u{feff}').trim_start();
        if (t.starts_with("<svg") || t.starts_with("<?xml")) && t.contains("<svg") {
            return magic("image/svg+xml", "svg");
        }
    }
    if leading_text(head).is_some() {
        return magic("text/plain", "txt");
    }
    None
}

/// 这段字节"看起来是文本"吗？是就把它按 UTF-8 解出来。
///
/// 判据：不含 NUL；UTF-8 要么整段合法，要么**只在末尾断在一个多字节字符中间**
/// （那说明后面还有内容，不是坏字节）。空输入不算文本（空文件不该被叫 `text/plain`）。
fn leading_text(head: &[u8]) -> Option<&str> {
    if head.is_empty() || head.contains(&0u8) {
        return None;
    }
    match std::str::from_utf8(head) {
        Ok(s) => {
            if s.chars().any(|c| !c.is_whitespace()) {
                Some(s)
            } else {
                None
            }
        }
        Err(e) => {
            // `error_len() == None` ⇒ 不完整的多字节序列被截断在末尾 —— 仍然算文本。
            if e.error_len().is_none() && e.valid_up_to() > 0 {
                std::str::from_utf8(&head[..e.valid_up_to()]).ok()
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **这条是本模块存在的理由**：一段 PNG 内容、没有任何名字/扩展名，
    /// 也必须被判成 `image/png` —— Android 导入的裸 UUID 文件走的就是这条路。
    #[test]
    fn a_png_with_no_name_is_still_a_png() {
        let png = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, // 签名
            0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', // IHDR 长度 + 类型
        ];
        assert_eq!(
            sniff(&png),
            Some(Magic { mime: "image/png", ext: "png" })
        );
    }

    /// 其余几家：PDF 要进内置阅读器，zip 插件包要过 `ends_with(".zip")`。
    #[test]
    fn recognises_the_types_that_gate_real_features() {
        assert_eq!(
            sniff(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"),
            Some(Magic { mime: "application/pdf", ext: "pdf" })
        );
        assert_eq!(
            sniff(&[0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
            Some(Magic { mime: "application/zip", ext: "zip" })
        );
        assert_eq!(
            sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F']),
            Some(Magic { mime: "image/jpeg", ext: "jpg" })
        );
        assert_eq!(
            sniff(b"GIF89a\x01\x00\x01\x00"),
            Some(Magic { mime: "image/gif", ext: "gif" })
        );
        assert_eq!(
            sniff(b"RIFF\x24\x00\x00\x00WEBPVP8 "),
            Some(Magic { mime: "image/webp", ext: "webp" })
        );
        // RIFF 的另一个孩子：WAVE 不能被当成 WebP
        assert_eq!(
            sniff(b"RIFF\x24\x00\x00\x00WAVEfmt "),
            Some(Magic { mime: "audio/wav", ext: "wav" })
        );
    }

    /// 文本那条兜底：`.md` / `.txt` 被剥掉名字之后也要进得来（它们有内置预览）。
    /// SVG 必须先于文本被认出来，否则 `image/svg+xml` 会被 `text/plain` 抢走。
    #[test]
    fn text_fallback_does_not_steal_svg() {
        assert_eq!(sniff(b"# hello\n"), Some(Magic { mime: "text/plain", ext: "txt" }));
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Some(Magic { mime: "image/svg+xml", ext: "svg" })
        );
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?>\n<svg width=\"1\"></svg>"),
            Some(Magic { mime: "image/svg+xml", ext: "svg" })
        );
        // XML 声明后面不是 <svg> ⇒ 只能算文本，不能谎称是图片
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?>\n<plist></plist>"),
            Some(Magic { mime: "text/plain", ext: "txt" })
        );
    }

    /// **不猜**：认不出来就 `None`。误判成图片的代价比"不知道"大得多
    /// （前端会拿 `<img>` 去渲染一个根本不是图片的东西）。
    #[test]
    fn unknown_bytes_stay_unknown_instead_of_guessing() {
        // 空文件
        assert_eq!(sniff(b""), None);
        // 二进制垃圾：含 NUL ⇒ 不算文本，也没有任何签名
        assert_eq!(sniff(&[0x00, 0x01, 0x02, 0x03]), None);
        // 带 UTF-16 BOM 的文本：含 NUL，按"不是文本"处理（今天的行为就是 octet-stream）
        assert_eq!(sniff(&[0xFF, 0xFE, b'h', 0x00]), None);
        // 裸帧同步字开头的数据**不算 MP3**（见 sniff 里那条注释：UTF-16 BOM 就长这样）
        assert_eq!(sniff(&[0xFF, 0xFB, 0x90, 0x00]), None);
        // BMP/TIFF 这类弱签名**故意不认**（见模块头注释）：退回 octet-stream，与今天一致
        assert_eq!(sniff(b"BM\x36\x00\x00\x00\x00\x00\x00\x00"), None);
        assert_eq!(sniff(&[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]), None);
    }

    /// 多字节字符被截断在末尾时仍然是文本（读 512 字节正好切在一个中文词中间是常事）。
    #[test]
    fn text_truncated_mid_character_is_still_text() {
        let mut s = "中文".repeat(200).into_bytes();
        s.truncate(HEAD_LEN);
        assert_eq!(head_text_kind(&s), Some("text/plain"));
    }

    fn head_text_kind(b: &[u8]) -> Option<&'static str> {
        sniff(b).map(|m| m.mime)
    }
}
