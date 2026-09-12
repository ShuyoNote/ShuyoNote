// 平台**能力**判定：纯函数，可单测。
//
// 为什么单独一个文件、而不是都塞进 `index.ts`：`index.ts` 在模块顶层就会实例化平台实现
// （`createWebPlatform()`，连带 web.ts 一大票依赖），单测 import 它会连带跑一堆东西。
// 这里的判定是纯的，值得被直接测——而它判错的代价是"入口显示了、点下去必然失败"。
//
// ⚠️ 与 `isDesktopPlatform()` 的分工（这条边界踩过一次，写在注释里防复读）：
//   · `isDesktopPlatform()` 的真实语义是「**有没有 Rust 内核**」——Tauri 的 Android/iOS
//     壳同样为真，而同步 / 加密 / 插件在移动端**是要保留的**（这正是选 Tauri 原生壳的
//     理由，见 docs/MOBILE.md）。
//   · 所以"某个只在桌面存在的功能"必须各自有**具体能力**函数，不许拿它当近似。

/** 纯函数：从 UA 判断移动端操作系统。 */
export function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

/**
 * 纯函数：聚合邮箱是否可用。**桌面专属**（2026-09-13 定）。
 *
 * 它走 `native-tls`（桌面用系统 TLS），Android 上要为此从源码交叉编译一份 OpenSSL；
 * 而 `EmailPanel` 里早就写着「邮箱是**桌面版独有**能力」，只是那条声明当时还没落到移动端。
 *
 * Rust 侧对应边界：`src-tauri/src/lib.rs` 的 `mod email` / `mod smtp` 与 23 个邮箱命令
 * 都带 `#[cfg(desktop)]`，**移动端这些命令不存在**——所以返回 false 时前端必须真的别去调，
 * 否则会拿到 "command not found"（而不是一句人话）。
 *
 * @param isTauriShell 是否运行在 Tauri 壳里（Web 平台为 false）
 * @param userAgent 当前 UA
 */
export function computeEmailSupported(isTauriShell: boolean, userAgent: string): boolean {
  if (!isTauriShell) return false; // Web 平台：命令是 stub，入口也不该显示
  return !isMobileUserAgent(userAgent);
}
