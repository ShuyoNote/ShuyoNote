#!/usr/bin/env node
// 构建「随包 MCP 桥」（Rust 版）—— 把编译产物放到 `tools/shuyonote-mcp-rust/dist/`，
// 供 `src-tauri/tauri.*.conf.json` 的 `bundle.resources` 收进安装包。
//
// 为什么桥是**独立 crate**（`tools/shuyonote-mcp-rust/`）而不是 `src-tauri` 里的一个 [[bin]]：
//   `src-tauri/build.rs`（tauri-build）在**编译期**就校验 `bundle.resources` 里的路径存在；
//   而桥的产物正是这次编译才生成的 ⇒ 变成"先有鸡还是先有蛋"（实测：`cargo build --bin` 直接红
//   `resource path mcp\shuyonote-mcp.exe doesn't exist`）。放到独立 crate 后：
//   beforeBuildCommand 先编桥 → 再编 App → tauri-build 校验时文件已经在了。
//
// 用法：
//   node scripts/build-mcp-bridge.mjs            # release（打包用，tauri.conf 的 beforeBuildCommand 自动调）
//   node scripts/build-mcp-bridge.mjs --debug    # debug（beforeDevCommand 用；快，体积大一点）
//
// 产物：`tools/shuyonote-mcp-rust/dist/shuyonote-mcp[.exe]`（被 .gitignore 忽略）
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const crateDir = join(repo, "tools", "shuyonote-mcp-rust");
const binName = process.platform === "win32" ? "shuyonote-mcp.exe" : "shuyonote-mcp";

const cargoArgs = ["build", "--manifest-path", join(crateDir, "Cargo.toml"), "--bin", "shuyonote-mcp"];
if (profile === "release") cargoArgs.push("--release");

console.log(`[mcp-bridge] cargo ${cargoArgs.join(" ")}`);
const r = spawnSync("cargo", cargoArgs, { cwd: repo, stdio: "inherit" });
if (r.status !== 0) {
  console.error(`[mcp-bridge] cargo 失败（exit=${r.status ?? "signal"}）—— 安装包里不会有 MCP 桥`);
  process.exit(r.status ?? 1);
}

const built = join(crateDir, "target", profile, binName);
if (!existsSync(built)) {
  console.error(`[mcp-bridge] 编译结束但找不到产物：${built}`);
  process.exit(1);
}
const distDir = join(crateDir, "dist");
mkdirSync(distDir, { recursive: true });
const dest = join(distDir, binName);
copyFileSync(built, dest);
if (process.platform !== "win32") chmodSync(dest, 0o755);
const kb = (statSync(dest).size / 1024).toFixed(0);
console.log(`[mcp-bridge] 已就位：${dest}（${kb} KB，${profile}）`);
