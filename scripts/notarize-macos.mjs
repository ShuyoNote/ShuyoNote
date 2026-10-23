#!/usr/bin/env node
// macOS **公证（notarization）＋ 装订（stapling）＋ Gatekeeper 复核**。
//
// ## 为什么需要它（而不是"配好 APPLE_* 让 Tauri 自己做"）
// `docs/macos-updater.md` §四 说 Tauri 2 在配好 `APPLE_*` 后会自动 `notarytool submit` + `stapler`。
// 那是真的，但它有两个代价：
//   ① **成功与否不可读** —— 只要不失败，CI 日志里看不到 `Accepted`、看不到 `stapler validate`、
//      看不到 `spctl accepted`。而"公证失败"的典型形态是**签名链全绿、dmg 照出**，用户装的时候才被
//      Gatekeeper 拦（`rejected, source=Unnotarized Developer ID`）；
//   ② **它把"签名"和"公证"耦合成一个开关** —— 本地想只签名（不出网、不碰 Apple 服务器）时，
//      只能把 `APPLE_ID` 摘掉；而 CI 里想显式控制顺序（先 app 后 dmg、各自 staple）也没有抓手。
// ⇒ 本脚本把这条链**显式化**，并且**自己出判据**：三件事缺一不可 ——
//      notarytool 的 `status: Accepted` ＋ `stapler validate` 通过 ＋ `spctl` 说 accepted。
//
// ## 用法
//   node scripts/notarize-macos.mjs                     # 公证 bundle 里的 .app 与 .dmg
//   node scripts/notarize-macos.mjs --app <x.app>       # 只公证 .app
//   node scripts/notarize-macos.mjs --dmg <x.dmg>       # 只公证 .dmg
//   node scripts/notarize-macos.mjs --keychain-profile shuyonote-notary   # 用本机存好的凭据
//   node scripts/notarize-macos.mjs --dry-run           # 只打印将要执行的命令（密码打码）
//
// 环境变量（二选一）：
//   · APPLE_ID ＋ APPLE_PASSWORD（**App 专用密码**，不是登录密码）＋ APPLE_TEAM_ID   —— CI 用
//   · 或 `xcrun notarytool store-credentials <profile>` 之后用 --keychain-profile  —— 本机用
//
// 退出码（与工作区/本仓一致）：0 = 三件判据全过；1 = 公证/装订/复核失败；2 = 环境不具备（工具缺、凭据缺）。
//
// ## 边界（不冒领）
// · 本脚本**不做签名**：签名由 `tauri build`（有 `APPLE_SIGNING_IDENTITY` 时）或
//   `scripts/sign-macos-app.mjs`（本机、无凭据）完成。但它会**复核**签名不是 ad-hoc ——
//   因为 ad-hoc 的包一定过不了公证，而报错会发生在 Apple 服务器那一侧，读起来像"网络问题"。
// · `.dmg` 的公证是**对 dmg 本身**做的（Apple 支持 dmg/zip/pkg），staple 也 staple dmg；
//   `.app` 的公证走 `ditto -c -k --keepParent` 打的 zip（**必须带 --keepParent**，否则 Apple
//   看到的不是 bundle 结构，会以 `The archive did not contain a valid app bundle` 拒收）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = join(root, "src-tauri", "target", "release", "bundle");

/** notarytool 只认这一个成功状态；其它（Invalid / In Progress / Rejected）都不算过。 */
export const ACCEPTED = "Accepted";

/** `notarytool submit` 的参数（纯函数；密码不进日志，只在 argv 里）。 */
export function submitArgs(zip, { appleId, password, teamId, keychainProfile } = {}) {
  const args = ["notarytool", "submit", zip, "--wait", "--output-format", "json"];
  if (keychainProfile) args.push("--keychain-profile", keychainProfile);
  else args.push("--apple-id", appleId, "--password", password, "--team-id", teamId);
  return args;
}

/** 非 Accepted 时取回逐条问题（`notarytool log`）用的参数。 */
export function logArgs(id, { appleId, password, teamId, keychainProfile } = {}) {
  const args = ["notarytool", "log", id, "--output-format", "json"];
  if (keychainProfile) args.push("--keychain-profile", keychainProfile);
  else args.push("--apple-id", appleId, "--password", password, "--team-id", teamId);
  return args;
}

/** 装订／校验用的参数。 */
export function stapleArgs(target) {
  return ["stapler", "staple", target];
}
export function validateArgs(target) {
  return ["stapler", "validate", target];
}

/** Gatekeeper 复核参数：.app 按可执行文件评、.dmg 按"主签名"评（Apple 文档里的两种 type）。 */
export function spctlArgs(kind, target) {
  return kind === "dmg"
    ? ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", target]
    : ["--assess", "--type", "execute", "-vv", target];
}

/** `codesign -d --verbose=4` 的参数（详情写到 stderr，调用方两条流都收）。 */
export function codesignArgs(target) {
  return ["-d", "--verbose=4", target];
}

/**
 * 解析 `notarytool submit --output-format json` 的 stdout。
 *
 * 实测形状（Apple 文档＋本机 `notarytool submit` 的输出）：
 *   {"id":"<uuid>","status":"Accepted","message":"Successfully uploaded file"}
 *   {"id":"<uuid>","status":"Invalid","message":"..."}
 * ⚠️ 解析失败时**不许**当成成功：返回 null，由调用方判失败（本脚本第一版就差点把空对象读成通过）。
 */
export function parseSubmit(stdout) {
  try {
    const v = JSON.parse(String(stdout).trim());
    if (!v || typeof v.id !== "string" || typeof v.status !== "string") return null;
    return { id: v.id, status: v.status, message: v.message ?? "" };
  } catch {
    return null;
  }
}

/**
 * 从 `notarytool log` 的 JSON 里抽出给人看的问题清单（纯函数）。
 * 形状：{"issues":[{"severity":"error","path":"…","message":"…"}]}；字段缺失就跳过。
 */
export function parseNotaryLog(logJson) {
  let v;
  try {
    v = typeof logJson === "string" ? JSON.parse(logJson) : logJson;
  } catch {
    return [];
  }
  const issues = Array.isArray(v?.issues) ? v.issues : [];
  return issues
    .map((i) => {
      const sev = i?.severity ?? "?";
      const path = i?.path ?? "";
      const msg = i?.message ?? i?.docUrl ?? "";
      return [sev, path, msg].filter(Boolean).join(" | ");
    })
    .filter(Boolean);
}

/**
 * 从 `codesign -d --verbose=4` 的输出里取身份（纯函数）。
 * 真实身份那几行形如 `Authority=Developer ID Application: NAME (TEAMID)`；
 * ad-hoc 只有 `Signature=adhoc`、没有任何 `Authority=`。
 */
export function signingAuthority(details) {
  const m = /Authority=([^\n]+)/.exec(String(details ?? ""));
  return m ? m[1].trim() : null;
}

/**
 * ★ 三件判据的**总判定**（纯函数；单测就盯这里）。
 * 任何一条不成立都不算过 —— 尤其是"submit 说 Accepted 但没 staple"：
 * 那样离线机器上仍会被 Gatekeeper 拦，而 CI 日志看起来全绿。
 */
export function verdict({ submit, stapled, spctlOutput, authority }, kind) {
  const problems = [];
  if (!submit) {
    problems.push("notarytool 的输出**解析不了**（不是 JSON / 缺 id/status）——按失败处理，别当成通过");
  } else if (submit.status !== ACCEPTED) {
    problems.push(`notarytool 状态是 ${submit.status}（不是 ${ACCEPTED}）—— 看上面的 log 问题清单`);
  }
  if (!stapled) problems.push(`stapler validate 没过（${kind}）—— 已 Accepted 但没装订票据，离线机器仍会被拦`);
  if (!/accepted/i.test(String(spctlOutput ?? ""))) {
    problems.push(`spctl 没说 accepted（${kind}）—— Gatekeeper 仍会拒：${String(spctlOutput ?? "(无输出)").trim()}`);
  }
  if (!authority) {
    problems.push("签名里找不到 `Authority=`（ad-hoc 签名）—— 这种包不可能公证通过，报错会在 Apple 那侧");
  }
  return problems;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runAllowFail(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args), err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? ""), err: String(e.stderr ?? e.message ?? "") };
  }
}

/**
 * Gatekeeper 的评估结果在 staple 之后可能有短暂延迟（本机 2026-10-23 实测：
 * 刚 staple 完立刻跑 spctl/codesign 曾拿到空输出，几秒后同一份产物就是 accepted）。
 * 这不是"随机重试掩盖失败"：每轮仍按同一判据判，超过次数仍原样判红。
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryAllowFail(cmd, args, predicate, { attempts = 12, delayMs = 5000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = runAllowFail(cmd, args);
    if (predicate(last)) return last;
    if (i < attempts - 1) sleepMs(delayMs);
  }
  return last;
}

function redact(args) {
  const out = [...args];
  const i = out.indexOf("--password");
  if (i >= 0) out[i + 1] = "********";
  return out;
}

function latestDmg(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".dmg"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function credentialsFromEnv() {
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE || null;
  if (keychainProfile) return { keychainProfile };
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !password || !teamId) return null;
  return { appleId, password, teamId };
}

/** 校验一个目标（app / dmg）：submit → staple → validate → spctl → 身份复核。 */
function notarizeTarget(kind, target, creds, { dryRun }) {
  const tmp = kind === "app" ? mkdtempSync(join(tmpdir(), "shuyonote-notary-")) : null;
  const zip = kind === "app" ? join(tmp, "ShuyoNote.zip") : target;

  const plan = [];
  if (kind === "app") plan.push(["ditto", ["-c", "-k", "--keepParent", target, zip]]);
  plan.push(["xcrun", submitArgs(zip, creds)]);
  plan.push(["xcrun", stapleArgs(target)]);
  plan.push(["xcrun", validateArgs(target)]);
  plan.push(["/usr/sbin/spctl", spctlArgs(kind, target)]);
  plan.push(["codesign", codesignArgs(target)]);

  console.log(`\n[notarize-macos] ${kind}: ${target}`);
  for (const [cmd, args] of plan) console.log(`  $ ${cmd} ${redact(args).join(" ")}`);
  if (dryRun) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    return { problems: [] };
  }

  if (kind === "app") {
    run("ditto", ["-c", "-k", "--keepParent", target, zip]);
  }

  // ① 提交并等结果
  const submitRes = runAllowFail("xcrun", submitArgs(zip, creds));
  const submit = parseSubmit(submitRes.out) ?? parseSubmit(submitRes.err);
  if (!submit || submit.status !== ACCEPTED) {
    console.error(`  ❌ notarytool：${submit ? `${submit.status}（${submit.message}）` : "输出解析不了"}`);
    if (submit?.id) {
      const logRes = runAllowFail("xcrun", logArgs(submit.id, creds));
      const issues = parseNotaryLog(logRes.out || logRes.err);
      if (issues.length) {
        console.error("  —— 问题清单：");
        for (const line of issues) console.error(`    · ${line}`);
      } else {
        console.error(`  （notarytool log 没有可解析的 issues；原始输出：${(logRes.err || logRes.out).slice(0, 800)}）`);
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    return { problems: [`${kind}: notarytool 未返回 ${ACCEPTED}`] };
  }
  console.log(`  ✅ notarytool: ${submit.status}（id=${submit.id}）`);

  // ② 装订并校验票据
  const staple = runAllowFail("xcrun", stapleArgs(target));
  if (!staple.ok) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    return { problems: [`${kind}: stapler staple 失败：${(staple.err || "").slice(0, 500)}`] };
  }
  const validate = runAllowFail("xcrun", validateArgs(target));
  const stapled = validate.ok && /valid/i.test(`${validate.out}${validate.err}`);
  console.log(`  ${stapled ? "✅" : "❌"} stapler validate${stapled ? "：valid" : `（exit≠0）${(validate.err || validate.out).slice(0, 300)}`}`);

  // ③ Gatekeeper + 身份复核（staple 后给系统几秒刷新；判据不变，只是重试）
  const spctl = retryAllowFail("/usr/sbin/spctl", spctlArgs(kind, target), (r) =>
    /accepted/i.test(`${r.out}${r.err}`),
  );
  const spctlOutput = `${spctl.out}${spctl.err}`;
  console.log(`  ${/accepted/i.test(spctlOutput) ? "✅" : "❌"} spctl: ${spctlOutput.trim().split("\n").slice(-1)[0]}`);
  const details = retryAllowFail("codesign", codesignArgs(target), (r) =>
    /Authority=/.test(`${r.out}${r.err}`),
  );
  const authority = signingAuthority(`${details.out}${details.err}`);
  console.log(`  ${authority ? "✅" : "❌"} 签名身份：${authority ?? "（没有 Authority，ad-hoc）"}`);

  if (tmp) rmSync(tmp, { recursive: true, force: true });
  const problems = verdict({ submit, stapled, spctlOutput, authority }, kind);
  return { problems: problems.map((p) => `${kind}: ${p}`) };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const dryRun = argv.includes("--dry-run");
  const creds = credentialsFromEnv();
  const appPath = resolve(flag("--app") ?? join(BUNDLE_DIR, "macos", "ShuyoNote.app"));
  const dmgPath = resolve(flag("--dmg") ?? latestDmg(join(BUNDLE_DIR, "dmg")) ?? join(BUNDLE_DIR, "dmg", "ShuyoNote.dmg"));

  console.log(`[notarize-macos] bundle 目录：${BUNDLE_DIR}`);
  console.log(`  .app：${existsSync(appPath) ? appPath : `（不存在）${appPath}`}`);
  console.log(`  .dmg：${existsSync(dmgPath) ? dmgPath : `（不存在）${dmgPath}`}`);

  if (!creds) {
    console.error(
      "[notarize-macos] ❌ 缺凭据（不算通过）：\n" +
        "  · CI：APPLE_ID ＋ APPLE_PASSWORD（App 专用密码）＋ APPLE_TEAM_ID\n" +
        "  · 本机：xcrun notarytool store-credentials <profile> 之后加 --keychain-profile <profile>",
    );
    process.exit(2);
  }
  for (const tool of [["xcrun", ["--find", "notarytool"]], ["ditto", ["--help"]]]) {
    const probe = runAllowFail(tool[0], tool[1]);
    if (!probe.ok && !/usage/i.test(`${probe.out}${probe.err}`)) {
      console.error(`[notarize-macos] ❌ 环境不具备：${tool[0]} 不可用 —— 先执行 sudo xcodebuild -license accept（不算通过）`);
      process.exit(2);
    }
  }

  const targets = [];
  if (existsSync(appPath)) targets.push(["app", appPath]);
  if (existsSync(dmgPath)) targets.push(["dmg", dmgPath]);
  if (targets.length === 0) {
    console.error("[notarize-macos] ❌ 没有可公证的产物（先 `pnpm tauri build --bundles app,dmg`）—— 不算通过");
    process.exit(2);
  }

  const problems = [];
  for (const [kind, target] of targets) {
    const r = notarizeTarget(kind, target, creds, { dryRun });
    problems.push(...r.problems);
  }

  if (problems.length > 0) {
    console.error("\n[notarize-macos] ❌ 不通过：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    dryRun
      ? "\n[notarize-macos] --dry-run：到此为止（没有提交任何东西）"
      : "\n[notarize-macos] ✅ 公证 Accepted ＋ 已装订 ＋ Gatekeeper accepted",
  );
}

if (isMain(import.meta.url)) main();
