// Windows 侧交付通道协议（`shuyonote://`）的**门禁**。
//
// 这个脚本存在的唯一理由：这条链路上的每一个断点，**表现都是"什么都没有发生"**——
// 用户点了一个链接，应用没反应，而控制台里没有任何一行报错。四类断点都不是编译错误：
//
//   1. `tauri.conf.json` 里的 scheme 名写错 / 被删掉 → 注册表里没有这个协议；
//   2. `Cargo.toml` 里 `single-instance` 少了 `deep-link` feature → **URL 被静默丢掉**
//      （窗口照样还原，所以看起来像"解析失败"，而不是"没接上"）；
//   3. `lib.rs` 忘了注册插件 / 忘了接事件 → 收到了也不会转给前端；
//   4. 事件名前后端写得不一致 → 前端永远等不到事件。
//
// 四件事这里都机械比对，一条命令就能全查：
//   node scripts/check-deep-link.mjs        （有问题即非零退出）
//
// 为什么是 Node 而不是 Rust 的 `#[test]`：Rust 侧读 `tauri.conf.json` 要用
// `include_str!`，那会让**改 tauri.conf.json 触发整个 crate 重编译**（十分钟量级），
// 而这几条检查本来就不需要编译。另外这一档和 `check-web-commands.mjs` 同类，
// 放在一起跑既有的 CI JS 档即可。

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

const problems = [];
const fail = (msg) => problems.push(msg);

// ---- 唯一的真相源：scheme 在 tauri.conf.json 里声明 ----
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const desktop = conf?.plugins?.["deep-link"]?.desktop;
// 插件的配置形状既可以是 `{ schemes: [...] }`，也可以直接是数组（见插件 config.rs 的
// untagged DesktopProtocol：One / List）。两种都接受，不强迫某一种写法。
const schemes = Array.isArray(desktop?.schemes)
  ? desktop.schemes
  : Array.isArray(desktop)
    ? desktop.flatMap((p) => p?.schemes ?? [])
    : [];

if (schemes.length === 0) {
  fail(
    "tauri.conf.json > plugins > deep-link > desktop 里没有任何 scheme —— " +
      "打包时它会被映射成 bundler 的 deep_link_protocols，为空则 NSIS 模板整段注册代码不生成，" +
      "装完 `HKCU\\Software\\Classes\\shuyonote` 根本不存在。",
  );
}
for (const s of schemes) {
  // 注册表键名 / 命令行模板都是直接拼 scheme 的，出现大小写、冒号、斜杠都会写坏。
  if (!/^[a-z][a-z0-9+.-]*$/.test(String(s))) {
    fail(`scheme ${JSON.stringify(s)} 不合法：只能是小写字母开头、不含冒号与斜杠（例：shuyonote）`);
  }
}
if (schemes.length && !schemes.includes("shuyonote")) {
  fail(`声明了 scheme 但没有 shuyonote（实际：${schemes.join(", ")}）——社区侧生成的就是 shuyonote:// 链接`);
}

// ---- Cargo.toml：依赖在 + **feature 开着** ----
const cargo = read("src-tauri/Cargo.toml");
if (!/^\s*tauri-plugin-deep-link\s*=/m.test(cargo)) {
  fail("Cargo.toml 里没有 tauri-plugin-deep-link 依赖");
}
// 这条是本门禁里最值钱的一条：少了 feature 不会编译失败，只会让**已有实例收到 URL 后被丢掉**。
const siLine = cargo.match(/^\s*tauri-plugin-single-instance\s*=.*$/m)?.[0] ?? null;
if (!siLine) {
  fail("Cargo.toml 里没有 tauri-plugin-single-instance 依赖");
} else if (!/features\s*=\s*\[[^\]]*"deep-link"/.test(siLine)) {
  fail(
    "Cargo.toml 的 tauri-plugin-single-instance 没开 `deep-link` feature：" +
      "Windows 上第二个进程的 argv 里那条 URL 会被直接丢掉（窗口照样还原 ⇒ 看起来像解析失败）",
  );
}

// ---- lib.rs：插件注册 + 接线 + 命令进 generate_handler! ----
const libRs = read("src-tauri/src/lib.rs");
const deepRs = read("src-tauri/src/deeplink.rs");
if (!/\.plugin\(\s*deeplink::plugin\(\)\s*\)/.test(libRs)) {
  fail("lib.rs 里没有注册 deep-link 插件（deeplink::plugin()）");
}
if (!/deeplink::attach\(/.test(libRs)) {
  fail("lib.rs 的 setup 里没有调用 deeplink::attach(...) —— 插件注册了但没人接线，事件进不了队列也发不给前端");
}
// 必须用插件自己的 `init()`：它的配置类型是 `Option<Config>`，而 `Config` 未公开导出，
// 自己用裸 `Builder::new("deep-link")`（unit 配置）会让 tauri.conf.json 里的
// `plugins.deep-link` 反序列化失败 —— **启动即 panic（退出码 101）**，而这一条只有真装才会发现。
if (!/tauri_plugin_deep_link::init\(\)/.test(deepRs)) {
  fail("deeplink.rs 没有用 tauri_plugin_deep_link::init()（用裸 Builder 会让 plugins.deep-link 配置反序列化失败 → 启动 panic）");
}
// 冷启动那一次必须在订阅之前补收：插件 setup 时已经 emit 过，而我们订阅得晚。
// 少了 get_current() 的表现是「第一次点链接没反应，第二次正常」。
if (!/get_current\(\)/.test(deepRs)) {
  fail("deeplink.rs 没有用 get_current() 补收冷启动那一条 —— 冷启动深链会被稳定丢掉（表现为「第一次点没反应，第二次正常」）");
}
if (!/deeplink::deep_link_take\s*,/.test(libRs)) {
  fail("lib.rs 的 generate_handler! 里没有 deeplink::deep_link_take —— 前端启动 drain 会报 command not found");
}
if (!/app\.manage\(PendingDeepLinks::default\(\)\)/.test(deepRs)) {
  fail("deeplink.rs 里没有 manage(PendingDeepLinks::default()) —— 队列不存在，前端 drain 取不到任何东西");
}

// ---- 事件名：Rust 常量 ⟷ 前端常量 ----
// 这两个字符串各写一遍，对不上的表现是「前端永远等不到事件」——最纯粹的静默失败。
const rustEvent = read("src-tauri/src/deeplink.rs").match(
  /pub const EVENT_NEW_URL:\s*&str\s*=\s*"([^"]+)"/,
)?.[1];
const tsEvent = read("src/lib/platform/commands.ts").match(
  /export const DEEP_LINK_EVENT\s*=\s*"([^"]+)"/,
)?.[1];
if (!rustEvent) fail("src-tauri/src/deeplink.rs 里找不到 EVENT_NEW_URL 常量");
if (!tsEvent) fail("src/lib/platform/commands.ts 里找不到 DEEP_LINK_EVENT 常量");
if (rustEvent && tsEvent && rustEvent !== tsEvent) {
  fail(`事件名不一致：Rust "${rustEvent}" vs 前端 "${tsEvent}"（前端将永远等不到事件，且不报错）`);
}

// ---- 契约层：命令在 CommandMap 与 web shell 里都有位置 ----
if (!/^\s{2}deep_link_take:\s*\{\s*args/m.test(read("src/lib/platform/commands.ts"))) {
  fail("CommandMap 里没有 deep_link_take（api.ts 的调用就没有编译期校验）");
}
if (!/cmd\s*===\s*"deep_link_take"/.test(read("src/lib/platform/web.ts"))) {
  fail('web.ts 没实现 deep_link_take（Web 平台上会抛"未实现命令"）');
}

if (problems.length) {
  console.error("交付通道协议门禁未通过：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `交付通道协议一致：scheme ${schemes.map((s) => `${s}://`).join(", ")}；` +
    "single-instance 带 deep-link feature；插件已注册、事件已接、命令进 handler；" +
    `事件名 "${rustEvent}" 前后端一致；CommandMap 与 web shell 均已声明。`,
);
