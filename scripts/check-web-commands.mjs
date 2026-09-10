// 命令覆盖率检查（三个方向）：
//   1. Rust 有 → web.ts 必须实现；
//   2. Rust 有 → CommandMap 必须声明；
//   3. **CommandMap 有的 → 桌面 Rust 必须注册**（或明确登记为「web 专属」）。
// 前两个方向是"换平台时别漏"，第三个方向是"别让前端调用一个桌面根本不存在的命令"——
// 2026-09 就是它漏掉了 `approve_plugin`：前端有契约、有 API、有按钮（插件被暂停后的
// 「重新确认」），Rust 侧却忘了进 `generate_handler!`，于是桌面点下去只会看到
// "command approve_plugin not found"（而 web 平台的 stub 让它看起来一切正常）。
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

// 3. CommandMap 契约层（src/lib/platform/commands.ts）：键 → command 名。
const cmTs = read("src/lib/platform/commands.ts");
const contractCommands = new Set();
for (const m of cmTs.matchAll(/^\s{2}([a-z_0-9]+):\s*\{\s*args/gm)) {
  contractCommands.add(m[1]);
}

const missingWeb = [...rustCommands].filter((c) => !webCommands.has(c)).sort();
const missingContract = [...rustCommands].filter((c) => !contractCommands.has(c)).sort();

// 4. 反向：CommandMap 声明了、但桌面 Rust 没注册的命令。
//    这些在桌面点下去必然抛「command … not found」，而 web 平台往往有 stub ——
//    于是只有桌面用户会撞上，而且只有点到那条命令时才会。所以要么补 Rust 命令，
//    要么把它登记成**web 专属**（列在这里 = 明确承认"桌面没有这条命令"，
//    调用点必须自己按平台收口，例如 `when: () => !isDesktopPlatform()`）。
const WEB_ONLY_COMMANDS = new Map([
  ["request_persistent_storage", "浏览器的 Storage API，桌面端没有对应概念（UI 按 supported 决定显不显示）"],
  ["export_wiki", "静态 HTML wiki 导出目前只在 web 平台实现（桌面端命令面板按平台隐藏它）"],
]);
const missingRust = [...contractCommands]
  .filter((c) => !rustCommands.has(c) && !WEB_ONLY_COMMANDS.has(c))
  .sort();

// 4. 参数键大小写：Tauri 2 只接受 camelCase 参数键（运行时映射到 Rust 的
//    snake_case 形参）。传 `server_url` 会在**运行时**报「missing required key
//    serverUrl」——TS 查不出来，因为 CommandMap 与调用点可以「一起错」。
//    这里对 CommandMap 的**顶层**参数键做静态校验。
//    例外：`args: { args: {...} }` 是「整个结构体作为一个参数」的形式，顶层键仍是
//    `args`，内层字段由 serde 反序列化，snake_case 是对的，故只看第一层。
//    注意：不能用「非分号」正则去截 args 值——参数之间本来就用 `;` 分隔；这里按
//    花括号配平取值，再逐字符统计深度找顶层键。
function balancedBlock(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const badArgKeys = [];
for (const line of cmTs.split("\n")) {
  const head = /^\s{2}([a-z_0-9]+):\s*\{\s*args:\s*/.exec(line);
  if (!head) continue;
  const block = balancedBlock(line, head[0].length);
  if (!block) continue; // args: undefined / 非对象形参
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 1) {
      const key = /^([A-Za-z_][A-Za-z_0-9]*)\??\s*:/.exec(block.slice(i));
      if (key) {
        if (key[1].includes("_")) badArgKeys.push(`${head[1]} → ${key[1]}`);
        i += key[0].length - 1;
      }
    }
  }
}

let failed = false;
if (badArgKeys.length) {
  failed = true;
  console.error(`CommandMap 有 ${badArgKeys.length} 个 snake_case 顶层参数键（Tauri 2 只认 camelCase，会在运行时报 missing required key）：`);
  for (const c of badArgKeys) console.error("  - " + c);
}
if (missingWeb.length) {
  failed = true;
  console.error(`Web 平台缺失 ${missingWeb.length} 个桌面命令（前端调用会抛「未实现命令」）：`);
  for (const c of missingWeb) console.error("  - " + c);
}
if (missingContract.length) {
  failed = true;
  console.error(`CommandMap 契约层缺少 ${missingContract.length} 个桌面命令（新命令须同步到 commands.ts，否则 api.ts 调用无编译期校验）：`);
  for (const c of missingContract) console.error("  - " + c);
}
if (missingRust.length) {
  failed = true;
  console.error(`CommandMap 有 ${missingRust.length} 个命令桌面 Rust 没注册（桌面调用会抛 command not found）：`);
  for (const c of missingRust) console.error("  - " + c);
  console.error("  若它本来就是 web 专属，请登记进本脚本的 WEB_ONLY_COMMANDS 并说明理由。");
}
if (failed) process.exit(1);
console.log(
  `命令覆盖完整：Rust ${rustCommands.size} 个命令，web.ts 全部实现（web 共 ${webCommands.size} 个），` +
    `CommandMap 契约全覆盖（${contractCommands.size} 个，其中 web 专属 ${WEB_ONLY_COMMANDS.size} 个），参数键均为 camelCase。`,
);
