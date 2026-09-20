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
//! ## 判据（第二版，2026-09-18 按 AMD 的 Linux 实测修正；**改了就写进报告**）
//!
//! 1. 尺寸、字节数必须**完全相等**（不等直接判失败，不进像素比对）；
//! 2. **颜色等价**：三个颜色通道（R/G/B，**不含 alpha**）的逐像素最大差 ≤ 8/255，
//!    且"任一颜色通道差 > 8"的**像素**占比 ≤ 0.5%。
//!
//! ### 第一版错在哪（AMD 在 Linux 上定位，`reply-6`）
//!
//! 第一版用 `diff_stats` **逐字节**比 RGB**A** 四个通道 ⇒ 把 **alpha 也塞进了"最大通道差"**，
//! 于是**两份渲染的 RGB 逐像素完全相同**（`text` / `rotate90`：**最大 RGB 差 = 0**，
//! 四份样本"RGB 差 > 8 的像素"**全为 0**）也被判红；差异**全部**来自字形边缘的 alpha
//! （最大到 240 —— 两个光栅化器的抗锯齿边缘不可能逐位一致）。
//! 附带两个口径错误：**(a)** "超阈占比"按**字节**算，把占比放大约 4 倍；**(b)** 第一版还叠了
//! "归一白纸"那一列当作**硬判据** —— 而把不同的 alpha 合成到白底，恰恰会**制造**出 RGB 差，
//! 让本该通过的样本变红（**负灵敏**）。⇒ 第二版：**判据只看 RGB、按像素统计**，
//! alpha 与背景语义**只报告不判失败**（见下）。
//!
//! ### alpha 为什么不算失败（但要报出来）
//!
//! - `alpha_max` / `alpha_over`：字形边缘抗锯齿差异，**预期存在**，两个引擎不可能一致；
//! - `语义不一致`（一边 a=0、另一边 a=255 的像素占比）：**未绘制区域语义**的直接度量。
//!   产品侧已在源头对齐（`pdfium_native::CLEAR_COLOR_TRANSPARENT` 把清屏色设成全透明，
//!   与 MuPDF 的 `alpha=true` 同语义）⇒ 这一列**应当很小**；若它显著，说明对齐没生效，
//!   ⚠️ 那是**人工决策**（真机看暗色 + 护眼四档），不是让机器自动判红。
//!
//! ⚠️ **阈值全过也必须人工目视**：PNG 落盘后由人看一眼——「能显示但不对」（颜色错乱、
//! 字体替换、透明底变黑）**正是阈值抓不住的那类**。

use std::fs;
use std::path::PathBuf;

/// 对拍用的缩放倍率（与前端默认一致更贴近真实使用）。
const SCALE: f32 = 1.5;
/// 单通道允许的最大差（**只看 R/G/B**，见文件头判据 2）。
const MAX_CHANNEL_DIFF: u8 = 8;
/// 允许的超阈**像素**占比。
const MAX_OVER_RATIO: f64 = 0.005;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("pdf")
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("pdf-compare")
}

/// 两张等长 RGBA 缓冲的差异，**全部按像素统计**（按字节算会把占比放大约 4 倍）。
#[derive(Debug, Default)]
struct PixelDiff {
    /// R/G/B 三个通道里的最大绝对差（**不含 alpha** ⇒ 硬判据看它）。
    rgb_max: u8,
    /// "任一颜色通道差 > `MAX_CHANNEL_DIFF`"的**像素**占比 ⇒ 硬判据看它。
    rgb_over: f64,
    /// alpha 通道的最大绝对差（**只报告**：字形边缘抗锯齿的预期差异）。
    alpha_max: u8,
    /// "alpha 差 > `MAX_CHANNEL_DIFF`"的**像素**占比（只报告）。
    alpha_over: f64,
    /// **未绘制区域语义差异**：一边 `a = 0`、另一边 `a = 255` 的**像素**占比（只报告）。
    ///
    /// 产品侧已把两条路的清屏语义对齐（`pdfium_native::CLEAR_COLOR_TRANSPARENT`）⇒ 这一列应当很小。
    alpha_semantics: f64,
    /// 两边**都**完全透明（`a = 0`）的像素占比 —— 让人一眼看出"背景确实是透明的"。
    both_clear: f64,
}

fn pixel_diff(a: &[u8], b: &[u8]) -> PixelDiff {
    let mut d = PixelDiff::default();
    let pixels = a.len() / 4;
    if pixels == 0 {
        return d;
    }
    let mut rgb_over = 0usize;
    let mut alpha_over = 0usize;
    let mut semantics = 0usize;
    let mut both_clear = 0usize;
    for (x, y) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let mut worst_rgb = 0u8;
        for c in 0..3 {
            worst_rgb = worst_rgb.max(x[c].abs_diff(y[c]));
        }
        if worst_rgb > d.rgb_max {
            d.rgb_max = worst_rgb;
        }
        if worst_rgb > MAX_CHANNEL_DIFF {
            rgb_over += 1;
        }

        let da = x[3].abs_diff(y[3]);
        if da > d.alpha_max {
            d.alpha_max = da;
        }
        if da > MAX_CHANNEL_DIFF {
            alpha_over += 1;
        }
        if x[3] == 0 && y[3] == 0 {
            both_clear += 1;
        } else if (x[3] == 0 && y[3] == 255) || (x[3] == 255 && y[3] == 0) {
            semantics += 1;
        }
    }
    let n = pixels as f64;
    d.rgb_over = rgb_over as f64 / n;
    d.alpha_over = alpha_over as f64 / n;
    d.alpha_semantics = semantics as f64 / n;
    d.both_clear = both_clear as f64 / n;
    d
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
    // ⚠️ 库不在 ⇒ **响亮自报跳过**，不是判红。因为那份二进制**不入 git**（`vendor/pdfium/` 被
    //    ignore），新克隆/worktree/CI 上都可能没有；把它算成"代码红了"，会让真正的回归淹没在
    //    "缺个开发期文件"里。CI 的 rust job 有取库步骤 ⇒ 那边会**真跑**这一项。
    if let Err(why) = crate::pdfium_native::library_preflight() {
        println!("! 跳过 P3 对拍：{why}");
        return;
    }
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
        "\n{:<16} {:>11} {:>6} {:>9} {:>6} {:>9} {:>10} {:>9}  {}",
        "样本", "尺寸", "RGB差", "RGB超阈", "A差", "A超阈", "语义不一致", "双透明", "结论"
    );
    println!(
        "（RGB 那两列**按像素**统计、是硬判据；A/语义/双透明四列只报告，理由见文件头判据 2）"
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
                println!("{:<16} {:>11} {:>6} {:>9} {:>6} {:>9} {:>10} {:>9}  ❌ {}", name, "-", "-", "-", "-", "-", "-", "-", why.join(" / "));
                failures.push(msg);
                continue;
            }
        };

        let ((m_rgba, mw, mh), (p_rgba, pw, ph)) = (mr, pr);

        // 判据 1：尺寸必须完全相等。
        if (mw, mh) != (pw, ph) {
            let msg = format!("{name}: 尺寸不等 MuPDF={mw}×{mh} / PDFium={pw}×{ph}（不等就不进像素比对）");
            println!(
                "{:<16} {:>11} {:>6} {:>9} {:>6} {:>9} {:>10} {:>9}  ❌ 尺寸不等 MuPDF={mw}×{mh} / PDFium={pw}×{ph}",
                name, "不等", "-", "-", "-", "-", "-", "-"
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
                "{:<16} {:>11} {:>6} {:>9} {:>6} {:>9} {:>10} {:>9}  ❌ 字节数不匹配 {}",
                name,
                format!("{mw}×{mh}"),
                "-",
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

        // 判据 2：**只看 R/G/B、按像素统计**（理由见文件头"第一版错在哪"）。
        let d = pixel_diff(&p_rgba, &m_rgba);

        // ★ **两类样本**（2026-09-20 补中文/扫描件时分的类）：
        //   · 硬判据（默认）：颜色必须等价 —— 适用于"渲染结果**应当**逐像素一致"的样本；
        //   · **只报不判**（`cjk*`）：**没有嵌入字体**的中文样本，两个引擎各自做字体替换
        //     ⇒ 字形本来就不同，把它判红等于判一件**做不到**的事。它回答的是另一个问题：
        //     **两个引擎都能开、尺寸一致、都画出了东西**（"能显示但不对"的第一道筛），
        //     字形差异**如实报出来**给人看。
        // ⚠️ 这不是"给红样本开后门"：`scan.pdf`（图像流）走的就是**硬判据**；
        //    若哪天 `cjk.pdf` 变成"嵌入了字体的样本"，就该把它挪回硬判据那一类。
        //
        // ★ **实测（2026-09-20，WSL2 Ubuntu；装了 msyh/simsun 前后各跑一次，数字一字不变）**：
        //   两家的画法**根本不同**，而且**不是"本机缺中文字体"造成的**（`fc-list` 装字体前后
        //   都是 MuPDF 28000 / PDFium 27000）：
        //   · MuPDF 28000 = 蓝矩形 300×90=27000 + **文字 1000**：把 2 字节码**按单字节**喂给它
        //     自己的回退字体 ⇒ 画出拉丁乱码（`<4E2D65876D4B8BD5>` 渲染成 "N-e mK"）；
        //   · PDFium 27000 = **正好等于那个蓝矩形的面积**⇒ **整行文字一个像素都没画**
        //     （墨迹包围盒的顶边就是矩形顶边，文字区域全透明）。
        //   即：**非嵌入 CID 字体**这条路径上，两家都不可信、不可信的方式还不一样 ⇒ 只能只报不判。
        //   ⚠️ 这条也是 **P5 的风险项，但风险面比一开始以为的小**：同一份 `cjk.pdf` 在
        //   **Windows 的 PDFium** 上**画对了**（墨迹 28816、正确「中文测试」；证据包
        //   `ShuyoNote-collab/pdfium-p3/visual-check-cjk/`）⇒ 分叉在**平台/库**，不在样本、
        //   也不在我们的包装。仍欠两份读数：**macOS 上的 PDFium**、**Windows/macOS 上的 MuPDF**。
        let report_only = name.starts_with("cjk");

        let ok = d.rgb_max <= MAX_CHANNEL_DIFF && d.rgb_over <= MAX_OVER_RATIO;
        let conclusion = if report_only {
            // 非空白自检：两边都必须**画出东西**（全透明 = 那个引擎根本没能渲染这个样本）
            let m_ink = m_rgba.chunks_exact(4).filter(|p| p[3] != 0).count();
            let p_ink = p_rgba.chunks_exact(4).filter(|p| p[3] != 0).count();
            if m_ink == 0 || p_ink == 0 {
                failures.push(format!(
                    "{name}: 只报不判那一类也要求「两边都画出东西」，实际 MuPDF 非透明像素 {m_ink} / PDFium {p_ink}"
                ));
                "❌ 有一边是空白".to_string()
            } else {
                format!("📋 只报不判（非透明像素 MuPDF {m_ink} / PDFium {p_ink}）")
            }
        } else if ok {
            "✅".to_string()
        } else {
            "❌ 颜色不等价".to_string()
        };
        println!(
            "{:<16} {:>11} {:>6} {:>8.3}% {:>6} {:>8.3}% {:>9.3}% {:>8.3}%  {}",
            name,
            format!("{mw}×{mh}"),
            d.rgb_max,
            d.rgb_over * 100.0,
            d.alpha_max,
            d.alpha_over * 100.0,
            d.alpha_semantics * 100.0,
            d.both_clear * 100.0,
            conclusion
        );
        if !ok && !report_only {
            failures.push(format!(
                "{name}: RGB 最大差 {}（限 {MAX_CHANNEL_DIFF}）/ \"RGB 差 > {MAX_CHANNEL_DIFF}\" 的像素占比 {:.3}%（限 {:.3}%）\
                 ｜参考：alpha 最大差 {}、alpha 超阈 {:.3}%、语义不一致 {:.3}%",
                d.rgb_max,
                d.rgb_over * 100.0,
                MAX_OVER_RATIO * 100.0,
                d.alpha_max,
                d.alpha_over * 100.0,
                d.alpha_semantics * 100.0
            ));
        } else if !report_only && d.alpha_semantics > MAX_OVER_RATIO {
            // 颜色过了，但"一边透明一边不透明"的像素偏多 ⇒ 未绘制区域语义没对齐。
            // ⚠️ 这一列**故意不判失败**：它对应的是"真机看暗色 + 护眼四档"那个人工决策。
            println!(
                "  ⚠️ {name}: 颜色等价，但**未绘制区域语义**不一致 {:.3}%（限 {:.3}%）——\
                 两条路的清屏色没对齐（产品侧见 `pdfium_native::CLEAR_COLOR_TRANSPARENT`），\
                 请真机看**暗色 + 护眼四档**后再切默认。",
                d.alpha_semantics * 100.0,
                MAX_OVER_RATIO * 100.0
            );
        }
        if d.alpha_over > 0.05 {
            // 纯提示：字形边缘 alpha 差异通常 > 5%（两个光栅化器的抗锯齿边缘不可能逐位一致）。
            println!(
                "  ℹ️ {name}: alpha 超阈像素 {:.3}%（最大差 {}）—— 预期来自字形边缘抗锯齿，不计入判据。",
                d.alpha_over * 100.0,
                d.alpha_max
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

/// 判据本身的单测 —— 纯函数，不需要两个引擎（因此**这几条在 Windows 也编得过**，
/// 但**跑**仍然要 AMD(WSL2)/Mac，见文件头）。
///
/// ⚠️ 这一组是给"第一版口径错误"立的**回归闸**：`alpha_only_difference_...` 那条
/// 就是 AMD 在 Linux 上量到的真实情形（RGB 逐像素相同、只有边缘 alpha 不同）——
/// 第一版口径会让它判红，现在必须绿。
#[cfg(test)]
mod tests {
    use super::*;

    fn buf(pixels: &[[u8; 4]]) -> Vec<u8> {
        pixels.iter().flatten().copied().collect()
    }

    const P: [u8; 4] = [10, 20, 30, 255];

    #[test]
    fn identical_buffers_have_no_difference() {
        let a = buf(&[P, P, P]);
        let d = pixel_diff(&a, &a);
        assert_eq!(d.rgb_max, 0);
        assert_eq!(d.rgb_over, 0.0);
        assert_eq!(d.alpha_max, 0);
        assert_eq!(d.alpha_over, 0.0);
        assert_eq!(d.alpha_semantics, 0.0);
        assert_eq!(d.both_clear, 0.0);
    }

    #[test]
    fn rgb_difference_is_counted_per_channel_and_per_pixel() {
        // 两个像素，一个通道差 9（超阈）、另一个完全相同 ⇒ 占比 **1/2 按像素**
        // （按字节会算成 1/8 —— 这条断言就是防口径退化的）。
        let a = buf(&[P, P]);
        let b = buf(&[[19, 20, 30, 255], P]);
        let d = pixel_diff(&a, &b);
        assert_eq!(d.rgb_max, 9);
        assert_eq!(d.rgb_over, 0.5);
        assert_eq!(d.alpha_max, 0);
        assert_eq!(d.alpha_over, 0.0);
    }

    #[test]
    fn alpha_only_difference_must_not_trip_the_rgb_criterion() {
        // ★ AMD 在 Linux 量到的真实情形：RGB 逐像素相同，差异全在字形边缘 alpha（最大到 240）。
        let a = buf(&[P, P]);
        let b = buf(&[[10, 20, 30, 15], P]);
        let d = pixel_diff(&a, &b);
        assert_eq!(d.rgb_max, 0, "RGB 相同 ⇒ 硬判据必须**不**红");
        assert_eq!(d.rgb_over, 0.0);
        assert_eq!(d.alpha_max, 240);
        assert_eq!(d.alpha_over, 0.5);
        assert_eq!(d.alpha_semantics, 0.0, "15 不是 0/255 的翻转，不算语义不一致");
    }

    #[test]
    fn background_semantics_needs_full_transparent_against_full_opaque() {
        let a = buf(&[[0, 0, 0, 0], [0, 0, 0, 0]]);
        let b = buf(&[[255, 255, 255, 255], [0, 0, 0, 0]]);
        let d = pixel_diff(&a, &b);
        assert_eq!(d.alpha_semantics, 0.5);
        assert_eq!(d.both_clear, 0.5);
        // 顺带说明：背景语义翻转在 RGB 上**也会**显现（这里是"黑透明 vs 白不透明"）⇒
        // 硬判据会红，而 alpha 那几列负责解释**为什么**红。两者不冲突。
        assert!(d.rgb_max > MAX_CHANNEL_DIFF);
    }

    #[test]
    fn empty_buffers_do_not_divide_by_zero() {
        let d = pixel_diff(&[], &[]);
        assert_eq!(d.rgb_max, 0);
        assert_eq!(d.rgb_over, 0.0);
        assert_eq!(d.alpha_semantics, 0.0);
    }
}
