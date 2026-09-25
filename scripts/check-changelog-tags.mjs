// `check-changelog-tags` —— **发布出去的那棵树，必须自带它自己那一版的台账段**。
//
// ## 它挡什么事故
// `git tag` 指哪棵树，用户下载到的就是哪棵树。所以「CHANGELOG 里写了 1.64.12」与
// 「`v1.64.12` 这个 tag 的**树**里有 1.64.12 那一段」是**两件事**，后者才是"发出去的东西自带说明书"。
// 本仓真发生过前者成立、后者不成立：
//
//   2026-08-31 一天里连发 7 个 tag（`v1.64.10` … `v1.64.16`），**每一个的树顶格都还停在
//   `1.64.10`（`v1.64.10` 自己停在 `1.64.9`）** —— 版本号 bump 了、台账一段没写。
//   读数（`git show <tag>:CHANGELOG.md` 里首个 `## [x.y.z]`）：
//     v1.64.10 → 1.64.9      v1.64.11 → 1.64.10   v1.64.12 → 1.64.10
//     v1.64.13 → 1.64.10     v1.64.14 → 1.64.10   v1.64.15 → 1.64.10   v1.64.16 → 1.64.10
//   （`v1.64.13` 的提交标题甚至还是"bump 到 1.64.12（含 U1/U2/U3）"—— 那天是**成批**赶出来的。）
//   这 7 条**只登记、不补写**：今天补写 1.64.11 的台账就是**编造历史**，比缺着更坏。
//
// ## 与 `release-preflight` ③ 不是一回事（别以为有了它就不用这条）
// preflight 查的是**打 tag 之前的工作区**有没有 `## [目标版本]`，只在"发布那一刻、只对待发的这一版"说话。
// 它**挡不住**上面那个形状：工作区是对的，但 tag 打在了台账陈旧的提交上（`git tag` 指哪个提交是手给的）。
// 本门禁是**全量历史审计**：任何时候对**所有** tag 问"你这棵树里有没有你自己那一段"。
//
// ## 基线选错的教训（2026-09-25，我自己踩的，写在这里免得后人再踩）
// 第一版拿 **`dev` 当前工作区的 CHANGELOG** 去比 tag，报出 4 个"缺失"：
// `1.85.2` / `1.91.4` / `1.91.25` / `1.91.26`。**四个全是假的** —— 本仓的发布提交切在 `main` 上，
// `dev` 的台账本来就落后发布线两个版本（实测当天：`origin/main` 顶到 1.91.26，`dev` 顶到 1.91.24）。
// 换成「**tag 自己的树**」这个基线后那 4 个全绿，真缺的只剩上面那 7 个。
// ⇒ 判据的基线必须是**被审计的那个对象自己**（tag 的树），而不是"你手边那份 checkout"。
//
// ## 为什么**不**进 `pnpm build`
// `build` 会在 `release.yml` / `macos.yml` / `android.yml` 里跑，而那些 job 的 checkout 是**默认深度**
// （浅克隆）⇒ 本地**一个 tag 都没有** ⇒ 本门禁按下面的规矩判"判不了"（exit 3）⇒ 把**发版链整条弄红**。
// 它只挂 `contract` 组：跑它的 `ci.yml` 的 `checks` job 已显式 `fetch-depth: 0`（理由见那里的注释）。
//
// 用法：
//   node scripts/check-changelog-tags.mjs                    # 查脚本自己所在的那个 checkout
//   node scripts/check-changelog-tags.mjs --repo <目录>       # 查**另一份检出**
//   node scripts/check-changelog-tags.mjs --quiet            # 只打结论与违规
//
// 退出码：0 = 通过；1 = 有违规（**或豁免名单已经过期**）；3 = **判不了**（不是 git 仓库 / git 不可用 /
// 一个版本 tag 都看不见）。按本仓惯例，"判不了"必须与"通过"分开 —— 否则工具坏掉时门禁反而是绿的。
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ★ 用共用的 `isMain`（**不是**自己写 `resolve(argv[1]) === resolve(import.meta.url)`）：
//   后者在**路径经过符号链接**时恒为假 ⇒ 脚本静默空转、退出码 0（本仓 2026-09-20 实测过 7 处同形写法）。
import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 版本 tag 的形状。`v1.0.0` 是；`latest`（跟着最新发布走的**浮标**）不是。 */
export const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/**
 * 历史上**确实没写**、且**不会补写**的 tag —— 只登记，让门禁对它们保持沉默。
 *
 * 每条都必须写清"当时是什么读数"，否则后人只会看到一串来路不明的白名单。
 * ⚠️ 这张表**不许长大**：新增一条等于承认"又发生了一次"。它也不会悄悄腐烂 ——
 * 名单里的条目一旦已经自带段头、或 tag 不见了，本门禁会**判红**要求删掉它。
 */
export const KNOWN_GAPS = new Map([
  ["1.0.0", "2026-08-16：该 tag 的树里**根本没有 `CHANGELOG.md`**（早于本仓引入这份台账）"],
  ["1.64.10", "2026-08-31 成批发布，树顶格停在 `1.64.9`"],
  ["1.64.11", "2026-08-31 成批发布，树顶格停在 `1.64.10`"],
  ["1.64.12", "2026-08-31 成批发布，树顶格停在 `1.64.10`"],
  ["1.64.13", "2026-08-31 成批发布，树顶格停在 `1.64.10`（提交标题也停在 1.64.12）"],
  ["1.64.14", "2026-08-31 成批发布，树顶格停在 `1.64.10`"],
  ["1.64.15", "2026-08-31 成批发布，树顶格停在 `1.64.10`"],
  ["1.64.16", "2026-08-31 成批发布，树顶格停在 `1.64.10`"],
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 这段台账里有没有 `## [<version>]` 这个**段头**（必须是行首标题，不是正文里提到版本号）。 */
export function hasEntry(changelogText, version) {
  if (!changelogText) return false;
  return new RegExp(`^##\\s*\\[${escapeRe(version)}\\]`, "m").test(changelogText);
}

/** 台账里**首个**已发布版本段头的版本号（`## [Unreleased]` 不算）；没有已发布节 ⇒ `null`。 */
export function topVersion(changelogText) {
  if (!changelogText) return null;
  return changelogText.match(/^##\s*\[(\d+(?:\.\d+)+)\]/m)?.[1] ?? null;
}

function makeGit(cwd) {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function makeGitSoft(cwd) {
  const git = makeGit(cwd);
  return (args) => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };
}

/**
 * @param {object} o
 * @param {string} [o.cwd]   查哪个 checkout（默认脚本自己所在的）
 * @param {boolean} [o.quiet] 只打结论与违规
 * @param {Map<string, string>} [o.knownGaps] 覆盖豁免名单（**只为自测**：合成仓库里用得上）
 * @param {(m: string) => void} [o.log]
 * @param {(m: string) => void} [o.err]
 * @returns {0 | 1 | 3}
 */
export function check({ cwd = root, quiet = false, knownGaps = KNOWN_GAPS, log = console.log, err = console.error } = {}) {
  const git = makeGitSoft(cwd);

  if (!git(["rev-parse", "--is-inside-work-tree"])) {
    err("✗ 不是 git 仓库（或 git 不可用）⇒ **判不了**，不当通过");
    return 3;
  }

  const allTags = (git(["tag", "--list"]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const releaseTags = [];
  const skipped = [];
  for (const t of allTags) {
    const m = RELEASE_TAG.exec(t);
    if (m) releaseTags.push({ tag: t, version: m[1] });
    else skipped.push(t);
  }

  // ★ **一个版本 tag 都看不见 = 判不了，不是通过**。这是本仓最防的假绿形态：
  //   CI 的 checkout 默认 `fetch-depth: 1` ⇒ 不取 tag ⇒ 这里若"扫了 0 个、皆无违规 ⇒ exit 0"，
  //   门禁就绿得不是它声称的那件事（它什么都没看见）。
  if (releaseTags.length === 0) {
    err("✗ 这个检出里**一个 `v<semver>` tag 都没有** ⇒ **判不了**，不当通过");
    if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
      err("  ⚠️ 这是一个**浅克隆**（CI 的 checkout 默认只取 1 个提交，且不取 tag）");
      err("     出路 ① 给该 job 的 checkout 加 `fetch-depth: 0`（`ci.yml` 的 `checks` job 已这么配了）；");
      err("     出路 ② 或在该 job 里先 `git fetch --tags`。");
    } else {
      err("  （不是浅克隆：这份检出是真的没有版本 tag。要么仓库刚起，要么 `--single-branch` 之类没取 tag。）");
    }
    return 3;
  }

  if (!quiet) {
    log(`审计对象：每个 tag **自己的树**里那棵 \`CHANGELOG.md\``);
    log(`tag 总数 ${allTags.length} ⇒ 版本 tag **${releaseTags.length}** 个` +
      (skipped.length ? `，跳过非版本 tag：${skipped.map((t) => `\`${t}\``).join(" / ")}` : ""));
    log("");
  }

  const violations = [];
  const allowlisted = [];
  let okCount = 0;

  for (const { tag, version } of releaseTags) {
    const text = git(["show", `${tag}:CHANGELOG.md`]);
    const known = knownGaps.has(version);
    if (text !== null && hasEntry(text, version)) {
      okCount++;
      // 豁免名单**不许过期**：已经自带段头了 ⇒ 那一条豁免必须删掉，否则它是个没人看的洞。
      if (known) violations.push({ tag, version, kind: "stale-allowlist", why: "已经自带段头" });
      continue;
    }
    const why = text === null
      ? "该 tag 的树里没有 `CHANGELOG.md`"
      : `树顶格是 \`${topVersion(text) ?? "(无已发布节)"}\`，没有 \`## [${version}]\``;
    if (known) allowlisted.push({ tag, version, why });
    else violations.push({ tag, version, kind: "missing", why });
  }

  // 豁免名单里指向的 tag 必须**在这个检出里存在**（配了 `fetch-depth: 0` 就该在）。
  // 不在 ⇒ 要么历史被改写、要么这个检出没取全 tag，两种都该吵出来。
  const present = new Set(releaseTags.map((t) => t.tag));
  for (const [version, reason] of knownGaps) {
    if (!present.has(`v${version}`)) {
      violations.push({
        tag: `v${version}`,
        version,
        kind: "stale-allowlist",
        why: `豁免名单里有它，但这个检出里没有这个 tag（历史被改写？或没取全 tag？）。原记录：${reason}`,
      });
    }
  }

  if (!quiet) {
    if (allowlisted.length) {
      log(`历史豁免 **${allowlisted.length}** 条（只登记、不补写 —— 补写就是编造台账）：`);
      for (const a of allowlisted) {
        log(`  - ${a.tag.padEnd(10)} ${a.why}`);
        log(`    ${knownGaps.get(a.version)}`);
      }
      log("");
    }
  }

  if (violations.length) {
    const missing = violations.filter((v) => v.kind === "missing");
    const stale = violations.filter((v) => v.kind === "stale-allowlist");
    err(`✗ ${violations.length} 条不合格：`);
    for (const v of missing) {
      err(`  - ${v.tag}：${v.why}`);
    }
    if (missing.length) {
      err(`  ⇒ tag 指的是**已经发出去的那棵树**。要让它自带台账，只有两条路：`);
      err(`     ① 这次别发/重发：先补 \`## [版本]\` 再 bump 版本文件并**重新打 tag**（已推出去的 tag 别复用，见 RELEASING.md ⑤）；`);
      err(`     ② 若这确实是历史遗留（今天才发现、且当时的改动已无从追溯）⇒ 把它**登记**进`);
      err(`        \`scripts/check-changelog-tags.mjs\` 的 \`KNOWN_GAPS\` 并写清当时的读数，**不要补写台账**。`);
    }
    for (const v of stale) {
      err(`  - 豁免名单过期：\`v${v.version}\` —— ${v.why}`);
    }
    if (stale.length) {
      err(`  ⇒ 删掉 \`KNOWN_GAPS\` 里已经不成立的那几条：**过期豁免是个没人看的洞**。`);
    }
    return 1;
  }

  log(`✓ ${releaseTags.length} 个版本 tag 里，**${okCount}** 个自带本版台账段头，` +
    `${allowlisted.length} 条是登记过的历史豁免（见脚本内 \`KNOWN_GAPS\`）`);
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = valueOf("--repo");
  process.exit(
    check({
      cwd: repo ? resolve(repo) : root,
      quiet: argv.includes("--quiet"),
    }),
  );
}
