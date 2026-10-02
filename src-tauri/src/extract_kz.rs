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

/// 用 Kreuzberg 抽一个文件的文本。
/// ⚠️ **不做任何写盘** ✓：读文件、抽文本、返回 ✓。落盘/入库由 TS 侧那一条链负责 ✓。
#[tauri::command]
pub fn extract_with_kreuzberg(path: String) -> Result<KzText, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("不是文件（或读不到）：{path}"));
    }
    let started = std::time::Instant::now();
    let cfg = kreuzberg::ExtractionConfig::default();
    match kreuzberg::extract_file_sync(p, None, &cfg) {
        Ok(r) => Ok(KzText {
            chars: r.content.chars().count(),
            text: r.content,
            ms: started.elapsed().as_millis() as u64,
            engine: ENGINE,
        }),
        // ⚠️ 失败**照实回**：不吞成空字符串 ✗（前端才有机会说"这个格式读不了" ✓）。
        Err(e) => Err(format!("{e}").replace(['\n', '\r'], " ")),
    }
}
