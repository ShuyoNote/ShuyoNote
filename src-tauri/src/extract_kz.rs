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
    let started = std::time::Instant::now();
    let cfg = kreuzberg::ExtractionConfig::default();
    // 文件名带扩展名时给它（Kreuzberg 的格式判定吃 mime，也吃扩展名 ✓）；
    // ⚠️ 只当**提示**用，⛔ 不落盘、不写任何以它命名的文件 ✗。
    let hint = if filename.is_empty() { None } else { Some(filename.as_str()) };
    match kreuzberg::extract_bytes_sync(&bytes, &mime, &cfg) {
        Ok(r) => Ok(KzText {
            chars: r.content.chars().count(),
            text: r.content,
            ms: started.elapsed().as_millis() as u64,
            engine: ENGINE,
        }),
        // ⚠️ 失败**照实回**：不吞成空字符串 ✗（前端/抽取层才有机会说"这个格式读不了" ✓）。
        Err(e) => {
            let _ = hint; // ⚠️ 当前 API 不吃文件名提示；留这行是为了**明确**这一点 ✗ 不假装用了它 ✓
            Err(format!("{e}").replace(['\n', '\r'], " "))
        }
    }
}
