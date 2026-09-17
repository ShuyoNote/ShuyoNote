#!/usr/bin/env node
// **打 tag 之前**的前置检查。一条命令回答："现在能不能发这一版？"
//
// 为什么需要它：runbook ④ 的硬前提是"进 main 的东西必须来自 dev"，2026-09-15 发 1.91.0 时
// 就是**推到一半才发现不成立**（`git merge-base --is-ancestor origin/dev main` 为假，
// dev 上还有 3 个提交），只能停下来先合并再继续。同类卡壳还有：版本号六处不一致、
// CHANGELOG 没开对应版本段、tag 名已被占用、工作区有未提交改动、某个远端连不上
// （GitHub 在国内经常要换路子，见 RELEASING.md ④ 的两条可用路线）。
//
// 这些全是"机器一眼能看出来、而人常常想当然"的事，所以收成一条命令：
//   pnpm release:preflight            # 用 package.json 的版本
//   pnpm release:preflight --skip-remote   # 离线：跳过远端可达性与 dev 祖先检查
// 退出码非 0 就别打 tag。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { summaryLine } from "./lib/report-core.mjs";

const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SKIP_REMOTE = process.argv.includes("--skip-remote");
const VERSION = (argOf("--version") ?? JSON.parse(readFileSync("package.json", "utf8")).version).replace(/^v/, "");
const TAG = `v${VERSION}`;

let failed = 0;
let warned = 0;
const ok = (cond, msg, hint) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}${hint ? `\n      ⇒ ${hint}` : ""}`);
  }
};
const warn = (msg) => {
  warned++;
  console.log(`  ! ${msg}`);
};

/** 跑一条命令，返回 { code, out }（不抛）。 */
function run(cmd, args, { timeout = 60000 } = {}) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

/**
 * 跑一条**远端** git 命令：先按当前环境跑（可能带 HTTP(S)_PROXY），失败再显式绕过代理重试。
 *
 * 为什么要有这一层：这台机器上 `HTTP(S)_PROXY` 指向本地 127.0.0.1:7897，而那个代理**不一定开着**；
 * 实测 gitcode 会因此报 `Failed to connect to 127.0.0.1 port 7897`，看着像"远端不可达"。
 * 本会话里所有推送都是靠 `-c http.proxy= -c https.proxy=` 绕过去才成功的（见 RELEASING.md ④），
 * 所以这里也照做，并把"是不是绕过去了"如实报出来。
 */
function gitRemote(args, { timeout = 90000 } = {}) {
  const first = run("git", args, { timeout });
  if (first.code === 0) return { ...first, via: "环境默认" };
  const second = run("git", ["-c", "http.proxy=", "-c", "https.proxy=", ...args], { timeout });
  if (second.code === 0) return { ...second, via: "绕过代理（环境里那个 HTTP(S)_PROXY 不可用）" };
  return { ...second, via: null, firstError: first.out };
}

console.log(`[preflight] 目标版本 ${VERSION}（tag ${TAG}）\n`);
const PKG_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
if (PKG_VERSION !== VERSION) {
  console.log(`  · 注意：package.json 还是 ${PKG_VERSION}，与目标版本 ${VERSION} 不同`);
  console.log(`    （② 查的是仓库里六处是否**互相**一致；CHANGELOG/tag 那两项查的是目标版本）\n`);
}

// ---- 1. 在 main 上、工作区干净 ----
console.log("① 仓库状态");
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
ok(branch === "main", `当前分支是 main（实测 ${branch}）`, "发版只在 main 上做");
const status = run("git", ["status", "--porcelain"]).out.trim();
const lines = status ? status.split("\n") : [];
const dirty = lines.filter((l) => !l.startsWith("??"));
const untracked = lines.filter((l) => l.startsWith("??"));
ok(dirty.length === 0, `没有未提交的改动（已跟踪文件）`, `先提交或 stash：\n      ${dirty.join("\n      ")}`);
if (untracked.length > 0) warn(`有未跟踪文件（不影响发版，但确认一下不是漏 add 的）：${untracked.map((l) => l.slice(3)).join("、")}`);

// ---- 2. 版本号六处一致 ----
console.log("\n② 版本号");
const cv = run(process.execPath, ["scripts/check-versions.mjs"]);
ok(cv.code === 0, `` + (cv.out.trim().split("\n").pop() ?? "check-versions 通过"), "跑 `pnpm check:versions` 看明细");

// ---- 3. CHANGELOG 有这一版的段，且 [Unreleased] 在顶部 ----
console.log("\n③ CHANGELOG");
const cl = readFileSync("CHANGELOG.md", "utf8");
ok(new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\]`, "m").test(cl), `有 \`## [${VERSION}]\` 段`, "先 `node scripts/update-changelog.mjs <版本> \"主题\"` 再补内容");
ok(/^## \[Unreleased\]/m.test(cl), "`## [Unreleased]` 仍在（下一版的落点）");
const cc = run(process.execPath, ["scripts/check-changelog.mjs"]);
ok(cc.code === 0, cc.out.trim().split("\n").pop() ?? "check-changelog 通过");

// ---- 4. tag 没被占用（本地 + 两个远端） ----
console.log("\n④ tag 占用");
ok(run("git", ["rev-parse", "-q", "--verify", `refs/tags/${TAG}`]).code !== 0, `本地没有 ${TAG}`, "已发布的 tag 不要复用：改版本号再发（见 RELEASING.md ⑤「旧件冒充新件」）");
if (!SKIP_REMOTE) {
  for (const remote of ["origin", "github"]) {
    const r = gitRemote(["ls-remote", "--tags", remote, TAG]);
    if (r.via === null) {
      warn(`${remote} 查不到 tag（远端不可达或没配）：${r.out.trim().split("\n").pop() ?? ""}`);
      continue;
    }
    if (r.via !== "环境默认") console.log(`  · ${remote}：${r.via}`);
    ok(r.out.trim() === "", `${remote} 上也没有 ${TAG}`, `远端已有这个 tag ⇒ 换个版本号`);
  }
}

// ---- 5. dev 是否已进 main（runbook ④ 的硬前提） ----
if (!SKIP_REMOTE) {
  console.log("\n⑤ dev → main（runbook ④ 的硬前提）");
  const fetch = gitRemote(["fetch", "origin", "dev", "main"], { timeout: 120000 });
  if (fetch.via === null) {
    warn(`取 origin 失败（离线？）：${fetch.out.trim().split("\n").pop() ?? ""}`);
  } else {
    if (fetch.via !== "环境默认") console.log(`  · origin：${fetch.via}`);
    const anc = run("git", ["merge-base", "--is-ancestor", "origin/dev", "main"]);
    const ahead = run("git", ["rev-list", "--count", "main..origin/dev"]).out.trim();
    ok(
      anc.code === 0,
      anc.code === 0
        ? "origin/dev 已是 main 的祖先（dev 上的东西都进来了）"
        : `origin/dev 还不是 main 的祖先（dev 上还有 ${ahead} 个提交没进 main）`,
      "先 `git merge --no-ff origin/dev` 把 dev 并进来再发（**不要**把特性分支直接合进 main）",
    );
  }
}

// ---- 6. 两个远端可达 ----
if (!SKIP_REMOTE) {
  console.log("\n⑥ 远端可达");
  for (const remote of ["origin", "github"]) {
    const r = gitRemote(["ls-remote", "--exit-code", remote, "HEAD"]);
    ok(
      r.via !== null,
      r.via ? `${remote} 可达（${r.via}）` : `${remote} 不可达`,
      remote === "github"
        ? "GitHub 常要换路子：优先 SSH over 443（见 RELEASING.md ④ 的两条可用路线）"
        : "gitcode 连不上时别硬推：先确认环境里的 HTTP(S)_PROXY 是否需要绕开（本会话一直是绕开的）",
    );
  }
} else {
  console.log("\n⑤⑥ 已按 --skip-remote 跳过（dev 祖先检查 + 远端可达）");
}

// ---- 7. 回归门禁的最近一次报告 ----
// 为什么加这一条："CI 全绿"此前只靠人眼看 Actions 页面——而**看的是哪一次**常常说不清
// （推送后、打 tag 前又改过东西的情形真实发生过）。这里读机器可读的报告：有收据才放行，
// 红了就别打 tag。报告的生成方式见 docs/TESTING.md（本地 `pnpm verify:all`，或把 CI artifact
// 落到 .test-report-out/ 下；也可以直接用 TEST_REPORT_JSON 指一份）。
console.log("\n⑦ 回归门禁（读最近一次 test-report 报告）");
{
  const dir = ".test-report-out";
  const candidates = [
    process.env.TEST_REPORT_JSON,
    "test-report-checks.json",
    "test-report-browser.json",
    "test-report-mobile.json",
    "test-report-rust.json",
    "test-report-artifact.json",
  ].filter((f) => f && existsSync(f));
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) candidates.push(`${dir}/${f}`);
  }
  // 取"门禁条数最多、同条数取最新"的那一份（CI 每个 job 一份报告，本地综合跑会写一份更全的）。
  let best = null;
  for (const f of candidates) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (!Array.isArray(j.results)) continue;
      const at = Date.parse(j.startedAt || "") || 0;
      if (!best || j.results.length > best.j.results.length || (j.results.length === best.j.results.length && at > best.at)) {
        best = { f, j, at };
      }
    } catch {
      /* 不是报告文件就跳过 */
    }
  }
  if (!best) {
    warn("没有找到门禁报告——发版前先 `pnpm verify:all`（或把 CI artifact 落到 .test-report-out/ 下）");
  } else {
    const ageMin = Math.round((Date.now() - (Date.parse(best.j.startedAt || "") || Date.now())) / 60000);
    const reds = best.j.results.filter((r) => r.status === "failed").map((r) => r.id);
    const skips = best.j.results.filter((r) => r.status === "skipped").map((r) => r.id);
    ok(
      reds.length === 0,
      `${best.f}：${reds.length === 0 ? "全绿" : "有失败"}（${best.j.results.length} 条门禁，${ageMin} 分钟前）`,
      reds.length ? `失败：${reds.join(", ")}——先修再发` : undefined,
    );
    if (ageMin > 24 * 60) warn(`报告的年龄 ${Math.round(ageMin / 60)} 小时——发版前重跑一轮更稳妥`);
    if (skips.length) warn(`报告里有显式跳过：${skips.join(", ")}（跳过不等于通过）`);
    console.log(`  · ${summaryLine(best.j)}`);
  }
}

// ---- 结论 ----
console.log(`\n[结果] release-preflight ${failed === 0 ? "通过 —— 可以打 tag" : `${failed} 项不满足 —— 先别打 tag`}${warned ? `（另有 ${warned} 条提醒）` : ""}`);
if (failed === 0) {
  console.log("\n按 runbook ④ 走：");
  console.log(`  git tag -a ${TAG} -m "ShuyoNote ${TAG}"`);
  console.log(`  git push origin main && git push github main`);
  console.log(`  git push origin ${TAG} && git push github ${TAG}     # tag 必须两个远端都推`);
  console.log("推完看 Actions 的 Release (Win/mac/Linux) 全绿，再：");
  console.log(`  pnpm fetch:release-artifacts --tag ${TAG} --stage`);
  console.log("  GITCODE_TOKEN=… node scripts/release.mjs --no-build --android-apk <上一步打印的路径> --body <CHANGELOG 段>");
  console.log("  pnpm check:release-state");
}
process.exit(failed === 0 ? 0 : 1);
