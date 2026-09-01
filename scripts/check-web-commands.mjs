// 命令覆盖率检查：比对桌面 Rust 后端注册的 command 与 web.ts 实现的命令。
// 输出「Rust 有但 web.ts 未实现」的命令（前端在 Web 调用这些会抛「未实现命令」）。
// 用法：node scripts/check-web-commands.mjs  （有缺失即非零退出）
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => {
  try {
    return readFileSync(resolve(root, p), "utf8");
  } catch {
    return "";
  }
};

// 1. Rust 端：generate_handler! 里的 `module::command,` → command 名。
const libRs = read("src-tauri/src/lib.rs");
const rustCommands = new Set();
for (const m of libRs.matchAll(/([a-z_]+)::([a-z_0-9]+)\s*,/g)) {
  rustCommands.add(m[2]);
}

// 2. web.ts 端：`cmd === "name"`（含 `||` 组合）→ command 名。
const webTs = read("src/lib/platform/web.ts");
const webCommands = new Set();
for (const m of webTs.matchAll(/cmd\s*===\s*"([a-z_0-9]+)"/g)) {
  webCommands.add(m[1]);
}

const missing = [...rustCommands].filter((c) => !webCommands.has(c)).sort();
if (missing.length) {
  console.error(`Web 平台缺失 ${missing.length} 个桌面命令（前端调用会抛「未实现命令」）：`);
  for (const c of missing) console.error("  - " + c);
  process.exit(1);
}
console.log(`命令覆盖完整：Rust ${rustCommands.size} 个命令，web.ts 全部实现（web 共 ${webCommands.size} 个）。`);
