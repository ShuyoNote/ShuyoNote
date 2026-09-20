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
      return 3;
    }
    shas = out.split("\n").filter(Boolean);
    label = `${picked.base}..${picked.head}${picked.auto ? "（自动选的）" : ""}`;
  }

  // ⚠️ 空扫要**说出来**：范围为空是正常情形（例如就在 main 上跑），但绝不能让"扫了 0 笔"
  //    与"扫了 100 笔都没问题"在输出上长得一样。
  log(`扫描范围：${label} ⇒ **${shas.length}** 笔提交`);

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

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  process.exit(check({ commit: valueOf("--commit"), range: valueOf("--range") }));
}
