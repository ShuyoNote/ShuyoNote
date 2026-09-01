// 系统标题栏染色（Windows）。
//
// 为什么不自绘标题栏：`decorations(false)` 在 Windows 上要自己接管 Aero Snap、
// 边缘 resize hit-test、Win11 圆角与投影、系统菜单，还有「最大化时溢出 8px」
// 这类经典坑；而真正刺眼的问题只有一个——暗色主题下顶着一条白色系统标题栏。
// 用 DWM 属性染色即可解决，系统行为一点不损失。
//
// 用到两个属性：
//   DWMWA_USE_IMMERSIVE_DARK_MODE(20) —— Win10 1809+ / Win11，标题栏整体转暗；
//   DWMWA_CAPTION_COLOR(35)           —— Win11 22H2+，精确指定标题栏底色，
//                                        让它与应用侧栏同色而不是系统默认深灰。
// 旧系统上后者调用失败会被忽略（优雅降级为 immersive dark）。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    type HWND = *mut c_void;
    type HRESULT = i32;
    type HMENU = *mut c_void;
    type BOOL = i32;

    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    // TrackPopupMenu 标志：返回选中项而不是直接派发，便于我们自己 PostMessage。
    const TPM_RETURNCMD: u32 = 0x0100;
    const TPM_RIGHTBUTTON: u32 = 0x0002;
    const WM_SYSCOMMAND: u32 = 0x0112;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: HWND,
            attr: u32,
            value: *const c_void,
            size: u32,
        ) -> HRESULT;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMenu(hwnd: HWND, revert: BOOL) -> HMENU;
        fn TrackPopupMenu(
            menu: HMENU,
            flags: u32,
            x: i32,
            y: i32,
            reserved: i32,
            hwnd: HWND,
            rect: *const c_void,
        ) -> i32;
        fn PostMessageW(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> BOOL;
        fn SetForegroundWindow(hwnd: HWND) -> BOOL;
    }

    fn set_attr<T>(hwnd: HWND, attr: u32, value: &T) -> bool {
        // SAFETY: hwnd 来自 Tauri 的窗口句柄；value 指向栈上的 POD，size 与之匹配。
        let hr = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attr,
                value as *const T as *const c_void,
                std::mem::size_of::<T>() as u32,
            )
        };
        hr >= 0
    }

    /// `caption`/`text` 为 0x00BBGGRR（COLORREF）；传 None 表示不指定，交给系统。
    pub fn apply(hwnd: HWND, dark: bool, caption: Option<u32>, text: Option<u32>) {
        let flag: i32 = if dark { 1 } else { 0 };
        set_attr(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &flag);
        if let Some(c) = caption {
            set_attr(hwnd, DWMWA_CAPTION_COLOR, &c);
        }
        if let Some(t) = text {
            set_attr(hwnd, DWMWA_TEXT_COLOR, &t);
        }
    }

    /// 在 (x, y) 弹出**系统窗口菜单**（还原/移动/大小/最小化/最大化/关闭）。
    ///
    /// 无边框窗口丢掉了右键标题栏与 Alt+Space 这两个入口，这里把真正的系统菜单
    /// 调出来，而不是自绘一个仿制品——仿制品既做不到「移动/大小」那种进入
    /// 系统拖拽模式的行为，也不会跟随系统语言与主题。
    pub fn show_system_menu(hwnd: HWND, x: i32, y: i32) {
        // SAFETY: 全部是标准 Win32 调用，hwnd 由 Tauri 提供且在调用期间有效。
        unsafe {
            let menu = GetSystemMenu(hwnd, 0);
            if menu.is_null() {
                return;
            }
            // 菜单要能正确响应键盘与失焦关闭，窗口需在前台。
            SetForegroundWindow(hwnd);
            let cmd = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                x,
                y,
                0,
                hwnd,
                std::ptr::null(),
            );
            if cmd > 0 {
                PostMessageW(hwnd, WM_SYSCOMMAND, cmd as usize, 0);
            }
        }
    }
}

/// 把 `#RRGGBB` 解析成 Win32 的 COLORREF（0x00BBGGRR）。
#[cfg(windows)]
fn colorref(hex: &str) -> Option<u32> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let r = u32::from_str_radix(&h[0..2], 16).ok()?;
    let g = u32::from_str_radix(&h[2..4], 16).ok()?;
    let b = u32::from_str_radix(&h[4..6], 16).ok()?;
    Some((b << 16) | (g << 8) | r)
}

/// 让系统标题栏跟随应用主题。
///
/// `dark`：当前解析后的主题是否为暗色（"system" 已在前端解析）。
/// `caption` / `text`：可选的 `#RRGGBB`，用于在 Win11 22H2+ 上精确匹配侧栏配色。
///
/// 非 Windows 平台安全空转——macOS/Linux 的标题栏本就跟随系统主题。
#[tauri::command]
pub fn set_titlebar_theme(
    window: tauri::Window,
    dark: bool,
    caption: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as *mut std::ffi::c_void;
        let cap = caption.as_deref().and_then(colorref);
        let txt = text.as_deref().and_then(colorref);
        imp::apply(hwnd, dark, cap, txt);
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, dark, caption, text);
    }
    Ok(())
}

/// 在屏幕坐标弹出系统窗口菜单。
///
/// 自绘标题栏丢掉了「右键标题栏」与 `Alt+Space` 两个入口——它们能唤出还原/
/// 移动/大小/最小化/最大化/关闭。这里调真正的系统菜单补回来，而不是自绘仿制：
/// 仿制品做不到「移动/大小」进入系统拖拽模式，也不跟随系统语言与高对比度主题。
///
/// x/y 传**物理屏幕坐标**。前端 `screenX/screenY` 是 DPI 缩放后的逻辑像素，
/// 在 1.25×/1.5× 屏上直接传进 TrackPopupMenu 会错开几十像素。所以默认不传：
/// Rust 侧用 `cursor_position()` 取**原生物理坐标**，与 TrackPopupMenu 天然
/// 同坐标系，免去前端换算与往返精度损失。
#[tauri::command]
pub fn show_window_menu(window: tauri::Window, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as *mut std::ffi::c_void;
        let pos = window.cursor_position().map_err(|e| e.to_string())?;
        let px = x.map(|v| v as i32).unwrap_or(pos.x as i32);
        let py = y.map(|v| v as i32).unwrap_or(pos.y as i32);
        imp::show_system_menu(hwnd, px, py);
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, x, y);
    }
    Ok(())
}
