#!/usr/bin/env node
// **发布后自检**：一条命令核对"线上那一份到底是不是我们发的那一份"。
//
// 为什么需要它：runbook ⑥⑦ 的自检一直是**手工**做的（拉 latest.json 看一眼、比 version.json、
// 去 Release 数资产……），而历史上真出过"国内主站静默停在 1.84.5、Pages 已经 1.89.0"这种事
// （见 RELEASING.md §⑦ 开头）。更狠的一次是 v1.91.0：**线上 APK 是坏的（装上闪退）**，
// 而当时所有"看版本号"的自检全是绿的——版本号对，包是坏的。
//
// 所以这里除了版本一致性，还钉**两件与字节有关的事**：
//   1. 通道里 android 条目的 `sha256:<hex>` 必须等于 GitHub Release 上那份 `.apk.sha256`
//      ⇒ 证明"更新通道指向的字节"与"发版流水线记录指纹的那个字节"是同一个；
//   2. 每个平台条目给的 URL 必须**真的可达**（HEAD，不下整包）。
//
// 用法：
//   node scripts/check-release-state.mjs                    # 用 package.json 的版本
//   node scripts/check-release-state.mjs --version 1.91.1
//   node scripts/check-release-state.mjs --skip-remote      # 只跑本地/通道检查（离线兜底）
//   node scripts/check-release-state.mjs --deep             # ★ 深检：所有远端读取走 `lib/gh-fetch.mjs`
//                                                          #   （直连为主、**只在网络类失败时**退到钉 IP，
//                                                          #    走过的路如实打进日志），并按**三态**判定：
//                                                          #    通过 / 红 / **未实查**（未实查**不算红**）
//   node scripts/check-release-state.mjs --deep --pinned-ip 140.82.112.6   # 显式给钉 IP（默认不钉）
//
// ⚠️ `--deep` 的**四约束**（与 `lib/gh-fetch.mjs` 同一份口径，写在这里免得下一个人"顺手对称"）：
//   ① **默认关**：不加 `--deep` 时行为与以前逐字相同（CI/发版例行自检不受影响）；
//   ② **复用同一条路**：深检下所有远端读取都走 `fetchWithFallback`，**不在本文件里再写一份 fetch**；
//   ③ **取不到 ≠ 不符**：三态判定在 `lib/remote-fact.mjs`（404 是事实⇒红；401/403、5xx、网络耗尽⇒**未实查**，
//      打印一行"未实查"就过，**不计入失败**）；
//   ④ **哈希单一来源**：要算哈希就用 `gh-fetch.sha256Hex`（本文件不自己 `createHash`）。
import { readFileSync } from "node:fs";
import { redactSecrets } from "./lib/redact.mjs";
import { fetchWithFallback } from "./lib/gh-fetch.mjs";
import { fetchVerdict, isRed } from "./lib/remote-fact.mjs";

const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SKIP_REMOTE = process.argv.includes("--skip-remote");
const DEEP = process.argv.includes("--deep");
const PINNED_IP = argOf("--pinned-ip") ?? process.env.GH_PINNED_IP ?? "";
const VERSION = (argOf("--version") ?? JSON.parse(readFileSync("package.json", "utf8")).version).replace(/^v/, "");
const TAG = `v${VERSION}`;
const CHANNEL = "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json";
const GH_REPO = "ShuyoNote/ShuyoNote";
const WEB_ENTRIES = ["https://shuyonote.github.io/ShuyoNote/", "https://shuyo.cn/app/"];

let pass = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

/**
 * 取一个 URL：不抛异常，返回 `{ code, body }`。
 *
 * ⚠️ **原先这里 spawn 的是 `curl.exe`** —— 于是在 macOS/Linux 上整条脚本的第一件事就是
 * `spawnSync curl.exe ENOENT`，五项判据全红（2026-09-18 我在 Mac 上实测）。
 * 而这条脚本的用途是"**发版后核一遍通道/资产/两个 Web 入口**"，偏偏 macOS 是发版机之一。
 * ⇒ 改成 Node 自带的 `fetch`：**跨平台、没有外部依赖**，也不再需要"为了带 Authorization 头
 * 再 spawn 一次 curl"那种绕法（那个绕法还差点把 token 打进日志，见下面 `redactSecrets` 的注释）。
 *
 * 可达性探测用 `Range: bytes=0-0`（1 字节）而不是 HEAD：实测 gitcode 的产物对 HEAD 一律 **401**
 * （只认带重定向的 GET），1 字节 GET 既跟随 302、又不真下 100MB 的 AppImage。
 */
async function httpGet(url, { method = "GET", timeout = 25, retries = 2, headers = {} } = {}) {
  if (!DEEP) return directGet(url, { method, timeout, retries, headers });

  // ---- 深检：走 `lib/gh-fetch.mjs`（约束②），并带上三态判定（约束③）----
  const r = await fetchWithFallback(url, {
    ...(PINNED_IP ? { pinnedIp: PINNED_IP, host: new URL(url).hostname } : {}),
    headers,
    timeoutMs: timeout * 1000,
  });
  // 约束④：走过的路**如实打进日志**（哪一种尝试、为什么退过去、最终哪条成功）
  for (const line of r.log) console.log(`  · [deep] ${line}`);
  const verdict = fetchVerdict(r);
  return {
    code: r.ok ? r.status : (r.status ?? 0),
    body: r.ok ? r.body.toString("utf8") : redactSecrets(String(r.log.at(-1) ?? "取不到")),
    ...(r.ok ? { sha256: r.sha256 } : {}),
    verdict: verdict.kind,
    why: verdict.why,
  };
}

/** 三态判定的落点：`unverified` ⇒ 打印「未实查」并**不计红**（约束③）；其余照旧走 `ok()`。 */
function okOrUnverified(res, cond, msg) {
  if (DEEP && !isRed({ kind: res?.verdict }) && res?.verdict !== "ok") {
    console.log(`  · 未实查：${msg}（${res?.verdict ?? "unverified"}｜**不是红**——取不到 ≠ 不符）`);
    return;
  }
  ok(cond, msg);
}

async function directGet(url, { method = "GET", timeout = 25, retries = 2, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: method === "HEAD" ? { ...headers, Range: "bytes=0-0" } : headers,
        signal: AbortSignal.timeout(timeout * 1000),
      });
      const body = await res.text();
      return { code: res.status, body };
    } catch (e) {
      if (attempt >= retries) return { code: 0, body: redactSecrets(String(e?.message ?? e)) };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function ghToken() {
  try {
    const creds = readFileSync(`${process.env.USERPROFILE ?? process.env.HOME}/.git-credentials`, "utf8");
    return (creds.match(/ghp_[A-Za-z0-9]{36}/) ?? [])[0] ?? "";
  } catch {
    return "";
  }
}

console.log(`[release-state] 目标版本 ${VERSION}（tag ${TAG}）`);
if (DEEP) {
  console.log(
    `[release-state] **深检模式**：远端读取走 lib/gh-fetch.mjs（直连为主${PINNED_IP ? `，网络类失败退到钉 IP ${PINNED_IP}` : "，未给 --pinned-ip ⇒ 不钉 IP"}）；` +
      `判定是三态：通过 / 红 / **未实查（不算红）**`,
  );
}

// ---- 1. 更新通道 ----
const chan = SKIP_REMOTE ? { code: 0, body: "" } : await httpGet(CHANNEL, { timeout: 40 });
let manifest = null;
if (!SKIP_REMOTE) {
  okOrUnverified(chan, chan.code === 200, `更新通道可达（HTTP ${chan.code}）`);
  try {
    manifest = JSON.parse(chan.body);
  } catch {
    okOrUnverified(chan, false, `更新通道返回的不是 JSON：${String(chan.body).slice(0, 120)}`);
  }
}
if (manifest) {
  ok(manifest.version === VERSION, `通道版本 = 仓库版本（通道 ${manifest.version} / 仓库 ${VERSION}）`);
  const platforms = manifest.platforms ?? {};
  const keys = Object.keys(platforms);
  ok(keys.length >= 3, `通道含 ≥3 个平台键（${keys.join(", ")}）`);
  for (const k of keys) {
    const e = platforms[k] ?? {};
    ok(typeof e.url === "string" && /^https:\/\//.test(e.url), `${k}：url 是绝对 https（${String(e.url).split("/").pop()}）`);
    ok(typeof e.signature === "string" && e.signature.trim() !== "", `${k}：signature 非空`);
    if (k === "android-aarch64") {
      ok(/^sha256:[0-9a-f]{64}$/.test(String(e.signature)), `${k}：signature 形状是 \`sha256:<64 hex>\``);
    }
    if (!SKIP_REMOTE) {
      // HEAD 只探可达性，不下整包（AppImage 有 100MB）。
      const h = await httpGet(e.url, { method: "HEAD", timeout: 40 });
      okOrUnverified(h, h.code === 200 || h.code === 302 || h.code === 206, `${k}：产物 URL 可达（HTTP ${h.code}）`);
    }
  }
}

// ---- 2. GitHub Release 资产 + Android 指纹互证 ----
if (!SKIP_REMOTE) {
  const tk = ghToken();
  if (!tk) {
    console.log("  · 跳过 GitHub Release 检查（读不到 ~/.git-credentials 里的 token）");
  } else {
    // ⚠️ 这里**不再 spawn curl**（原来为了带 `Authorization` 头要单独 spawn 一次，
    // 而 `execFileSync` 失败时 message 里带着整条 argv、里面有 Bearer token ——
    // 2026-09-16 发 1.91.3 时真的把 token 打进了终端，CI 上就是公开日志。
    // 现在换成进程内 `fetch`：**错误信息里没有 argv，token 无从泄漏**（后面仍保留 `redactSecrets` 兜底）。
    const r = await httpGet(`https://api.github.com/repos/${GH_REPO}/releases/tags/${TAG}`, {
      timeout: 30,
      headers: { Authorization: `Bearer ${tk}`, Accept: "application/vnd.github+json" },
    });
    let rel = null;
    try {
      rel = JSON.parse(r.body);
    } catch {
      okOrUnverified(r, false, `取 GitHub Release ${TAG} 失败：HTTP ${r.code} ${redactSecrets(r.body).slice(0, 120)}`);
    }
    if (rel) {
      const names = (rel.assets ?? []).map((a) => a.name);
      ok(!!rel.tag_name, `GitHub Release ${TAG} 存在（${names.length} 个资产）`);
      const need = [
        `ShuyoNote_${VERSION}_x64-setup.exe`,
        `ShuyoNote_${VERSION}_amd64.deb`,
        `ShuyoNote_${VERSION}_android-arm64-release.apk`,
        `ShuyoNote_${VERSION}_android-arm64-release.apk.sha256`,
      ];
      for (const n of need) ok(names.includes(n), `Release 含资产 ${n}`);
      // **与通道互证**：通道里的 android 指纹必须等于 Release 上那份 .sha256
      const sidecar = (rel.assets ?? []).find((a) => a.name.endsWith(".apk.sha256"));
      if (sidecar && manifest?.platforms?.["android-aarch64"]?.signature) {
        const s = await httpGet(sidecar.browser_download_url, { timeout: 40, retries: 4 });
        const want = String(manifest.platforms["android-aarch64"].signature).replace(/^sha256:/, "").toLowerCase();
        const got = (s.body.match(/[0-9a-f]{64}/i) ?? [""])[0].toLowerCase();
        if (DEEP && s.verdict === "unverified") {
          // 约束③：**取不到 ≠ 不符** —— 深检下这一格由三态判定接管（不再是"看到 code!==200 就跳过"）。
          okOrUnverified(s, false, "APK 指纹互证（取 .sha256）");
        } else if (got === "" && s.code === 0) {
          // 网络问题 ≠ 指纹不符：**分开报**，否则会把"GitHub 连不上"误当成"发错了包"。
          console.log(`  · 跳过 APK 指纹互证：取 .sha256 失败（HTTP ${s.code}，网络原因）——重跑一次即可`);
        } else {
          ok(
            got !== "" && got === want,
            `通道里的 APK 指纹 = Release 上那份 .sha256（${want.slice(0, 12)}… / ${got.slice(0, 12) || "（没读到）"}…）` +
              `——这一条挡的是"通道指向的字节根本不是我们记录过指纹的那个"`,
          );
        }
      }
    }
  }
}

// ---- 3. 两个 Web 入口（详细版在 pnpm check:web-deploy） ----
if (!SKIP_REMOTE) {
  for (const base of WEB_ENTRIES) {
    const r = await httpGet(new URL("version.json", base).href, { timeout: 25 });
    let v = null;
    try {
      v = JSON.parse(r.body).version;
    } catch {
      /* 下面统一报 */
    }
    okOrUnverified(r, v === VERSION, `${base} 的 version.json = ${VERSION}（实测 ${v ?? `HTTP ${r.code}`}）`);
  }
}

console.log(`[结果] release-state ${failed === 0 ? "通过" : `${failed} 项失败`}（${pass} 通过）`);
process.exit(failed === 0 ? 0 : 1);
