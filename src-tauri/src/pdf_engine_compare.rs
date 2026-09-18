//! PDFium ↔ MuPDF **对拍**（P3，2026-09-17 开工）。
//!
//! 方案 §4 的验收第 1、2 条（渲染等价 / 性能不退化）在这里落成**可执行的判据**；
//! 施工单见 `docs/plans/2026-09-17-pdfium-p3-compare-workorder.md`。
//!
//! ## 为什么是 crate 内的 `#[cfg(test)]` 而不是 `tests/*.rs`
//!
//! `pdf_native` / `pdfium_native` 都是**私有模块**，集成测试**够不到**它们。
//!
//! ## 为什么 Rust 侧不加任何依赖
//!
//! 两个引擎的输出**本来就都是裸 RGBA** ⇒ 比对用 `std` 就够；落盘也写**裸 RGBA**，
//! 要给人看时用 `node tmp/fixture/rgba-to-png.mjs <in.rgba> <w> <h> <out.png>` 转 PNG。
//!
//! ## ⚠️ 它在本机（Windows）**跑不了**
//!
//! `cargo test` 在本机是 `0xC0000139` ⇒ 本文件只能在 **AMD(WSL2) / Mac** 上执行。
//! Windows 侧只负责保证它**编得过**（`cargo check --tests`）。
//! 跑之前先 `node scripts/fetch-pdfium.mjs` 取库（debug 构建会回退到 `src-tauri/vendor/pdfium/<平台>/bin`）。
//!
//! ## 判据（第一版阈值，**改了就写进报告**）
//!
//! 1. 尺寸必须**完全相等**（不等直接判失败，不进像素比对）；
//! 2. 逐像素**最大通道差 ≤ 8**/255；
//! 3. **超阈像素占比 ≤ 0.5%**。
//!
//! ⚠️ **阈值全过也必须人工目视**：PNG 落盘后由人看一眼——「能显示但不对」（颜色错乱、
//! 字体替换、透明底变黑）**正是阈值抓不住的那类**。

use std::fs;
use std::path::PathBuf;

/// 对拍用的缩放倍率（与前端默认一致更贴近真实使用）。
const SCALE: f32 = 1.5;
/// 单通道允许的最大差。
const MAX_CHANNEL_DIFF: u8 = 8;
/// 允许的超阈像素占比。
const MAX_OVER_RATIO: f64 = 0.005;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("pdf")
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("pdf-compare")
}

/// 两个等长缓冲的（最大单通道差, 超阈占比）。
fn diff_stats(a: &[u8], b: &[u8]) -> (u8, f64) {
    let mut max_diff = 0u8;
    let mut over = 0usize;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = x.abs_diff(*y);
        if d > max_diff {
            max_diff = d;
        }
        if d > MAX_CHANNEL_DIFF {
            over += 1;
        }
    }
    let ratio = if b.is_empty() { 0.0 } else { over as f64 / b.len() as f64 };
    (max_diff, ratio)
}

/// 用 MuPDF 渲一页，**归一成紧凑 RGBA**（它输出带行填充的缓冲，要走 `compact_rgba`）。
fn render_mupdf(key: &str, bytes: &[u8]) -> Result<(Vec<u8>, usize, usize), String> {
    let (rgba, w, h, stride) = unsafe { crate::pdf_native::render_page(key, bytes, 0, SCALE) }?;
    Ok((crate::pdf_native::compact_rgba(&rgba, w, h, stride)?, w, h))
}

/// 用 PDFium 渲一页（它**本来就输出紧凑 RGBA**）。
fn render_pdfium(key: &str, bytes: &[u8]) -> Result<(Vec<u8>, usize, usize), String> {
    crate::pdfium_native::render_page_owned(key, bytes.to_vec(), 0, SCALE)
}

#[test]
fn pdfium_matches_mupdf_on_fixtures() {
    let dir = fixtures_dir();
    let out = out_dir();
    fs::create_dir_all(&out).expect("建对拍输出目录");

    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("读不到样本目录 {}：{e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "pdf").unwrap_or(false))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "样本目录为空：{}（先跑 node scripts/make-pdf-fixtures.mjs）", dir.display());

    println!(
        "\n{:<16} {:>12} {:>12} {:>7} {:>10}  {}",
        "样本", "MuPDF", "PDFium", "最大差", "超阈占比", "结论"
    );

    let mut failures: Vec<String> = Vec::new();

    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let bytes = fs::read(path).expect("读样本失败");

        // ⚠️ 两个引擎用**不同的 cache_key**：同一个 key 会让两套缓存互相干扰，
        // 那是 `commands.rs` 分派层要用 `forget()` 处理的事，不该混进对拍结论里。
        let mupdf = render_mupdf(&format!("{name}#mupdf"), &bytes);
        let pdfium = render_pdfium(&format!("{name}#pdfium"), &bytes);

        let (mr, pr) = match (mupdf, pdfium) {
            (Ok(m), Ok(p)) => (m, p),
            (m, p) => {
                let mut why = Vec::new();
                if let Err(e) = m {
                    why.push(format!("MuPDF 渲染失败：{e}"));
                }
                if let Err(e) = p {
                    why.push(format!("PDFium 渲染失败：{e}"));
                }
                let msg = format!("{name}: {}", why.join(" / "));
                println!("{:<16} {:>12} {:>12} {:>7} {:>10}  ❌ {}", name, "-", "-", "-", "-", why.join(" / "));
                failures.push(msg);
                continue;
            }
        };

        let ((m_rgba, mw, mh), (p_rgba, pw, ph)) = (mr, pr);

        // 判据 1：尺寸必须完全相等。
        if (mw, mh) != (pw, ph) {
            let msg = format!("{name}: 尺寸不等 MuPDF={mw}×{mh} / PDFium={pw}×{ph}（不等就不进像素比对）");
            println!("{:<16} {:>12} {:>12} {:>7} {:>10}  ❌ 尺寸不等", name, format!("{mw}×{mh}"), format!("{pw}×{ph}"), "-", "-");
            failures.push(msg);
            continue;
        }

        // 落盘裸 RGBA，供人目视（PNG 转换见 tmp/fixture/rgba-to-png.mjs）。
        let _ = fs::write(out.join(format!("{name}.mupdf.rgba")), &m_rgba);
        let _ = fs::write(out.join(format!("{name}.pdfium.rgba")), &p_rgba);

        if m_rgba.len() != p_rgba.len() {
            let msg = format!("{name}: 尺寸相同但字节数不同 MuPDF={} / PDFium={}", m_rgba.len(), p_rgba.len());
            println!("{:<16} {:>12} {:>12} {:>7} {:>10}  ❌ 字节数不匹配", name, format!("{mw}×{mh}"), format!("{pw}×{ph}"), "-", "-");
            failures.push(msg);
            continue;
        }

        // 判据 2、3。
        let (max_diff, over_ratio) = diff_stats(&p_rgba, &m_rgba);
        let ok = max_diff <= MAX_CHANNEL_DIFF && over_ratio <= MAX_OVER_RATIO;
        println!(
            "{:<16} {:>12} {:>12} {:>7} {:>9.3}%  {}",
            name,
            format!("{mw}×{mh}"),
            format!("{pw}×{ph}"),
            max_diff,
            over_ratio * 100.0,
            if ok { "✅" } else { "❌ 超阈" }
        );
        if !ok {
            failures.push(format!(
                "{name}: 最大通道差 {max_diff}（限 {MAX_CHANNEL_DIFF}）/ 超阈占比 {:.3}%（限 {:.3}%）",
                over_ratio * 100.0,
                MAX_OVER_RATIO * 100.0
            ));
        }
    }

    println!(
        "\n⚠️ 阈值全过也请**人工目视** {} 下的 PNG/RGBA：能显示但不对（颜色错乱/字体替换/透明底变黑）是阈值抓不住的那类。",
        out.display()
    );

    assert!(
        failures.is_empty(),
        "对拍未通过（{} 项）：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
}
