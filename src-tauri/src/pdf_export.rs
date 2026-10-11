// ⭐ 2026-10-11（owner：「导出 pdf 时页头页脚去掉，只留页码」）：⭐ **Rust 那半步** ✗。
//!
//! ## 为什么必须有这一半
//! ⭐ 实测（`office-import` 的读数 ＋ Lead 复核 ✓）：⭐ 现在导出走的是 `src/lib/print.ts` 的
//! 隐藏 iframe ＋ ⭐ **无参 `win.print()`** ✓ ⇒ ⭐ 页头页脚（⭐ 日期／标题／URL／页码 ✓）是
//! **打印引擎自己加的** ✗ ⇒ ⭐ 那个「页眉和页脚」开关是**一整块** ✓：⭐ 关掉 ⇒ ⭐ **连页码一起没** ✓，
//! ⭐ 而页面**没有** API 能"⭐ 只留页码 ✗" ✓（⭐ Chromium 也不支持 `@page` 的 margin box ✓）。
//! ⇒ ⭐ 唯一能做到"⭐ 没有页头页脚 ＋ ⭐ 保留页码 ✗"的路 ✗：⭐ **我们自己出一份 PDF** ✓
//!   ⇒ ⭐ 用 WebView2 的 `PrintToPdfAsync(…, ShouldPrintHeaderAndFooter = false)` ✓
//!   ⇒ ⭐ 页码由前端用 `pdf-lib` 盖 ✓（⭐ 见 `src/lib/pdfPageNumbers.ts` ✓）。
//!
//! ## ⚠️ 一个**不能省**的前提（Lead 自己量出来的 ✓）
//! ⭐ `PrintToPdfAsync` 打的是 **那个 webview 自己当前的内容** ✗ —— ⭐ 而我们的导出内容在
//! `src/lib/print.ts` 的**隐藏 iframe** 里 ✓ ⇒ ⭐ 直接拿主窗口调它 ⇒ ⭐ **打出来的是应用界面** ✗。
//! ⇒ ⭐ 所以必须 ⭐ **另开一个隐藏窗口** ✓ 装导出 HTML ✓ ⇒ ⭐ 打它 ✓ ⇒ ⭐ 关掉 ✓。
//! ⚠️ 这一条是本模块的设计前提：⭐ 调用方给的是 **HTML 字符串** ✓，⭐ 不是"⭐ 打印我现在这一页 ✗" ✓。
//!
//! ## ⚠️ 平台边界（⭐ 如实 ✓）
//! ⭐ 只有 Windows（WebView2）这条能做 ✓；⭐ macOS（WKWebView）／⭐ Android 各有另一套 ✗
//! ⇒ ⭐ 本模块在那些平台上 ⭐ **明确返回"不支持"** ✗（⛔ 不静默失败 ✓）⇒
//! ⭐ 前端据此**回退到现有的 `window.print()`** ✓（⛔ 不许把别的平台弄坏 ✓）。

/// ⭐ 本次调用**为什么**出不了 PDF ✓（⭐ 每一条都能直接给用户看 ✓，⛔ 不写成"⭐ 失败 ✗"✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfExportRefusal {
    /// ⭐ 这个平台没有这条路（⭐ macOS ／ Android ／ Web 壳 ✓）。
    UnsupportedPlatform,
    /// ⭐ 给了空的 HTML ⇒ ⭐ 不出一份空 PDF ✓。
    EmptyHtml,
}

impl PdfExportRefusal {
    /// ⭐ 一句能给用户看的人话 ✓（⭐ 与前端"⭐ 回退老路 ✗"的判断同源 ✓）。
    pub fn message(&self) -> &'static str {
        match self {
            PdfExportRefusal::UnsupportedPlatform => {
                "这个平台暂时出不了不带页眉页脚的 PDF ⇒ 走原来的打印（你自己在打印对话框里关掉「页眉和页脚」）"
            }
            PdfExportRefusal::EmptyHtml => "没有内容可导出",
        }
    }
}

/// ⭐ 这个平台支持"⭐ 自己出一份不带页眉页脚的 PDF ✗"吗 ✓。
/// ⚠️ 前端**不要**靠 UA 猜系统 ✗（`platform/index.ts` 的注释：Tauri 没把 OS 名暴露给页面 ✓）
/// ⇒ ⭐ 一律以"⭐ 这道命令可不可用／⭐ 返不返不支持 ✗"为准 ✓。
pub const fn supported_on_this_platform() -> bool {
    cfg!(target_os = "windows")
}

/// ⭐ 出 PDF 前的**纯判定** ✗（⭐ 不碰 IO ✓，⭐ 所以判据不用起窗口就能跑 ✓）。
pub fn check_exportable(html: &str) -> Result<(), PdfExportRefusal> {
    if html.trim().is_empty() {
        return Err(PdfExportRefusal::EmptyHtml);
    }
    if !supported_on_this_platform() {
        return Err(PdfExportRefusal::UnsupportedPlatform);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_html_is_refused_before_touching_any_window() {
        assert_eq!(check_exportable("   \n  "), Err(PdfExportRefusal::EmptyHtml));
        assert_eq!(check_exportable(""), Err(PdfExportRefusal::EmptyHtml));
    }

    #[test]
    fn platform_verdict_is_honest_and_matches_the_cfg() {
        // ⭐ 这条判据在别的平台上跑会**如实翻转** ✓ —— ⭐ 那正是我们要的（⛔ 不是恒真 ✓）。
        let r = check_exportable("<p>hi</p>");
        if cfg!(target_os = "windows") {
            assert_eq!(r, Ok(()), "Windows 上这条路应当是支持的");
            assert!(supported_on_this_platform());
        } else {
            assert_eq!(
                r,
                Err(PdfExportRefusal::UnsupportedPlatform),
                "非 Windows 必须**明确说**不支持（前端据此回退老路）"
            );
            assert!(!supported_on_this_platform());
        }
    }

    #[test]
    fn refusals_say_something_a_user_can_read() {
        assert!(PdfExportRefusal::UnsupportedPlatform.message().contains("打印"));
        assert!(PdfExportRefusal::EmptyHtml.message().contains("没有内容"));
    }
}

// ---------------------------------------------------------------- 可行性探针

/// ⭐ **探针** ✗：⭐ 本仓这套 Tauri 2 拿得到 WebView2 的控制器吗 ✓？
///
/// ⚠️ 它**只是探针** ✗：⭐ 证明"⭐ 这个 API 在这儿存在、⭐ 类型对得上 ✗" ✓ ——
/// ⛔ 不注册成命令 ✓、⛔ 不产生任何副作用 ✓、⛔ 不会被生产代码调用 ✓。
///
/// ⭐ 为什么值得单独一个探针 ✗：⭐ 这一步是本模块**唯一的未知** ✓ ——
/// ⭐ Tauri 2 的 `with_webview` 在 Windows 上给的是 `PlatformWebview` ✓，
/// ⭐ 而 `PrintToPdfAsync` 那个接口要从它的控制器上**再向上转型**拿到 ✓。
/// ⭐ 拿不到 ⇒ ⭐ 这条路当场判死 ✓ ⇒ ⭐ 前端改走"⭐ JS 分页自己画页码 ✗"✓（⭐ 我会如实告诉你 ✓）。
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub fn probe_webview2_controller(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // ⭐ 拿得到 ⇒ 编译器过 ✓；⭐ 拿不到 ⇒ 编译期就红 ✓（⛔ 不等到运行时才发现 ✓）。
        let _controller = webview.controller();
    });
}

/// ⭐ **探针二** ✗：⭐ 真正**引用打印接口**（⭐ `ICoreWebView2_7` 的 `PrintToPdf` ＋
/// 打印设置里的 `ShouldPrintHeaderAndFooter` ✓）。
///
/// ⭐ 为什么必须探到这一层 ✗：⭐ "⭐ 能拿到控制器 ✗"（⭐探针一 ✓）**不等于**"⭐ 能关掉页眉页脚地出 PDF ✗" ✓。
/// ⭐ 后者要 ⭐ ① ⭐ 从控制器上转型到带打印能力的接口 ✓ ② ⭐ 拿到打印设置对象 ✓ ③ ⭐ 才谈得上设那个开关 ✓。
/// ⇒ ⭐ 探针二把它们**在类型层面**点一遍 ✓：⭐ 缺哪个接口 / ⭐ 缺哪个 trait ⭐ 编译期就说话 ✓。
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub fn probe_print_interfaces(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2PrintSettings};
    // ⚠️ `cast()` 来自 `windows::core::Interface` ✗ —— ⭐ `webview2-com` **不**转出 `windows` ✓
    //    （⭐ 本机 registry 里它的 `lib.rs` 只有 `pub use webview2_com_sys::Microsoft;` ＋ 自己那几个模块 ✓）
    //    ⇒ ⭐ 这一行非有不可 ✓。
    use windows::core::Interface;
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        let core = unsafe { controller.CoreWebView2() }.ok();
        if let Some(core) = core {
            // ⭐ 关键一步：⭐ 带 `PrintToPdf` 的那个接口在这套版本里叫什么、⭐ 转得过去吗 ✓。
            let _printable: Option<ICoreWebView2_7> = core.cast().ok();
        }
        // ⭐ 打印设置那个类型也要够得着（⭐ `ShouldPrintHeaderAndFooter` 就挂在它上面 ✓）。
        let _settings: Option<ICoreWebView2PrintSettings> = None;
    });
}
