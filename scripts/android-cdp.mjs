// 按 DOM 驱动安卓真机上的 WebView（CDP）——**真机验收的唯一稳路**（比 `input tap` 稳得多）。
//
// 用法（`<serial>` 来自 `adb devices`）：
//   node scripts/android-cdp.mjs <serial> text            # 打印 document.body.innerText（截断）
//   node scripts/android-cdp.mjs <serial> pid             # 本 App 的 pid 与 devtools 套接字
//   node scripts/android-cdp.mjs <serial> eval <文件.js>   # 在页面里求值那个文件（避免引号地狱）
//   node scripts/android-cdp.mjs <serial> click <文字>     # 点第一个可见且文字含 <文字> 的按钮/链接
//
// ⚠️ 三条踩过的坑（2026-09-25 实测）：
//   1. **套接字必须按本 App 的 pid 挑**：同一台机器上别的 App（现场是个视频 App）也有
//      `webview_devtools_remote_*` ⇒ 不看 pid 就会连到**别人**的页面上，读出一段完全无关的界面。
//   2. `uiautomator dump` 在部分 ROM（MIUI）上直接 `null root node` ⇒ 那时的兜底是
//      `adb exec-out screencap -p` ＋ 看图定位坐标（**别走 PowerShell 的 `>`**，二进制会被改写）。
//   3. WebView 的 devtools 口只在**进程活着**时才有：先 `am start -n <包>/.MainActivity`。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ADB = process.env.ADB || "adb";
const PKG = process.env.SHUYO_ANDROID_PKG || "cn.shuyo.shuyonote";

const [serial, cmd, arg] = process.argv.slice(2);
if (!serial || !cmd) {
  console.error("用法：node scripts/android-cdp.mjs <serial> text|pid|eval <file.js>|click <文字>");
  process.exit(2);
}
const adb = (...a) => execFileSync(ADB, ["-s", serial, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = (() => {
  try {
    return (adb("shell", `pidof ${PKG}`).trim().split(/\s+/)[0] || "");
  } catch {
    return "";
  }
})();
if (cmd === "pid") {
  console.log(JSON.stringify({ serial, pkg: PKG, pid }));
  process.exit(pid ? 0 : 1);
}

// 挑**本 App** 的 devtools 套接字（坑 1）。
const unix = adb("shell", "cat", "/proc/net/unix");
let sock = pid ? (unix.match(new RegExp(`@?([^\\s]*webview_devtools_remote_${pid})`)) || [])[1] : null;
if (!sock) {
  sock = (unix.match(/@?([^\s]*webview_devtools_remote[^\s]*)/) || [])[1];
  if (sock) console.error(`[cdp] 拿不到本 App 的 pid ⇒ 退回第一个 webview 套接字（可能不是本 App！）`);
}
if (!sock) {
  console.error(`[cdp] ${PKG} 没有 webview devtools 套接字（应用没跑？先 am start）`);
  process.exit(1);
}
adb("forward", "tcp:9222", `localabstract:${sock.replace(/^@/, "")}`);

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = list.find((t) => t.type === "page") || list[0];
if (!target) {
  console.error("[cdp] 没有 page target：" + JSON.stringify(list));
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    p(m);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    console.error("EXCEPTION: " + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    process.exit(3);
  }
  return r.result?.result?.value;
}

let out;
if (cmd === "text") {
  out = await evaluate("document.body.innerText.replace(/\\s+/g,' ').slice(0,2000)");
} else if (cmd === "eval") {
  if (!arg) {
    console.error("eval 要一个 .js 文件路径");
    process.exit(2);
  }
  out = await evaluate(readFileSync(arg, "utf8"));
} else if (cmd === "click") {
  out = await evaluate(`(() => {
    const want = ${JSON.stringify(arg || "")};
    const els = [...document.querySelectorAll('button,[role="button"],a,label,span,div')];
    const el = els.find((e) => e.offsetParent !== null && e.children.length === 0 && (e.innerText || '').includes(want));
    if (!el) return 'not-found';
    el.click();
    return 'clicked:' + (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
  })()`);
} else {
  console.error(`不认识的命令：${cmd}`);
  process.exit(2);
}
console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
await sleep(50);
ws.close();
