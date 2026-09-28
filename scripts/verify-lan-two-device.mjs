// **局域网发现（甲-1）的真机验收**：谁收得到「代言公告」，基址换没换、同步是不是真的换过去。
//
// 为什么要有这个脚本：这条链**只有真机能验**（桌面/回环上看不出广播与 `content://` 那类问题），
// 而现场那套手工步骤（造绑定 → 配死地址 → 从 PC 发一条合法公告 → 读两家状态行）太容易漏步。
//
// 用法：
//   node scripts/verify-lan-two-device.mjs \
//     --announcer <serial>        # 主动发公告的那台（绑局域网地址；也可以不传，纯靠 --hub 由 PC 代发）
//     --listener  <serial>        # 被测那台（绑一个**死地址**且非局域网基址，如 http://127.0.0.1:8787）
//     --hub       http://192.168.43.206:8787   # 公告里声称的服务端基址（**必须是私有网段**）
//     --space     <远端 space_id>              # 公告里声称服务的空间
//     [--serial-space <announcer 的 space>]    # 可选：从同一台机器的 `sync_profiles` 里现取
//
// 它做四件事（每一步都打印读数，最后给 PASS/FAIL）：
//   ① 打开 listener 上的同步面板，读出**在此之前**的状态行（期望：公网 + 发现 N 台）；
//   ② 从 PC 往 listener 的 `47821` **单播**一条合法公告（`{v,device_id,device_name,hub_base,hub_spaces,fp}`）；
//   ③ 再读一次状态行（期望：`直连（局域网）<hub>` + `中枢：…`）；
//   ④ 把两句都打印出来并判定 —— 只读到一半（例如换了地址但状态行没说）也算 FAIL。
//
// ⚠️ 边界（别把它当成"全自动"）：`③` 用的是**单播**，绕开了"广播在真网段里能不能到"这件事
// （那要两台真机同网段：`announcer` 传了就用它，脚本会提示你去看它的状态行）。
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADB = process.env.ADB || "adb";
const PKG = process.env.SHUYO_ANDROID_PKG || "cn.shuyo.shuyonote";
const LAN_PORT = 47821;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const { announcer, listener, hub, space } = args;
if (!listener || !hub || !space) {
  console.error("用法：node scripts/verify-lan-two-device.mjs --listener <serial> --hub <http://192.168.x.y:8787> --space <space_id> [--announcer <serial>]");
  process.exit(2);
}
if (!/^http:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hub)) {
  console.error(`--hub 必须是**私有网段**的 http 基址（否则 lan::is_lan_base 会把这条公告跳过）：${hub}`);
  process.exit(2);
}

const adb = (serial, ...a) => execFileSync(ADB, ["-s", serial, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function phoneIp(serial, hubHost) {
  // ⚠️ 必须问**到 hub 那一跳**走哪个源地址：`ip route get 8.8.8.8` 在插着流量卡的手机上
  // 会回**蜂窝**那张网卡的地址（真机上踩到过：拿到 10.x 的移动网地址，公告就发错了地方）。
  // `ip route get` 只做路由查询、不发包。
  const out = adb(serial, "shell", `ip route get ${hubHost}`);
  const m = out.match(/src (\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : "";
}

function uiText(serial) {
  // 面板里那一行的原文（`lan_status` 的 `line`）——界面只显示 Rust 给的那串，不做二次判断。
  // 顺便把 body 前 200 字也带回来：读不到那一行时它能告诉你"面板到底开没开"。
  const js = `(() => {
    const rows = [...document.querySelectorAll('.sync-lan')].map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim());
    const vis = [...document.querySelectorAll('.sync-lan')].find(e => e.offsetParent !== null);
    return JSON.stringify({
      row: vis ? (vis.innerText || '').replace(/\\s+/g, ' ').trim() : (rows[0] ?? null),
      all: rows,
      body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
    });
  })()`;
  const tmp = join(tmpdir(), ".shuyo-lan-probe.js");
  writeFileSync(tmp, js, "utf8");
  const out = execFileSync(process.execPath, ["scripts/android-cdp.mjs", serial, "eval", tmp], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

function announce(targetIp, payload) {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.send(Buffer.from(JSON.stringify(payload)), LAN_PORT, targetIp, (err) => {
      sock.close();
      err ? reject(err) : resolve();
    });
  });
}

const results = {};
console.log(`[lan] listener=${listener} hub=${hub} space=${space}${announcer ? ` announcer=${announcer}` : ""}`);
const hubHost = hub.replace(/^https?:\/\//, "").split(/[/:]/)[0];
const ip = phoneIp(listener, hubHost);
console.log(`[lan] listener 到 ${hubHost} 这一跳的本机地址 = ${ip || "(取不到；后面的单播会失败)"}`);

// 先把 App 拉到前台，等 **devtools 套接字**就绪（`pidof` 有值不等于套接字已注册），
// 再**确保同步面板是开着的**（面板打开时才每 5s 轮询一次 `lan_status`）。
adb(listener, "shell", `am start -n ${PKG}/.MainActivity`);
const hasSocket = () => {
  try {
    return adb(listener, "shell", "cat /proc/net/unix").includes("webview_devtools_remote");
  } catch {
    return false;
  }
};
for (let i = 0; i < 20 && !hasSocket(); i++) await sleep(1000);
const cdp = (args) => {
  try {
    return execFileSync(process.execPath, ["scripts/android-cdp.mjs", listener, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const clickByLabel = (label) => cdp(["click", label]);
// ⚠️ **不要**上来就按返回键：面板没开时那一下会把应用整个关掉（本轮就踩到 ⇒ 套接字没了）。
// 只在"设置浮层真的开着"时关它。
if (cdp(["eval", join(tmpdir(), ".shuyo-lan-probe.js")]) === "" && false) {
  /* 占位：真正的检测在下面（见 settingsOpen） */
}
const settingsOpen = () => {
  const js = `(() => JSON.stringify({ s: !!document.querySelector('.settings-dialog'), lan: !!document.querySelector('.sync-lan') }))()`;
  const tmp = join(tmpdir(), ".shuyo-lan-state.js");
  writeFileSync(tmp, js, "utf8");
  const out = cdp(["eval", tmp]);
  try {
    return JSON.parse(out);
  } catch {
    return { s: false, lan: false };
  }
};
for (let i = 0; i < 3; i++) {
  const st = settingsOpen();
  if (st.s) {
    adb(listener, "shell", "input keyevent 4");
    await sleep(1500);
    continue;
  }
  if (st.lan) break;
  clickByLabel("同步");
  await sleep(2500);
}

results.before = uiText(listener);
console.log(`[lan] ① 发公告之前：${results.before.row ?? "(读不到那一行)"}`);
if (!results.before.row) {
  const body = String(results.before.body || "");
  if (body.includes("解锁") || body.includes("已加密锁定")) {
    // 加密空间在启动时是**锁着**的 ⇒ 同步面板根本没渲染。脚本**不能**替人输口令（也不该存口令）。
    console.error(`[lan] listener 处于**锁定屏** ⇒ 请先在设备上解锁，再跑一次本脚本。`);
    process.exit(2);
  }
  console.log(`[lan] ⚠️ 读不到 .sync-lan 那一行 ⇒ 面板没开或该空间没绑定。面板前 200 个字：`);
  console.log("      " + body.slice(0, 200));
}

const payload = {
  v: 1,
  device_id: "verify-lan-pc",
  device_name: "verify-lan（PC）",
  hub_base: hub,
  hub_spaces: [space],
  fp: "verify-lan-pc",
};
await announce(ip, payload);
console.log(`[lan] ② 已从 PC 单播一条公告到 ${ip}:${LAN_PORT}`);
await sleep(7000);

results.after = uiText(listener);
console.log(`[lan] ③ 发公告之后：${results.after.row ?? "(读不到那一行)"}`);

const line = results.after.row || "";
const switched = line.includes("直连（局域网）") && line.includes(hub);
const hasHub = line.includes("中枢：");
console.log(`[lan] ④ 判定：地址换成局域网 = ${switched} ｜ 状态行点出了中枢 = ${hasHub}`);
if (announcer) {
  console.log(
    `[lan] ⚠️ 你传了 --announcer：广播那一段请去那台上看它的状态行（本脚本只验 PC 单播这条确定的路）。\n` +
      `      两种情形：① 能看见 ⇒ 广播成立；② 看不见而这里 PASS ⇒ 广播在这套网段/ROM 上没到（见 docs/TESTING.md 那条方向性限制）。`,
  );
}
process.exit(switched && hasHub ? 0 : 1);
