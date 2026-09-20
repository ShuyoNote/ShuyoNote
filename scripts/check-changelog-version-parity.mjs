// `check-changelog-version-parity` —— **改了 CHANGELOG 顶部"已发布"那一节，就必须同时改版本文件**。
//
// 为什么要有它（2026-09-20 的真实事故，两次读数把它钉死）：
//   有一笔提交只动了 `CHANGELOG.md`（把新版本那一节写上去），**没动三个版本文件** ⇒
//   `check-versions` 在 dev 上红（六处 1.91.3 / CHANGELOG 顶 1.91.10）。
//   证据 ①：`9dfa5a5c~1` 干净检出是**绿**的 ⇒ 这条红是**新引入**的，不是"dev 长期与发布线不一致"；
//   证据 ②：`git show --stat 9dfa5a5c` 只动 CHANGELOG（170 行）、没动版本文件。
//   ⇒ 根因是"**一次发布动作只做了一半**"。`check-versions` 只能事后在**当前文件内容**上发现不一致，
//   **说不出是哪一笔弄红的**；这条门禁补的就是"哪一笔"。
//
// 判据（两条口径是 macOS 定的，见信箱 `2026-09-20-check-versions-red-on-dev.reply-3` §三）：
//   ① **只对"顶部已发布那一节变了"报警** —— 比的不是"动过 CHANGELOG"（那会把日常开发全挡住：
//      每次改动都要往 `## [Unreleased]` 加一行），而是「**首个 `## [x.y.z]` 标题**」这个**版本号**变没变；
//   ② **merge commit 要显式处理** —— `git diff-tree` 对 merge **默认什么都不列**，必须
//      `-m --first-parent`（实测：本仓 `8ae9d1b3` 这样才列出 24 个文件，不加则是 0 个）。
//      而"发布提升从 main 回合进 dev"恰恰是 merge ⇒ 不处理就会对**正确的**合并保持沉默。
//
// 用法：
//   node scripts/check-changelog-version-parity.mjs                    # 自动选范围（见下）
//   node scripts/check-changelog-version-parity.mjs --commit <sha>     # 只查一笔（变异实测用）
//   node scripts/check-changelog-version-parity.mjs --range <a>..<b>   # 查一段
//   SHUYONOTE_CHANGELOG_PARITY_RANGE=<range>                           # 同上（测试注入用）
//
// 退出码：0 = 没有违规；1 = 有违规（打印是哪几笔）；3 = **判不了**（不是 git 仓库 / git 不可用）——
// 按本仓惯例，"判不了"必须与"通过"分开（否则工具坏掉时门禁反而是绿的）。
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ★ 用共用的 `isMain`（**不是**自己写 `resolve(argv[1]) === resolve(import.meta.url)`）：
//   后者在**路径经过符号链接**时恒为假 ⇒ 脚本静默空转、退出码 0（macOS 2026-09-20 实测，
//   全仓 7 处同形写法；dev `8c589783` 抽成了这个共用实现）。门禁"绿得不是它声称的那件事"最不能接受。
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * "版本文件" = macOS 口径里的**三个**（发布提升至少要动其中之一）。
 * 其余四处（README 徽章 / docs/README / Cargo.lock / CHANGELOG 自己）由 `check-versions`
 * 负责"最终内容一致"；这里只管**动作有没有做**，所以判据窄一点，免得误伤。
 */
export const VERSION_FILES = ["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];

/** 首个**已发布**版本标题里的版本号（`## [Unreleased]` 不算；没有已发布节 ⇒ `null`）。 */
export function firstPublishedVersion(changelogText) {
  if (!changelogText) return null;
  return changelogText.match(/^##\s*\[([0-9]+(?:\.[0-9]+)+)\]/m)?.[1] ?? null;
}

/** 一笔提交相对**第一父**改了哪些文件（merge 也算得出来，见文件头口径 ②）。 */
export function filesInCommit(sha, cwd = root) {
  const out = git(["diff-tree", "-r", "--no-commit-id", "--name-only", "-m", "--first-parent", sha], cwd);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** 该笔提交是不是"改了已发布标题却没动版本文件"。 */
export function violatesParity({ files, versionBefore, versionAfter }) {
  if (!versionAfter) return false; // 没有已发布节（例如只有 Unreleased）⇒ 不管
  if (versionAfter === versionBefore) return false; // 已发布标题**没变** ⇒ 不管（日常追加 Unreleased 落到这里）
  return !files.some((f) => VERSION_FILES.includes(f));
}

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitSoft(args, cwd = root) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** 决定扫哪一段：显式参数 > 环境变量 > `origin/main..HEAD` > `HEAD^..HEAD`。 */
export function pickRange({ commit, range, cwd = root, env = process.env }) {
  if (commit) return { kind: "commit", sha: commit, base: null };
  const explicit = range || env.SHUYONOTE_CHANGELOG_PARITY_RANGE;
  if (explicit) {
    const [base, head = "HEAD"] = explicit.includes("..") ? explicit.split("..") : [explicit, "HEAD"];
    return { kind: "range", base, head };
  }
  if (gitSoft(["rev-parse", "--verify", "--quiet", "origin/main"], cwd)) {
    return { kind: "range", base: "origin/main", head: "HEAD", auto: true };
  }
  return { kind: "range", base: "HEAD^", head: "HEAD", auto: true };
}

function scanCommit(sha, cwd) {
  const files = filesInCommit(sha, cwd);
  if (!files.includes("CHANGELOG.md")) return null; // 快路径：没动 CHANGELOG 的绝大多数提交
  const after = gitSoft(["show", `${sha}:CHANGELOG.md`], cwd);
  const before = gitSoft(["show", `${sha}^:CHANGELOG.md`], cwd); // 根提交没有 `^` ⇒ null
  return {
    sha,
    files,
    versionAfter: firstPublishedVersion(after),
    versionBefore: firstPublishedVersion(before),
  };
}

export function check({ commit, range, cwd = root, env = process.env, log = console.log, err = console.error }) {
  if (!gitSoft(["rev-parse", "--is-inside-work-tree"], cwd)) {
    err("✗ 不是 git 仓库（或 git 不可用）⇒ **判不了**，不当通过");
    return 3;
  }
  const picked = pickRange({ commit, range, cwd, env });
  let shas;
  let label;
  if (picked.kind === "commit") {
    const full = gitSoft(["rev-parse", "--verify", "--quiet", `${picked.sha}^{commit}`], cwd);
    if (!full) {
      err(`✗ 认不出这一笔：${picked.sha} ⇒ **判不了**`);
      return 3;
    }
    shas = [full];
    label = `单笔 ${picked.sha}`;
  } else {
    const out = gitSoft(["rev-list", "--first-parent", `${picked.base}..${picked.head}`], cwd);
    if (out === null) {
      err(`✗ 认不出范围 ${picked.base}..${picked.head} ⇒ **判不了**（别当成通过）`);
      // ⚠️ 这一条是 macOS 2026-09-20 用 `git clone --depth 1` 实测出来的**必踩**形态：
      //    GitHub/GitCode 的 checkout 默认 `fetch-depth: 1`（浅克隆）⇒ `HEAD^` 不存在 ⇒
      //    这里直接 exit 3 ⇒ 门禁红，而红的是"判不了"，看起来像门禁坏了。
      //    所以把**原因与两条出路**写在错误里，而不是让人自己查。
      if (gitSoft(["rev-parse", "--is-shallow-repository"], cwd) === "true") {
        err(`  ⚠️ 这是一个**浅克隆**（CI 的 checkout 默认只取 1 个提交）⇒ 祖先根本不在本地。`);
        err(`     出路 ① 给该 job 的 checkout 加 fetch-depth: 0（取全历史与分支，origin/main 才在）；`);
        err(`     出路 ② 或设 \`SHUYONOTE_CHANGELOG_PARITY_RANGE=<base>..<head>\` 给显式范围（PR 用 base sha、push 用 before）。`);
      }
      return 3;
    }
    shas = out.split("\n").filter(Boolean);
    label = `${picked.base}..${picked.head}${picked.auto ? "（自动选的）" : ""}`;
  }

  // ⚠️ 空扫要**说出来**：范围为空是正常情形（例如就在基线上跑），但绝不能让"扫了 0 笔"
  //    与"扫了 100 笔都没问题"在输出上长得一样。
  const shallow = gitSoft(["rev-parse", "--is-shallow-repository"], cwd) === "true";
  log(`扫描范围：${label} ⇒ **${shas.length}** 笔提交`);
  if (shallow) {
    log(`（注意：这是**浅克隆**，扫到的历史可能比你以为的短 —— 见 ci.yml 的 fetch-depth）`);
  }

  // ★ **浅克隆 + 空范围 = 判不了，不是通过**（2026-09-20 我自己那条验证脚本抓出来的）：
  //   浅克隆里 `origin/main` **是存在的**（指向被取到的那一个提交）⇒ `origin/main..HEAD` 为空
  //   ⇒ 原来会打印"✓ 这 0 笔……"并 exit 0 —— 那正是本仓最防的**假绿**（绿得不是它声称的那件事：
  //   它什么都没看见）。CI 的 checkout 默认就是浅克隆 ⇒ 这条必须在门禁里堵死。
  if (shas.length === 0) {
    if (shallow) {
      err("✗ 扫描范围为空，而这是一个**浅克隆**（CI 的 checkout 默认只取 1 个提交）");
      err("  ⇒ **看不见历史，判不了**，不当通过（范围为空在浅克隆里不是证据）");
      err("  出路 ① 给该 job 的 checkout 加 fetch-depth: 0；");
      err("  出路 ② 或设 SHUYONOTE_CHANGELOG_PARITY_RANGE=<base>..<head> 给显式范围（PR 用 base sha、push 用 before）。");
      return 3;
    }
    log(`✓ 范围内**没有提交**（例如你就在基线上）—— 这是「没东西可查」，**不是**「查过并全部通过」`);
    return 0;
  }

  const violations = [];
  for (const sha of shas) {
    const info = scanCommit(sha, cwd);
    if (!info) continue;
    if (violatesParity(info)) violations.push(info);
  }

  if (violations.length) {
    err(`✗ ${violations.length} 笔提交"改了 CHANGELOG 的已发布标题、却没动版本文件"：`);
    for (const v of violations) {
      const subject = gitSoft(["log", "-1", "--format=%h %s", v.sha], cwd) ?? v.sha;
      err(`  - ${subject}`);
      err(`    已发布标题 ${v.versionBefore ?? "(无)"} ⇒ ${v.versionAfter}；本笔改的文件：${v.files.join(", ") || "(无)"}`);
    }
    err(`  ⇒ 发布提升要**同时**动 ${VERSION_FILES.join(" / ")} 之一（development.md §5 的整套动作）。`);
    err(`    若这确实不是一次发布（例如只改了已发布节的措辞），请把版本号那一节写回原样，或一并提升版本文件。`);
    return 1;
  }

  log(`✓ 这 ${shas.length} 笔里没有"只改已发布标题、不动版本文件"的提交`);
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  process.exit(check({ commit: valueOf("--commit"), range: valueOf("--range") }));
}
