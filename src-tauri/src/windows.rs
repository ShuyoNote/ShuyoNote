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
        .title(format!("ShuyoNote 数友笔记 · v{version}"))
        .inner_size(900.0, 700.0)
        .build()
        .map_err(|e| e.to_string())?;

    // Focus after a short delay so the window is ready.
    let _ = win.set_focus();
    Ok(())
}
