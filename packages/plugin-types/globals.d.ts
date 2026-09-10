// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
// 用途：脚本式插件（非模块）的全局声明。作者的 tsconfig 里 include 本文件即可获得补全。
import type { PluginApi, PluginCommand } from "./index";

declare global {
  /** 宿主能力面。每一项需要的权限见 manifest.permissions（未声明的权限调用会被后端拒绝）。 */
  const api: PluginApi;
  /** 注册一个命令：在插件顶层调用，命令会出现在命令面板（Ctrl+K）。 */
  function register(cmd: PluginCommand): void;
  /** 本应用支持的 API 版本（与 manifest.apiVersion 的主版本必须一致）。 */
  const SDK_API_VERSION: "1.0.0";
}

export {};
