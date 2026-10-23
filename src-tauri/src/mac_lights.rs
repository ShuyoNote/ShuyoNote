// macOS：把系统那三颗红绿灯**藏掉**，改用前端自绘的小灯（2026-10-23）。
//
// 为什么只能这样：macOS **不提供**修改原生按钮尺寸的 API（`NSWindow` 只暴露
// `standardWindowButton:` 拿到按钮本身）；tao 的 `traffic_light_position` 只改位置，
// 而且实测在这套 Overlay 窗口上**不生效** —— 同一窗口在 6/14 与 -100/14 两版下
// 截图的灯位置逐像素一致 ⇒ 想让灯变小，只能把系统那三颗藏掉，由前端画。
//
// 代价（owner 已接受这个方向，写在这里给下一个人）：
//   · 这三颗不再是系统按钮 ⇒ 绿键走 `toggleMaximize`（缩放），不是系统的「全屏」；
//     全屏仍可用 Cmd+Ctrl+F / 菜单 / 双击顶带（<TitleBar> 的 document 级 mousedown）。
//   · 悬停字形、失焦变灰由 CSS 复刻（见 App.css 的 `.mac-lights`）。

#[cfg(target_os = "macos")]
pub fn hide_native_traffic_lights(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let ns_window = window.ns_window()? as *mut AnyObject;
    // NSWindowButton：CloseButton = 0 ／ MiniaturizeButton = 1 ／ ZoomButton = 2
    for kind in 0i64..3 {
        let button: *mut AnyObject = unsafe { msg_send![ns_window, standardWindowButton: kind] };
        if !button.is_null() {
            let yes: i8 = 1; // BOOL 在 ObjC 里是 signed char
            let _: () = unsafe { msg_send![button, setHidden: yes] };
        }
    }
    Ok(())
}

/// 运行时切换原生三颗灯的显隐。
///
/// **全屏时必须把它们放出来**（2026-10-23 的教训）：全屏里系统只在鼠标到顶部时把
/// 原生标题栏浮出来（微信就是那个样子），而自绘灯画在 webview 里 —— 会被那条原生
/// 标题栏盖住 ⇒ 表现为"恢复工具栏那一条是空白"。所以在全屏时：藏自绘灯、放原生灯。
#[cfg(target_os = "macos")]
pub fn set_native_traffic_lights_visible(
    window: &tauri::WebviewWindow,
    visible: bool,
) -> tauri::Result<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let ns_window = window.ns_window()? as *mut AnyObject;
    for kind in 0i64..3 {
        let button: *mut AnyObject = unsafe { msg_send![ns_window, standardWindowButton: kind] };
        if !button.is_null() {
            let hidden: i8 = if visible { 0 } else { 1 };
            let _: () = unsafe { msg_send![button, setHidden: hidden] };
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn hide_native_traffic_lights(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_native_traffic_lights_visible(
    _window: &tauri::WebviewWindow,
    _visible: bool,
) -> tauri::Result<()> {
    Ok(())
}
