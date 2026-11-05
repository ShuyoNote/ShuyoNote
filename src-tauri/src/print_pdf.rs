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
    use std::time::Duration;

    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_7, ICoreWebView2PrintSettings,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    if path.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主 WebView".to_string())?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let _ = webview.with_webview(move |platform| {
        let result = (|| -> Result<(), String> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }
                .map_err(|e| format!("取 WebView2 失败：{e}"))?;
            let webview7: ICoreWebView2_7 = core
                .cast()
                .map_err(|e| format!("当前 WebView2 不支持 PrintToPdf：{e}"))?;
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
                    .PrintToPdf(
                        PCWSTR(file.as_ptr()),
                        None::<&ICoreWebView2PrintSettings>,
                        &handler,
                    )
                    .map_err(|e| format!("启动 PrintToPdf 失败：{e}"))?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = tx.send(Err(e));
        }
    });

    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(result) => result,
        Err(_) => Err("等待 PDF 导出超时（60 秒）".to_string()),
    }
}
