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
//! 跑之前先 `node scripts/fetch-pdfium.mjs` 取库（debug 构建会回退探测
//! `src-tauri/vendor/pdfium/<平台>/{bin,lib}`，两处都探——见 `pdfium_native::library_dir`）。
//!
//! ## 判据（第一版阈值，**改了就写进报告**）
//!
//! 1. 尺寸、字节数必须**完全相等**（不等直接判失败，不进像素比对）；
//! 2. **内容等价**：两张图都**归一成"白纸"**后，最大通道差 ≤ 8/255 且超阈像素占比 ≤ 0.5%。
//!
//! ## 为什么判据 2 要先归一（2026-09-18 决策 ②）
//!
//! AMD 在 Linux 实测：MuPDF 那条 `alpha=true`（未绘制区域**透明**），而 `pdfium-render` 默认
//! 先把位图刷成**不透明白** ⇒ 不归一直接比，两份渲染 **99.8% 像素不同**，内容差异被背景淹没
//! （归一后降到 1.2–7.6%）。产品侧已在源头处置：`pdfium_native` 用 `set_clear_color(全透明)`
//! 与 MuPDF 对齐（见该文件 `CLEAR_COLOR_TRANSPARENT`）。本测试**仍然**保留归一那一列，是**纵深**：
//! 万一预乘 alpha 的边缘仍有差，"内容是否等价"这个问题依然答得出来。
//!
//! ⚠️ 归一**必须连 alpha 一起置 255**——只改 RGB 会得到「透明白 (255,255,255,0)」，与
//! `(255,255,255,255)` 仍算不同，读数几乎不动（AMD 踩过：99.76% → 99.76%，差点得出"归一没用"）。
//!
//! 报告另出两列**不参与判失败**的读数：**原始（未归一）**的 max/超阈占比，以及**两边 alpha 不一致的
//! 像素占比**——后者是"未绘制区域语义差异"的直接度量，产品层还需要归一多少，看这一列。
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

/// 把"未绘制区域"（alpha < 255）**按白纸合成**，返回新缓冲；alpha 一并置 255。
///
/// 这是判据 2 的输入。合成用**直通 alpha** 的公式 `out = src + 白 × (1 - a)`：
/// - `a == 0`（真正要处理的那一类）时，预乘与直通**结果相同**，都是白——所以这一列是准的；
/// - `0 < a < 255`（抗锯齿边缘）时，若缓冲其实是**预乘**的，结果会偏亮 ⇒ 只是**近似**。
///   正因如此，背景语义差异不靠这一列下结论，而由 [`alpha_mismatch_ratio`] 单独报出来。
fn over_white(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for px in out.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 255 {
            continue;
        }
        for c in 0..3 {
            px[c] = (px[c] as u32 + 255 * (255 - a) / 255).min(255) as u8;
        }
        px[3] = 255;
    }
    out
}

/// 两边 **alpha 通道不一致**的像素占比 —— "未绘制区域语义差异"的直接度量（不参与判失败）。
fn alpha_mismatch_ratio(a: &[u8], b: &[u8]) -> f64 {
    let pixels = a.len() / 4;
    if pixels == 0 {
        return 0.0;
    }
    let bad = a
        .chunks_exact(4)
        .zip(b.chunks_exact(4))
        .filter(|(x, y)| x[3] != y[3])
        .count();
    bad as f64 / pixels as f64
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
        "\n{:<16} {:>11} {:>7} {:>9} {:>7} {:>9} {:>10}  {}",
        "样本", "尺寸", "原max", "原超阈", "归max", "归超阈", "alpha不等", "结论"
    );
    println!(
        "（原=未归一，归=归一白纸后；判失败只看「归」那一组，见文件头判据 2）"
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
                println!("{:<16} {:>11} {:>7} {:>9} {:>7} {:>9} {:>10}  ❌ {}", name, "-", "-", "-", "-", "-", "-", why.join(" / "));
                failures.push(msg);
                continue;
            }
        };

        let ((m_rgba, mw, mh), (p_rgba, pw, ph)) = (mr, pr);

        // 判据 1：尺寸必须完全相等。
        if (mw, mh) != (pw, ph) {
            let msg = format!("{name}: 尺寸不等 MuPDF={mw}×{mh} / PDFium={pw}×{ph}（不等就不进像素比对）");
            println!(
                "{:<16} {:>11} {:>7} {:>9} {:>7} {:>9} {:>10}  ❌ 尺寸不等 MuPDF={mw}×{mh} / PDFium={pw}×{ph}",
                name, "不等", "-", "-", "-", "-", "-"
            );
            failures.push(msg);
            continue;
        }

        // 落盘裸 RGBA，供人目视（PNG 转换见 tmp/fixture/rgba-to-png.mjs）。
        let _ = fs::write(out.join(format!("{name}.mupdf.rgba")), &m_rgba);
        let _ = fs::write(out.join(format!("{name}.pdfium.rgba")), &p_rgba);

        if m_rgba.len() != p_rgba.len() {
            let msg = format!("{name}: 尺寸相同但字节数不同 MuPDF={} / PDFium={}", m_rgba.len(), p_rgba.len());
            println!(
                "{:<16} {:>11} {:>7} {:>9} {:>7} {:>9} {:>10}  ❌ 字节数不匹配 {}",
                name,
                format!("{mw}×{mh}"),
                "-",
                "-",
                "-",
                "-",
                "-",
                format!("{} vs {}", m_rgba.len(), p_rgba.len())
            );
            failures.push(msg);
            continue;
        }

        // 判据 2：**归一白纸后**的内容等价（硬判据）；原始与 alpha 两列只报告。
        let (raw_max, raw_over) = diff_stats(&p_rgba, &m_rgba);
        let m_norm = over_white(&m_rgba);
        let p_norm = over_white(&p_rgba);
        let (max_diff, over_ratio) = diff_stats(&p_norm, &m_norm);
        let alpha_bad = alpha_mismatch_ratio(&p_rgba, &m_rgba);

        let ok = max_diff <= MAX_CHANNEL_DIFF && over_ratio <= MAX_OVER_RATIO;
        let raw_ok = raw_max <= MAX_CHANNEL_DIFF && raw_over <= MAX_OVER_RATIO;
        let conclusion = if !ok {
            "❌ 内容不等价"
        } else if !raw_ok {
            "✅ 仅背景语义差"
        } else {
            "✅"
        };
        println!(
            "{:<16} {:>11} {:>7} {:>8.3}% {:>7} {:>8.3}% {:>9.3}%  {}",
            name,
            format!("{mw}×{mh}"),
            raw_max,
            raw_over * 100.0,
            max_diff,
            over_ratio * 100.0,
            alpha_bad * 100.0,
            conclusion
        );
        if !ok {
            failures.push(format!(
                "{name}: 归一白纸后 最大通道差 {max_diff}（限 {MAX_CHANNEL_DIFF}）/ 超阈占比 {:.3}%（限 {:.3}%）\
                 ｜参考：原始 {raw_max} / {:.3}%，alpha 不一致 {:.3}%",
                over_ratio * 100.0,
                MAX_OVER_RATIO * 100.0,
                raw_over * 100.0,
                alpha_bad * 100.0
            ));
        } else if !raw_ok {
            println!(
                "  ⚠️ {name}: **内容等价**，但原始读数未达标 —— 差异在未绘制区域语义（alpha 不一致 {:.3}%）。\
                 产品侧靠 `pdfium_native::CLEAR_COLOR_TRANSPARENT`（清屏全透明）对齐；\
                 若这一列仍显著，请在**暗色 + 护眼四档**真机目视后再切默认。",
                alpha_bad * 100.0
            );
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
