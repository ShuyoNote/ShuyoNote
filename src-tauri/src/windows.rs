use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// Open a page in a standalone window. The URL carries the page id via query
// string; the frontend detects `?page=` and renders a single-page editor.
#[tauri::command]
pub fn open_page_window(app: AppHandle, page_id: String) -> Result<(), String> {
    let label = format!("page-{page_id}");
    // Reuse existing window if already open, otherwise create it.
    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?page={page_id}").into());
    let version = app.package_info().version.to_string();
    let win = WebviewWindowBuilder::new(&app, &label, url)
        // 初始标题只是占位：前端拿到页面后会 setTitle 成真实页面名——开着三个
        // 独立窗口时，标题栏全是「ShuyoNote · v1.66.0」根本分不清谁是谁。
        .title(format!("ShuyoNote 数友笔记 · v{version}"))
        .inner_size(900.0, 700.0)
        // 与主窗口一致：无边框 + 前端自绘标题栏。用户若在设置里关掉自定义
        // 标题栏，前端启动时会 setDecorations(true) 把系统栏恢复回来。
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Focus after a short delay so the window is ready.
    let _ = win.set_focus();
    Ok(())
}
