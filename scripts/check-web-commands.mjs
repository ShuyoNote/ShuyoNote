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

// 对称的一张表：**桌面专属**命令（Rust 有、web 侧**故意不实现**）。
//
// 为什么需要它：方向 1 的默认规则是"Rust 有 ⇒ web.ts 必须实现"，这对绝大多数命令是对的
// （换平台时别漏）。但有一类命令的**语义就是桌面专属** —— Web 平台有 sql.js，TS 能直接跑 SQL，
// 根本不需要绕命令面；硬给它写一个 web 实现，只会把同一段逻辑**抄第二遍**（两边长期对齐的坑）。
// 2026-09-19 AMD 加：派生文本层的运输通道。
const DESKTOP_ONLY_COMMANDS = new Map([
  [
    "derived_apply",
    "派生文本层（attachment_text/chunks）的**桌面运输通道**：桌面库是 SQLCipher、连接在 Rust 手里，TS 没有别的写入途径；Web 平台 TS 直接跑 sql.js，不需要这条命令（写第二份实现 = 同一段 SQL 抄两遍）。调用点按平台选实现，见 src/lib/platform/derivedStores.ts",
  ],
  ["derived_query", "同上（读那一半）：Web 侧直接用自家 store 读 sql.js"],
  // 桌面「近实时」流通道（2026-09-23 第 48 轮）：**只有桌面**需要这三条 —— Web 平台浏览器自带 SSE，
  // `src/hooks/useSyncStream.ts` 里那条 fetch 读流就是它的客户端 ⇒ 硬在 `web.ts` 里再实现一遍等于把
  // 同一件事写两份（同一语义两处漂移正是本表要防的）。调用点按平台收口：`useSyncStream` 的桌面分支
  // （`isDesktopPlatform()`）＋ `lib/nearRealtime.ts::applyNearRealtime`（内部先判平台）。
  // ⚠️ 别和反方向的 `WEB_ONLY_COMMANDS` 搞混（本表下面那张）：那张是"契约有、Rust 没有"，
  //    这张是"Rust 有、Web 故意没有" —— `claim_page_lineage` 当年属于前者，这三条属于后者。
  ["sync_stream_start", "桌面专属：Rust 订 SSE 变更流（Web 侧浏览器自带 SSE，`useSyncStream.ts` 自己那条）"],
  ["sync_stream_stop", "同上（桌面专属：断开且不再重连）"],
  ["sync_stream_status", "同上（桌面专属：流通道读数，排错用）"],
  // 隐私边界第 1 步（2026-09-23）：**按空间**启用/禁用加密 —— **桌面专属**。
  // 理由：Web 平台没有钥匙柜（E2EE 在浏览器里是空操作，见 `docs/web-sync-boundary.md`），
  // 而加密空间在 Web 上由 `src/lib/ciphertextSniff.ts` **明确拒掉**（提示去桌面端）⇒
  // 在 `web.ts` 里再实现一遍"启用/禁用加密"等于**假装浏览器有钥匙**（比不实现危险得多）。
  ["enable_space_encryption", "桌面专属：按空间加密那一个空间（Web 无钥匙柜；加密空间在 Web 上被明确拒收）"],
  ["disable_space_encryption", "同上（另一半）：按空间禁用（只把它自己的库换回明文）"],
  // 隐私边界 A=3 ＋ ②b 的读数面（2026-09-24）：**桌面专属**。
  // 分类（`set_space_kind`）在 Web 上管不到任何东西（Web 没有钥匙柜 ⇒ 没有"按空间加密"这回事，
  // 闸门的输入没有下游）；读数（`space_security_overview`）在 Web 上更是**误导**：
  // `in_keyring` 恒假、`encrypted_on_disk` 无从嗅探（sql.js 手里没有文件头）。
  // ⚠️ 这不是"Web 也做到了"，而是**记下缺口**：闸门今天在 Web 上不生效（交接文档 §5）。
  ["set_space_kind", "桌面专属：空间分类标记（Web 无钥匙柜 ⇒ 分类在那里没有下游）"],
  ["space_security_overview", "桌面专属：隐私读数（Web 无钥匙柜 ⇒ 读数会是误导）"],
  // ③ 0b（2026-09-24）：公开材料的**推 / 取**（换设备只凭主口令解开自己的空间）—— **桌面专属**。
  // 理由与上面两条同族：Web 上没有钥匙袋，也就没有"公开材料"这件东西可推可取；
  // 硬实现一遍＝让 Web 看起来也能做 E2EE 换设备，而它其实连钥匙柜都没有。
  ["push_space_keyring", "桌面专属：把本机钥匙袋的公开那一半推给同步服务（Web 无钥匙柜）"],
  ["pull_space_keyring", "桌面专属：从同步服务取回公开材料并装进本机（Web 无钥匙柜）"],
  // ① 存量迁移（2026-09-24）：★ owner 第三轮拍板后**整条删掉** —— `migrate_legacy_space_encryption`
  // 与 `rotate_legacy_space_to_random_key`（含命令、契约、界面按钮、判据）一起没了：它们的对象是
  // "应用级加密留下的旧钥匙"，而那套（含解锁/读老库的兜底）已按拍板删净。⇒ 这里也不再登记。
]);

const missingWeb = [...rustCommands]
  .filter((c) => !webCommands.has(c) && !DESKTOP_ONLY_COMMANDS.has(c))
  .sort();
const missingContract = [...rustCommands].filter((c) => !contractCommands.has(c)).sort();

// 4. 反向：CommandMap 声明了、但桌面 Rust 没注册的命令。
//    这些在桌面点下去必然抛「command … not found」，而 web 平台往往有 stub ——
//    于是只有桌面用户会撞上，而且只有点到那条命令时才会。所以要么补 Rust 命令，
//    要么把它登记成**web 专属**（列在这里 = 明确承认"桌面没有这条命令"，
//    调用点必须自己按平台收口，例如 `when: () => !isDesktopPlatform()`）。
const WEB_ONLY_COMMANDS = new Map([
  ["request_persistent_storage", "浏览器的 Storage API，桌面端没有对应概念（UI 按 supported 决定显不显示）"],
  ["export_wiki", "静态 HTML wiki 导出目前只在 web 平台实现（桌面端命令面板按平台隐藏它）"],
  // 冲刺 S9（2026-09-23，第 41 轮撤登记）：`claim_page_lineage` **两侧都接了** ——
  // 桌面侧 `sync::claim_page_lineage`（reqwest 发同一端点 `{server}/lineage-claim`）、
  // Web 侧 `platform/web.ts` 那一支；两侧同一张状态码表（**403 ⇒ `unavailable`**，第 42 轮改：
  // 403 是"你不是这个空间的成员"，`denied` 只由 200 ＋ `granted:false` 表达）。
  // ⇒ 它**不再**是 web 专属，撤销登记正是"两侧同行为"这件事的判据。
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
