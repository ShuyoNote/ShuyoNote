// `check-main-only-commits` —— **发布线上不许存在"开发线永远拿不到"的内容改动**。
//
// ## 判据
// 取 `origin/main` 里、`origin/dev` 里没有的每一笔提交，逐笔判：
//   · **是 merge** ⇒ 合法，当且仅当**除第一父外**的每个父提交都能从 `dev` 走到
//     （这就是"把开发线合进发布线"这个动作本身；第一父是发布线自己的上一笔，本来就不该在 dev 里）；
//   · **不是 merge** ⇒ 合法，当且仅当它（相对第一父）**只动了发布产物**（`RELEASE_ARTIFACTS`）。
// 两者都不满足 ⇒ 红。
//
// ## 为什么需要它（2026-09-25 量出来的真事故）
// `dev` 与 `origin/main` 分叉：dev 独有 208 笔、main 独有 7 笔。那 7 笔里三笔带着开发线没有的内容：
//
//   · `a3cbd44a fix(community)` —— 社区帖存成笔记后属性区不及时刷新。
//     读数：dev 上 `src/components/PropertiesPanel.test.tsx` **根本不存在**，`propertyUi.ts` 停在 2026-09-03。
//   · `64a415a1 docs(plans)` —— 团队版 M27.1 客户端方案。
//   · ★ **`686d0480 release: 1.91.25`** —— 标题像"纯发布"，**实际夹带了 `src/lib/mdPreview.ts` 的修复**：
//     节点表原在**模块顶层**求值，而它处在循环 import 里
//       lib/mdPreview → editor/nodes/ColumnsBlockNode → store/notes → store/filePreview → lib/mdPreview
//     dev/vitest（原生 ESM）下 import 顺序**必然**先初始化好那个类 ⇒ **单测永远绿**；
//     打包产物拼平后数组字面量先跑 ⇒ `nodes[9]`（`ColumnsBlockNode`）是 `undefined`。
//
//   ⇒ **不能只看提交标题判**：那三笔里恰好有一笔标题就叫 `release:`。
//   ⇒ 真正的危害不是"台账落后"，是开发线**长期带着一个已发布的 bug**，而且下次 `dev → main`
//     合并冲突取 dev 侧时会把它**静默改回去**。
//
// ## merge 豁免不是开后门（有实测支撑）
// 本仓那三笔合并（`147e284f` / `853a75a6` / `dab509c6`）的**第二父都从 dev 走得到**
// （实测：第二父分别是 `973ec0de` / `43decd56` / `822c70e7`，`merge-base --is-ancestor <父> dev` 全真）。
// 所以这条豁免只放过"把开发线合上去"这一个动作；若谁把**别的分支**合进 main，第二父就不在 dev 里 ⇒ 照样红。
//
// ## 为什么**拒绝在浅克隆上判**（exit 3，而不是猜一个结论）
// 判据要算 `origin/main` 与 `origin/dev` 的祖先关系。浅克隆下这个图是**残缺**的，
// `git rev-list A..B` 会**静默**给出偏少的答案 —— 那正是本仓最防的"绿得不是它声称的那件事"。
// ⇒ 浅克隆一律判"判不了"。GitHub 的 `checks` job 用 `fetch-depth: 0`；
//    GitCode 侧由 `.gitcode/workflows/ci.yml` 的「取全历史与 tag」那一步 `--unshallow` 保证。
//
// 用法：
//   node scripts/check-main-only-commits.mjs
//   node scripts/check-main-only-commits.mjs --main origin/main --dev origin/dev   # 自测/变异用
//   node scripts/check-main-only-commits.mjs --repo <目录> --quiet
//
// 退出码：0 = 通过；1 = 有违规；3 = **判不了**（不是 git 仓库 / git 不可用 / 缺 ref / 浅克隆）。
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * "发布产物" = 一次合法发布**允许**动的全部文件。
 *
 * 前 7 条就是 `scripts/check-versions.mjs` 认的那 7 处（版本号六处/七处一致）；
 * 第 8 条 `docs/SHUYONOTE_STATE.md` 是发布时同步的状态文档 —— `check-versions` **不读它**，
 * 但真实 release 提交（`5e7ffb0f` 实测）会动它，所以也放进来。
 *
 * ⚠️ **这张表不许漂**：`check-main-only-commits.test.mjs` 会把 `check-versions.mjs` 源码里所有
 * `read("…")` 的路径扫出来，凡它认的必须都在这张表里 —— 谁给 `check-versions` 加了第 8 处，
 * 自测会红并要求你同步这里（不靠人记得）。
 */
export const RELEASE_ARTIFACTS = [
  "package.json", // check-versions ① 版本事实源
  "src-tauri/Cargo.toml", // ②
  "src-tauri/tauri.conf.json", // ③
  "README.md", // ④ 徽章
  "docs/README.md", // ⑤ 当前版本
  "CHANGELOG.md", // ⑥ 顶部段头
  "src-tauri/Cargo.lock", // ⑦
  "docs/SHUYONOTE_STATE.md", // 发布时同步的状态文档（check-versions 不读它）
];

/** 这笔提交（相对第一父）动过、但**不属于**发布产物的文件。空数组 = 它只动了发布产物。 */
export function foreignFiles(files) {
  return files.filter((f) => !RELEASE_ARTIFACTS.includes(f));
}

/** 只动发布产物 ⇒ 视为"一次合法的发布动作"。 */
export function isReleaseOnly(files) {
  return files.length > 0 && foreignFiles(files).length === 0;
}

function makeGit(cwd) {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * @param {object} o
 * @param {string} [o.cwd]
 * @param {string} [o.main] 发布线（默认 `origin/main`）
 * @param {string} [o.dev]  开发线（默认 `origin/dev`）
 * @param {boolean} [o.quiet]
 * @param {(m: string) => void} [o.log]
 * @param {(m: string) => void} [o.err]
 * @returns {0 | 1 | 3}
 */
export function check({ cwd = root, main = "origin/main", dev = "origin/dev", quiet = false, log = console.log, err = console.error } = {}) {
  const git = makeGit(cwd);
  const gitSoft = (args) => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  if (!gitSoft(["rev-parse", "--is-inside-work-tree"])) {
    err("✗ 不是 git 仓库（或 git 不可用）⇒ **判不了**，不当通过");
    return 3;
  }

  // ★ 浅克隆一律判不了：祖先关系在残缺的图上是**静默**错的（见文件头）。
  if (gitSoft(["rev-parse", "--is-shallow-repository"]) === "true") {
    err("✗ 这是一个**浅克隆**，算不出两条线的祖先关系 ⇒ **判不了**，不当通过");
    err("  （浅克隆下 `git rev-list A..B` 会给一个**偏少**的答案 —— 那是绿得不是它声称的那件事）");
    err("  出路 ① GitHub：给该 job 的 checkout 设 `fetch-depth: 0`（`ci.yml` 的 `checks` job 已这么配）；");
    err("  出路 ② GitCode：`.gitcode/workflows/ci.yml` 的「取全历史与 tag」那一步已 `--unshallow`；");
    err("  出路 ③ 本地：`git fetch --unshallow origin` 后再跑。");
    return 3;
  }

  for (const ref of [main, dev]) {
    if (!gitSoft(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
      err(`✗ 认不出 \`${ref}\` ⇒ **判不了**，不当通过`);
      err(`  （这条判据要比对发布线与开发线。缺 ref 时"没查到违规"不是证据。）`);
      err(`  出路：\`git fetch origin '+refs/heads/*:refs/remotes/origin/*'\`，或用 \`--main/--dev\` 指定别的 ref。`);
      return 3;
    }
  }

  const shas = (gitSoft(["rev-list", `${dev}..${main}`]) ?? "").split("\n").filter(Boolean);

  const violations = [];
  let merges = 0;
  let releases = 0;

  for (const sha of shas) {
    const parents = git(["rev-list", "--parents", "-n1", sha]).split(" ").slice(1);
    const subject = git(["log", "-1", "--format=%h %s", sha]);

    if (parents.length > 1) {
      merges++;
      const strangers = parents.slice(1).filter((p) => gitSoft(["merge-base", "--is-ancestor", p, dev]) === null);
      if (strangers.length) {
        violations.push({
          kind: "merge",
          subject,
          why: `合并进来了开发线上没有的分支（第 ${parents.indexOf(strangers[0]) + 1} 父 ${strangers.map((p) => p.slice(0, 8)).join(" / ")} 从 \`${dev}\` 走不到）`,
        });
      }
      continue;
    }

    const files = (gitSoft(["diff-tree", "-r", "--no-commit-id", "--name-only", "-m", "--first-parent", sha]) ?? "")
      .split("\n").map((s) => s.trim()).filter(Boolean);
    if (isReleaseOnly(files)) {
      releases++;
      continue;
    }
    const foreign = foreignFiles(files);
    violations.push({
      kind: "content",
      subject,
      why: foreign.length
        ? `动了**不属于发布产物**的文件：${foreign.slice(0, 6).join(", ")}${foreign.length > 6 ? ` …（共 ${foreign.length} 个）` : ""}`
        : "这笔提交没有动任何文件（空提交没法判成发布动作）",
    });
  }

  if (!quiet) {
    log(`比对：\`${dev}..${main}\` ⇒ 发布线独有 **${shas.length}** 笔`);
    log(`  其中 合并 ${merges} 笔、纯发布动作 ${releases} 笔、违规 **${violations.length}** 笔`);
  }

  if (violations.length) {
    err(`✗ ${violations.length} 笔提交只活在发布线上（开发线永远拿不到它的内容）：`);
    for (const v of violations) {
      err(`  - ${v.subject}`);
      err(`    ${v.why}`);
    }
    err("");
    err(`  ⇒ 发布线（\`${main}\`）只该承接两种提交：**把开发线合上去的合并**、**只动发布产物的发布动作**。`);
    err(`     别的改动请落在开发线（\`${dev}\`）上，再随下一次发布合并上去 —— 否则开发线会长期`);
    err(`     带着一个"已经发出去、但开发线没有"的 bug，且下次合并冲突取开发线侧时会把它**静默改回去**。`);
    err(`  ⚠️ **别只看提交标题判**：2026-09-25 那笔 \`release: 1.91.25\` 标题像纯发布，实际夹带了`);
    err(`     \`src/lib/mdPreview.ts\` 的修复（一个只在打包产物里显形的 bug）。`);
    err(`  ⇒ 若是**有意**在发布线上做的一次紧急修复：请把它同时落到开发线上（cherry-pick 或回合），`);
    err(`     落完这条门禁自然会绿。`);
    return 1;
  }

  log(`✓ 发布线上这 ${shas.length} 笔都在规则内（合并 ${merges} 笔 ＋ 只动发布产物的 ${releases} 笔）`);
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
      main: valueOf("--main") ?? "origin/main",
      dev: valueOf("--dev") ?? "origin/dev",
      quiet: argv.includes("--quiet"),
    }),
  );
}
