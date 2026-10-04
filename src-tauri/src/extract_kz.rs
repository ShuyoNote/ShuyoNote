//! **P0 格式引擎**：用 Kreuzberg（v4.10.x，MIT ✓）抽文本（2026-10-02）。
//!
//! ## 它补的是什么
//! 本仓既有的 TS 抽取链（`src/lib/extract/`）吃不下 `eml／msg／zip／7z／gz／rtf／odt／epub／
//! 学术格式` 那一类（实测：对它们**无读数** ✗）；这一层把这些补上 ✓。
//! ⛔ **不重复**：`pdf`（本仓有自己的 PDFium ✓）／图片 OCR（本仓有 tesseract ＋ chi_sim ✓）／
//! 分块（那是 `src/lib/extract/chunk.ts` 的活 ✓）。
//!
//! ## 边界（谁写派生表）
//! ⛔ 这条命令**只返回文本** ✗ —— **不碰** `attachment_text` / `chunks`。
//! 派生表的写入者仍然只有 TS 那条链 ✓（门禁 `check-derived-writers` 守的就是这一条 ✓）。
//!
//! ## 版本口径
//! 特性集在 `Cargo.toml` 里**钉死** `=4.10.4` 且**不含 `chunking`** ✓（含它会与
//! `boa_engine` 的 icu 依赖**互斥**、cargo 直接无解 ✗，实测 ✓）。理由写在 `Cargo.toml` 那段注释里 ✓。

#[derive(serde::Serialize)]
pub struct KzText {
    /// 抽出来的纯文本 ✓（由 TS 侧决定怎么切块、怎么写派生表 ✓）。
    pub text: String,
    pub chars: usize,
    pub ms: u64,
    /// 哪个引擎抽的 ✓（写进派生表旁边能对得上账 ✓）。
    pub engine: &'static str,
}

const ENGINE: &str = "kreuzberg-4.10.4";

/// ⚠️⚠️ **2026-10-02 真机端到端抓到的缺陷（必须记住）**：
/// `extract_bytes_sync(bytes, mime)` 当 mime 是**泛型**（`application/octet-stream` / 空）
/// **不做格式嗅探** ⇒ 它退回"**纯文本**" ⇒ **把整份原文吐出来** ✓
/// 实测：同一个 `.eml`，`message/rfc822` ⇒ **3,171 字符**（正确 ✓），
/// `application/octet-stream` ⇒ **99,717 字符 / 1,288 行**（＝原始字节数 ✗）。
/// ⚠️ 而附件入库时 `.eml` 拿到的正是 `application/octet-stream`
/// （`attachments.rs` 的 `mime_from_path` 表里**没有 eml** ✗）⇒ 于是**垃圾进了知识库** ✓
/// —— 而且它**看起来"成功"** ✗，比"抽不了"更糟 ✓。
///
/// ⇒ 所以这里**不信调用方给的泛 MIME** ✗：按**文件名扩展名**把它补成一个具体 MIME ✓；
///   补不出来就**如实拒收**（让抽取层映射成 `provider_error` ✓），
///   ⛔ **绝不把"纯文本兜底"的结果当成功返回** ✗。
fn mime_for(bytes_mime: &str, filename: &str) -> Option<String> {
    let m = bytes_mime.trim().to_ascii_lowercase();
    let generic = m.is_empty() || m == "application/octet-stream" || m == "binary/octet-stream";
    if !generic {
        return Some(m);
    }
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let inferred = match ext.as_str() {
        "eml" => "message/rfc822",
        "msg" => "application/vnd.ms-outlook",
        "rtf" => "application/rtf",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "epub" => "application/epub+zip",
        "tex" | "latex" => "application/x-tex",
        "bib" => "application/x-bibtex",
        "ris" => "application/x-research-info-systems",
        // ⚠️ 认不出 ⇒ **不猜** ✗（猜错的代价是"把二进制当文本写进库" ✓，比拒收坏得多 ✓）
        _ => return None,
    };
    Some(inferred.to_string())
}

/// 用 Kreuzberg 抽**一段字节**的文本（抽取层唯一的入口 ✓）。
///
/// ⚠️ **为什么收 bytes 而不是路径**：本仓抽取层的 `ExtractInput` 是
/// `{ bytes, filename, mime, hash, deps }` —— **手上只有字节，没有路径** ✓
/// （见 `src/lib/extract/types.ts`）⇒ 契约对齐字节这一侧 ✓。
/// ⚠️ IPC 传 **base64**（字节数组会被序列化成上千万字符的 JSON ✗），
/// 解码器与落盘命令**共用同一份**（`abilities::base64_decode` ✓，⛔ 不写第二份 ✗）。
/// ⚠️ **不做任何写盘** ✓：读字节、抽文本、返回 ✓。派生表仍由 TS 那条链写 ✓。
#[tauri::command]
pub fn extract_with_kreuzberg(
    base64: String,
    mime: String,
    filename: String,
) -> Result<KzText, String> {
    let bytes = crate::abilities::base64_decode(&base64)?;
    if bytes.is_empty() {
        return Err("内容是空的 ⇒ 不抽".into());
    }
    // ⚠️ 泛型 MIME 不许原样下传 ✗（否则 Kreuzberg 退回纯文本、把原文整份吐出来 ✓ —— 见 `mime_for`）
    let Some(mime_used) = mime_for(&mime, &filename) else {
        return Err(format!(
            "MIME 是泛型（{mime}）且扩展名认不出（{filename}）⇒ **如实拒收**，\
             不把'纯文本兜底'的结果当成功（那会把二进制写进知识库 ✓）"
        ));
    };
    let started = std::time::Instant::now();
    let cfg = kreuzberg::ExtractionConfig::default();
    match kreuzberg::extract_bytes_sync(&bytes, &mime_used, &cfg) {
        Ok(r) => Ok(KzText {
            chars: r.content.chars().count(),
            text: r.content,
            ms: started.elapsed().as_millis() as u64,
            engine: ENGINE,
        }),
        // ⚠️ 失败**照实回**：不吞成空字符串 ✗（前端/抽取层才有机会说"这个格式读不了" ✓）。
        Err(e) => Err(format!("{e}").replace(['\n', '\r'], " ")),
    }
}

#[cfg(test)]
mod tests {
    use super::mime_for;

    /// ⭐ 这一条就是 **2026-10-02 真机端到端抓到那个缺陷**的判据：
    /// 泛型 MIME ＋ `.eml` 若不补成 `message/rfc822`，Kreuzberg 会退回纯文本、
    /// **把整份原文吐出来**（实测 3,171 → 99,717 字符 ✗），而它**看起来是成功的** ✓。
    #[test]
    fn generic_mime_is_inferred_from_extension_and_unknown_is_refused() {
        // 具体 MIME ⇒ 原样用（小写归一 ✓）
        assert_eq!(
            mime_for("Message/RFC822", "x.eml").as_deref(),
            Some("message/rfc822")
        );
        // ⭐ 泛型三种 ⇒ 按**文件名扩展名**补（`.eml` 是实测那个 ✓）
        for g in ["application/octet-stream", "binary/octet-stream", "  ", ""] {
            assert_eq!(
                mime_for(g, "中国农业银行信用卡电子对账单.eml").as_deref(),
                Some("message/rfc822"),
                "泛型 {g:?} 应当按扩展名补出来"
            );
        }
        // 缺口那一族都能补 ✓
        assert_eq!(mime_for("", "x.zip").as_deref(), Some("application/zip"));
        assert_eq!(mime_for("", "x.epub").as_deref(), Some("application/epub+zip"));
        assert_eq!(mime_for("", "x.tex").as_deref(), Some("application/x-tex"));
        // ⛔ 认不出 ⇒ **拒收**（宁可不抽，也不把二进制当文本写进库 ✓）
        assert!(mime_for("application/octet-stream", "x.unknown").is_none());
        assert!(mime_for("application/octet-stream", "noext").is_none());
        assert!(mime_for("application/octet-stream", "").is_none());
    }
}
