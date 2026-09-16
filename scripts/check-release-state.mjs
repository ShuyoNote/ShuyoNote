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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { redactSecrets } from "./lib/redact.mjs";

const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SKIP_REMOTE = process.argv.includes("--skip-remote");
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

/** curl：不抛异常，返回 { code, body }。可达性探测用 `-r 0-0`（1 字节）而不是 HEAD。 */
function curl(url, { method = "GET", timeout = 25, retries = 2 } = {}) {
  // ⚠️ 不要用 HEAD 探 gitcode 的产物：实测对 HEAD 一律 **401**（它只认带重定向的 GET），
  // 用 `-r 0-0` 只取 1 字节，既跟随 302、又不真下 100MB 的 AppImage。
  const args = ["-sS", "-L", "--max-time", String(timeout)];
  if (retries > 0) args.push("--retry", String(retries), "--retry-all-errors", "--retry-delay", "2");
  if (method === "HEAD") args.push("-r", "0-0");
  args.push("-w", "\n%{http_code}", url);
  try {
    const out = execFileSync("curl.exe", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const i = out.lastIndexOf("\n");
    return { code: Number(out.slice(i + 1).trim()), body: out.slice(0, i) };
  } catch (e) {
    return { code: 0, body: String(e.stdout ?? e.message) };
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

// ---- 1. 更新通道 ----
const chan = SKIP_REMOTE ? { code: 0, body: "" } : curl(CHANNEL, { timeout: 40 });
let manifest = null;
if (!SKIP_REMOTE) {
  ok(chan.code === 200, `更新通道可达（HTTP ${chan.code}）`);
  try {
    manifest = JSON.parse(chan.body);
  } catch {
    ok(false, `更新通道返回的不是 JSON：${chan.body.slice(0, 120)}`);
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
      const h = curl(e.url, { method: "HEAD", timeout: 40 });
      ok(h.code === 200 || h.code === 302 || h.code === 206, `${k}：产物 URL 可达（HTTP ${h.code}）`);
    }
  }
}

// ---- 2. GitHub Release 资产 + Android 指纹互证 ----
if (!SKIP_REMOTE) {
  const tk = ghToken();
  if (!tk) {
    console.log("  · 跳过 GitHub Release 检查（读不到 ~/.git-credentials 里的 token）");
  } else {
    const r = curl(`https://api.github.com/repos/${GH_REPO}/releases/tags/${TAG}`, { timeout: 30 });
    // curl 不带自定义头，改用 node 的 https 会更好，但这里保持"只用 curl"的简单约定：
    // 用 -H 版本单独跑一次。
    const args = [
      "-sS", "-L", "--max-time", "30",
      "-H", `Authorization: Bearer ${tk}`,
      "-H", "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${GH_REPO}/releases/tags/${TAG}`,
    ];
    let rel = null;
    try {
      rel = JSON.parse(execFileSync("curl.exe", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    } catch (e) {
      // ⚠️ 这里必须抹一道：`execFileSync` 失败时 message 里带着整条 argv，
      // 而 argv 里有 `Authorization: Bearer <token>`——2026-09-16 发 1.91.3 时
      // 真的把 token 打进了终端（CI 上就是公开日志）。判据见 scripts/lib/redact.test.mjs。
      ok(false, `取 GitHub Release ${TAG} 失败：${redactSecrets(String(e.message)).slice(0, 120)}`);
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
        const s = curl(sidecar.browser_download_url, { timeout: 40, retries: 4 });
        const want = String(manifest.platforms["android-aarch64"].signature).replace(/^sha256:/, "").toLowerCase();
        const got = (s.body.match(/[0-9a-f]{64}/i) ?? [""])[0].toLowerCase();
        if (got === "" && s.code === 0) {
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
    const r = curl(new URL("version.json", base).href, { timeout: 25 });
    let v = null;
    try {
      v = JSON.parse(r.body).version;
    } catch {
      /* 下面统一报 */
    }
    ok(v === VERSION, `${base} 的 version.json = ${VERSION}（实测 ${v ?? `HTTP ${r.code}`}）`);
  }
}

console.log(`[结果] release-state ${failed === 0 ? "通过" : `${failed} 项失败`}（${pass} 通过）`);
process.exit(failed === 0 ? 0 : 1);
