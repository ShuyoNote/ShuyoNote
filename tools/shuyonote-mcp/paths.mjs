// tools/shuyonote-mcp/paths.mjs —— **桥自己找默认目录**（2026-10-18）。
//
// 为什么要有这一层：连接器商店里那份 `mcp.json` **不能写死用户机器上的绝对路径**
// （WorkBuddy 文档原话：「安装路径由 WorkBuddy 管理，开发者不应在命令中写死绝对路径」），
// 而 App 把 `port` / `token` 写在**应用数据目录**下 —— 那个目录每个用户、每个系统都不一样。
//
// ⇒ 桥默认去**标准位置**找；`SHUYONOTE_MCP_HOME` 可整体改道（测试与自定义安装用），
//   两个具体的文件变量仍然优先（显式 > HOME > 平台默认）。
//
// ⚠️ 路径必须与 Rust 侧的应用数据目录**同口径**（Tauri `app_data_dir`）：
//   Windows  `%APPDATA%\cn.shuyo.shuyonote\mcp`
//   macOS    `~/Library/Application Support/cn.shuyo.shuyonote/mcp`
//   Linux    `$XDG_DATA_HOME/cn.shuyo.shuyonote/mcp`（默认 `~/.local/share/…`）
// 三处写错任何一处，症状都是"装了连接器却连不上 App"，而且**不会有报错**（只会说读不到文件）。

import { homedir } from "node:os";
import { join } from "node:path";

/** 与 `src-tauri/tauri.conf.json` 的 `identifier` 同值。 */
export const APP_ID = "cn.shuyo.shuyonote";

/** 平台默认的 `mcp/` 目录（纯函数：可跨平台测）。 */
export function defaultMcpDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "win32") {
    const appdata = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appdata, APP_ID, "mcp");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", APP_ID, "mcp");
  }
  // Linux / 其它 unix：Tauri 用 XDG_DATA_HOME（未设则 ~/.local/share）
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(data, APP_ID, "mcp");
}

/**
 * 实际要读的两个文件：**显式环境变量 > `SHUYONOTE_MCP_HOME` > 平台默认**。
 * 返回 `{ portFile, tokenFile }`（都是绝对路径或可由 cwd 解析的相对路径）。
 */
export function resolveEndpointFiles({ env = process.env, platform = process.platform, home } = {}) {
  const base = env.SHUYONOTE_MCP_HOME || defaultMcpDir({ platform, env, home });
  return {
    portFile: env.SHUYONOTE_MCP_PORT_FILE || join(base, "port"),
    tokenFile: env.SHUYONOTE_MCP_TOKEN_FILE || join(base, "token"),
  };
}
