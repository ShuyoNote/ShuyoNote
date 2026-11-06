// 直接把当前 WebView 的阅读页打印成 PDF（不弹系统打印对话框）。
//
// 为什么需要它：现有「导出 PDF」走 `printDoc()` → `window.print()`，必然要用户在
// 系统对话框里点「另存为 PDF」。这里用 WebView 自己的打印引擎直出文件。
//
// 平台边界（如实）：
// - Windows：WebView2 `ICoreWebView2_7::PrintToPdf`，本文件实现。
// - macOS：WKWebView 另有 `createPDF`，本轮未接（前端不会显示按钮）。
// - Linux：没有稳定的等价 API，保持打印对话框兜底。
//
// 打印的是**当前主窗口**；页面侧有 `@media print` 只保留阅读正文（见 file-manager.css）。

#[tauri::command]
pub async fn export_webview_pdf(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        export_webview_pdf_windows(app, path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        Err("当前平台暂不支持直接导出 PDF（Windows 支持；其它平台请用打印对话框）".to_string())
    }
}

#[cfg(windows)]
async fn export_webview_pdf_windows(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
        ICoreWebView2_7, COREWEBVIEW2_COLOR,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    if path.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主 WebView".to_string())?;

    // 打印前的 WebView2 默认背景色（`lib.rs` 设为 11,21,51 的深色，用于启动时防白闪）。
    // ⭐ 实测：PDF 的**画布底色**取自它，`html`/`body` 的背景压不住 ⇒ 不改成白色，
    //    导出的每一页四周都会印出一圈深蓝。打完必须还原（否则窗口底色被永久改掉）。
    let prior_bg: Arc<Mutex<Option<COREWEBVIEW2_COLOR>>> = Arc::new(Mutex::new(None));
    let prior_bg_in = prior_bg.clone();

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let _ = webview.with_webview(move |platform| {
        let result = (|| -> Result<(), String> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }
                .map_err(|e| format!("取 WebView2 失败：{e}"))?;
            let webview7: ICoreWebView2_7 = core
                .cast()
                .map_err(|e| format!("当前 WebView2 不支持 PrintToPdf：{e}"))?;
            // ⭐ 打印期间把 WebView2 的默认背景改成白：PDF 画布底色就是它。
            if let Ok(controller2) = controller.cast::<ICoreWebView2Controller2>() {
                let mut prior = COREWEBVIEW2_COLOR::default();
                if unsafe { controller2.DefaultBackgroundColor(&mut prior) }.is_ok() {
                    *prior_bg_in.lock().unwrap() = Some(prior);
                }
                let white = COREWEBVIEW2_COLOR {
                    A: 255,
                    R: 255,
                    G: 255,
                    B: 255,
                };
                let _ = unsafe { controller2.SetDefaultBackgroundColor(white) };
            }
            // ⭐ 纸张/页边距必须由 PrintSettings 指定：`print.css` 里的 `@page { size: A4 }`
            //    只在浏览器打印对话框路径上生效，PrintToPdf 不传设置时默认是 **Letter**。
            //    A4 = 210×297mm = 8.27×11.69in；12mm ≈ 0.4724in（与 print.css 的 12mm 对齐）。
            let settings: ICoreWebView2PrintSettings = {
                let env6: ICoreWebView2Environment6 = platform
                    .environment()
                    .cast()
                    .map_err(|e| format!("当前 WebView2 不支持打印设置：{e}"))?;
                let s = unsafe { env6.CreatePrintSettings() }
                    .map_err(|e| format!("创建打印设置失败：{e}"))?;
                unsafe {
                    let _ = s.SetPageWidth(8.27);
                    let _ = s.SetPageHeight(11.69);
                    let _ = s.SetMarginTop(0.4724);
                    let _ = s.SetMarginBottom(0.4724);
                    let _ = s.SetMarginLeft(0.4724);
                    let _ = s.SetMarginRight(0.4724);
                    // 背景要印：代码块/主题底色靠它，否则 PDF 与屏幕不是一个样子。
                    let _ = s.SetShouldPrintBackgrounds(true);
                }
                s
            };
            let file = HSTRING::from(path.as_str());
            let sender = tx.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                let _ = sender.send(if hr.is_ok() && ok {
                    Ok(())
                } else {
                    Err(format!("PrintToPdf 失败：{hr:?}"))
                });
                Ok(())
            }));
            unsafe {
                webview7
                    .PrintToPdf(PCWSTR(file.as_ptr()), Some(&settings), &handler)
                    .map_err(|e| format!("启动 PrintToPdf 失败：{e}"))?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = tx.send(Err(e));
        }
    });

    let result = match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(result) => result,
        Err(_) => Err("等待 PDF 导出超时（60 秒）".to_string()),
    };

    // 还原默认背景色（尽力而为；必须回主线程拿 controller）。
    let restore = prior_bg.lock().unwrap().take();
    if let Some(color) = restore {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.with_webview(move |platform| {
                    if let Ok(c2) = platform.controller().cast::<ICoreWebView2Controller2>() {
                        let _ = unsafe { c2.SetDefaultBackgroundColor(color) };
                    }
                });
            }
        });
    }

    result
}
