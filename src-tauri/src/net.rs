//! **C2 网络闸门**：当前网络类型。
//!
//! ## 为什么要一条真命令，而不是前端"猜"
//!
//! `src/lib/platform/index.ts:35-38` 已经写过这条告警：**不要用 UA / 平台名去近似**系统状态。
//! 「仅 Wi-Fi 下自动同步」如果靠猜，猜错的两种后果都不对等：
//! 猜成"是 Wi-Fi"而其实是蜂窝 ⇒ **偷偷跑用户流量**（用户最不能接受的那种错）；
//! 猜成"不是 Wi-Fi"而其实是 ⇒ 只是不自动同步，用户手动点一下就好。
//! ⇒ 所以本命令的**失败方向统一指向后者**：拿不到 → `unknown` → 前端**不自动拉取**（fail-safe）。
//!
//! ## 平台事实（2026-09-15 核实）
//!
//! - **Android**：真实查询，走**本仓自有的** Android 插件（`src/android_fs.rs` 的
//!   `networkType` → Kotlin `ConnectivityManager` / `NetworkCapabilities`）。
//!   **不引第三方插件**：搜到的候选里 `tauri-plugin-network-manager` 是 Linux-first
//!   （NetworkManager over D-Bus），与 Android 无关；而本仓这条路已经跑通过一次
//!   （`ShuyoFsPlugin` 的 `pickedFileInfo` / `installApk`）。
//! - **桌面 / Web**：返回 `n/a` = **闸门不适用**（不是"未知"）。桌面没有"蜂窝流量"这个概念，
//!   若返回 `unknown` 并按 fail-safe 处理，就会**把桌面的自动同步也一起关掉**——那是 bug 不是安全。
//!
//! 返回值（**契约**，前端 `isWifiLike` 按它分支）：
//! `"wifi"` / `"cellular"` / `"ethernet"` / `"other"` / `"none"` / `"unknown"` / `"n/a"`。

/// 非 Android 平台的返回值：闸门不适用。
pub const NOT_APPLICABLE: &str = "n/a";
/// Android 上查询失败时的返回值：**未知**（前端按"不自动拉取"处理）。
/// 只在 Android 分支里被构造 ⇒ 非 Android 构建下会报 dead_code，这里显式放行。
#[allow(dead_code)]
pub const UNKNOWN: &str = "unknown";

/// 当前网络类型。见模块头注释的返回值契约。
#[tauri::command]
pub fn network_type(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        // 问不到 ⇒ `unknown`（**不是** `n/a`）：在 Android 上"问不到"意味着不确定性，
        // 而不确定性必须指向"不自动拉取"。
        return Ok(crate::android_fs::network_type(&app).unwrap_or_else(|| UNKNOWN.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(NOT_APPLICABLE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约里那几个取值是**前端分支的依据**，钉住它们（改字面量必须同时改前端）。
    #[test]
    fn the_return_contract_is_what_the_frontend_branches_on() {
        assert_eq!(NOT_APPLICABLE, "n/a");
        assert_eq!(UNKNOWN, "unknown");
        // 桌面/测试进程上，命令必须回 `n/a`（闸门不适用），**不能**回 unknown
        // —— 后者会被 fail-safe 当成"网络不确定"，把桌面的自动同步也关掉。
        assert_ne!(NOT_APPLICABLE, UNKNOWN);
    }
}
