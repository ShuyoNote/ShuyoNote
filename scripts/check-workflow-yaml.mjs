// 窄规则 YAML 门禁：挡住 workflow 里"裸标量以 `:` 结尾"这一类**非法 YAML**。
//
// 为什么要它（2026-09-12 实际踩到）：`.github/workflows/ci.yml` 的一行
// `run: cargo test ... --lib plugins::` 的值以冒号结尾——YAML 的 plain scalar **不允许**以
// `:` 结尾（行尾冒号会被当成 mapping 指示符）⇒ 整个 workflow 文件编译不过。GitHub 对这种
// 错误**不给行号、不给日志**，只产出一条 **0 个 job** 的红色 run，而且**无视 branches 过滤**：
// 49 次 push 全红，连纯文档提交也红，没人看出原因（那条分支上"红"已成了常态）。修法只是把
// 值整个加引号。
//
// ⚠️ 诚实边界：这是**窄规则**，不是通用 YAML 校验器。它**不做任何真正的 YAML 解析**，只挡
// "mapping 行的裸标量值以 `:` 结尾"这一种模式。它**看不见**：缩进错误、重复键、tab 缩进、
// 锚点/别名、flow 集合（`{a: b:}`）里的同类写法、非法转义、多文档分隔……
// **真正的解析校验仍然需要解析器**——本机与 CI 的 node_modules 里 `yaml`/`js-yaml` 都没有，
// 加依赖要联网并改 lockfile，所以这里选了零依赖的窄规则：宁可窄，也不要为了"看起来全"
// 而引入误报（一个会误报的门禁，很快就会被 `--no-verify` 绕过去，等于没有）。
// 它的价值是**零依赖、零误报**地把已经真实发生过的那一类错误挡在 push 之前。
//
// ★ 第二条规则（2026-09-22 加，owner 拍板「单一口味＝国密」之后）：**发版链的国密四件套必须在场**。
//   为什么放在这个门禁里：它同样是"配置少一行、构建照样绿、用户端才暴露"的形态 ——
//   把 `--features sm-library` 删掉，产物标记**仍会**写 `page_cipher=sm4`（页加密是补丁的编译期行为），
//   于是包看起来是国密、库级页 MAC/KDF 却是 SHA512。没有任何编译期信号会告诉你。
//   ⇒ 这里只认**五件文本在场**（`--features sm-library` / `sm-library-build.mjs … --prepare` /
//   `SHUYONOTE_EXPECT_SM_PATCH=applied` / `SHUYONOTE_EXPECT_PAGE_CIPHER=sm4` /
//   `SHUYONOTE_EXPECT_SM_CRYPTO=on`，外加 `SHUYONOTE_EXPECT_OPENSSL_DIR` 与 `OPENSSL_DIR=` 本身），
//   判据在 `scripts/check-workflow-yaml.test.mjs`（含变异证明）。
//   ⚠️ 反过来也要知道它的边界：**文本在场 ≠ 那条命令真的跑对了** —— 那件事只有真流水线能证。
//
// ★ 第三条规则（2026-09-25 加，**CI 实测教出来的**）：**跑了 `--prepare` 的那个 job，必须自己交接私有 `CARGO_HOME`**。
//   2026-09-23 的国密隔离（`scripts/lib/sm-library-isolate.mjs`）把补丁从"全机共享的 registry 源码"
//   挪进了**私有副本** `<repo>/.gm-build/libsqlite3-sys-<ver>/`；cargo 要靠**私有 `CARGO_HOME`**
//   （它 `config.toml` 里的 `[patch.crates-io]`）才走那份副本。
//   ⇒ "打补丁"与"构建"是**两个 step**，而 `$GITHUB_ENV` 是 **job 级**的：少一行
//   `sm-library-build.mjs … --print-env >> $GITHUB_ENV`，构建步编的就是**没打补丁的**那份源码，
//   而 `build.rs` 会如期 panic —— 现场看起来像"补丁没打"，其实**打了，只是没交给构建**。
//   实测：run 36092999092（`android.yml` 第 23 步 `Build APK (arm64, unsigned)`，红了整条 Android 流水线）；
//   同名同处 `release.yml` 的 android job 也有（那条只在发版时跑 ⇒ 更藏）。
//   ⇒ 判据按 **job** 切，不按整份文件切：`release.yml` 桌面 job 导了 `CARGO_HOME`，android job 没导 ——
//   按文件找"有没有那一行"会得到"有"，**那正是这一版之前会有的假绿**。
//   ⚠️ 边界与前两条一样：它证明"交接那一行在场"，不证明"它指对了路径"。
//
// ★ 第四条规则（2026-09-25 加，**同一天第二回 CI 实测教出来的**）：同一个 job 里，**交接不能早于 `--prepare`**。
//   为什么：`--print-env` **目前不是只读的**（补丁那段的 `patchApplyDecision` 没给 `--check`/`--no-apply` 时默认为真）
//   ⇒ 提前调它会把 `CARGO_HOME` 指到 `.gm-build/cargo-home`（并把它写进 `$GITHUB_ENV`）；
//   此后同 job 的 `--prepare` 解析"共享 registry 源码"时就会去私有 home 里找 ⇒ `ENOENT`。
//   实测：run 36098799341（release dry-run，`release.yml` 的 ubuntu job **step 15** 红、`Build bundles` 被 skip），
//   原文 `sm-library-build: ❌ ENOENT: … .gm-build/cargo-home/registry/src/index.crates.io-…/libsqlite3-sys-0.38.2`。
//   ⚠️ 这条与第三条是一对：第三条管"有没有交接"，这条管"交接得早不早"。
//
// 覆盖范围：`.github/workflows/*.yml|yaml` 与 `.gitcode/workflows/*.yml|yaml`，
// 用 readdirSync 枚举（不写死文件名）。
//
// 用法：node scripts/check-workflow-yaml.mjs [目录…]   （有违规即非零退出）
//       不给参数时扫仓库里的两处 workflow 目录；给目录参数时只扫给定目录（自测用）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRS = [".github/workflows", ".gitcode/workflows"];

// `key:` + 至少一个空白 + 值：值**为空**（`key:` / `key:   `）的行天然不匹配，正确跳过。
const MAPPING = /^([A-Za-z0-9_.-]+):(\s+)(.*)$/;
// 块标量指示符：`|`、`>`，可带 chomping/缩进指示（`|-`、`>+2`）。
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/**
 * 纯函数：`release.yml` 里「单一口味＝国密」的必备文本必须都在场（构建四件＋产物断言两件＋OpenSSL 前缀本身）。
 *
 * 返回 problems（空数组＝通过）。**只认文本**：这是"别被人顺手删掉"的护栏，不是"命令跑对了"的证明。
 */
export function gmPipelineRequirements(text, { file = "release.yml" } = {}) {
  const problems = [];
  // ⚠️ **只看非注释行**：我第一版直接匹配整份文本，而 release.yml 的注释里就写着
  //   “`tauri build` **必须**带 `--features sm-library`” ⇒ 把命令行里那一段删掉，
  //   判据**照样绿**（变异当场抓住，见 scripts/check-workflow-yaml.test.mjs 的那条证明）。
  //   这类"注释替命令背书"的假绿正是本仓反复防的形态。
  const effective = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  const need = [
    [/-{1,2}features\s+sm-library|features[=,]\s*sm-library/, "构建命令没带 `--features sm-library` ⇒ 应用接线那段 `#[cfg]` 会被编掉（包看起来是国密、库级页 MAC/KDF 仍是 SHA512）"],
    [/sm-library-build\.mjs[^\n]*--prepare/, "没有 `sm-library-build.mjs … --prepare` ⇒ 补丁没打 / 产物没清（不清就不会换后端）"],
    [/SHUYONOTE_EXPECT_SM_PATCH=(applied|"?applied"?)/, "没有断言 `SHUYONOTE_EXPECT_SM_PATCH=applied`"],
    [/SHUYONOTE_EXPECT_PAGE_CIPHER=sm4/, "没有断言 `SHUYONOTE_EXPECT_PAGE_CIPHER=sm4`（单一口味＝发出去的包必须是 SM4 页）"],
    [/SHUYONOTE_EXPECT_SM_CRYPTO=on/, "没有断言 `SHUYONOTE_EXPECT_SM_CRYPTO=on`（应用层国密：off ⇒ 包退回 v1 写路径）"],
    [/SHUYONOTE_EXPECT_OPENSSL_DIR=/, "没有断言 `SHUYONOTE_EXPECT_OPENSSL_DIR`（产物实际链的 OpenSSL 目录；只给 OPENSSL_DIR 挡不住 OPENSSL_LIB_DIR 覆盖）"],
    // ⚠️ 这里**必须**用 lookbehind 排除 `SHUYONOTE_EXPECT_OPENSSL_DIR=`：否则上一条断言会替这一条背书
    //   （2026-09-22 变异当场抓到：把 `echo "OPENSSL_DIR=/usr" >> $GITHUB_ENV` 删掉，判据照样绿）。
    [/(?<![A-Z_])OPENSSL_DIR=/, "没有 `OPENSSL_DIR=`（`build.rs` 在 `sm-library` 上是 fail-fast，不给必红；但也别靠「它自己会发现」）"],
  ];
  for (const [re, why] of need) if (!re.test(effective)) problems.push(`${file}：${why}`);
  return problems;
}

/**
 * 纯函数：把 workflow 文本按**顶层 job** 切开（`jobs:` 下缩进 2 的 `名字:`）。
 *
 * 为什么必须按 job 切：`$GITHUB_ENV` 是 **job 级**的 —— 桌面 job 里导出的 `CARGO_HOME`
 * 不会流到 android job 里。所以"整份文件里有没有那一行"是**错的粒度**：
 * `release.yml` 恰好就是"桌面 job 有、android job 没有"，按文件找会判它"有"。
 * 缩进假设与 `check-release-parity.mjs` 同一套（顶层键 0、job 名 2、job 内的键 4、step 6）。
 * 没有 `jobs:` ⇒ 返回 `[]`（调用方据此不判红：这份文件不参与）。
 */
export function splitJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^  ([A-Za-z_][\w-]*):\s*$/.exec(lines[i]);
    if (m) {
      if (cur) jobs.push(cur);
      cur = { job: m[1], text: "" };
      continue;
    }
    if (cur) cur.text += `${lines[i]}\n`;
  }
  if (cur) jobs.push(cur);
  return jobs;
}

/** 私有 `CARGO_HOME` 的两种合法交接写法（判据只认这两类，且只看非注释行）。 */
const CARGO_HOME_HANDOFF = [
  /sm-library-build\.mjs[^\n]*--print-env[^\n]*>>[^\n]*GITHUB_ENV/,
  // ⚠️ 中间**不能**用 `\S*`：`${{ github.workspace }}/.gm-build/cargo-home` 里是有空格的
  //   （第一版这么写 ⇒ 那种合法写法被判红，被 `.test.mjs` 那条"别误报"当场抓住）。
  /CARGO_HOME\s*:\s*.*\.gm-build/,
];

/**
 * 纯函数：**每个跑了 `--prepare` 的 job**，自己那一块里必须有私有 `CARGO_HOME` 的交接。
 *
 * 为什么是这条规则而不是"文件里有就行"：见文件头第三条 —— 打补丁与构建是两个 step，
 * 而 `$GITHUB_ENV` 只在**同一个 job** 内可见。判据只认两种写法：
 *   ① `sm-library-build.mjs … --print-env >> "$GITHUB_ENV"`（唯一实现就在那个脚本里，别在 YAML 里手抄路径）
 *   ② 显式 `CARGO_HOME: …/.gm-build/…`（允许，但要在 YAML 里重复一个路径，不推荐）
 *
 * 只看**非注释行**：否则文件里那句"⚠️ 必须把 CARGO_HOME 交出去"的注释会替命令背书
 * （本仓在第一条规则上已经栽过一次，变异证明见 `.test.mjs`）。
 */
export function gmCargoHomeHandoffProblems(text, { file = "workflow" } = {}) {
  const problems = [];
  for (const { job, text: body } of splitJobs(text)) {
    const effective = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    if (!/sm-library-build\.mjs[^\n]*--prepare/.test(effective)) continue;
    if (CARGO_HOME_HANDOFF.some((re) => re.test(effective))) continue;
    problems.push(
      `${file}：job \`${job}\` 跑了 \`sm-library-build.mjs … --prepare\`，但**同一个 job 里没有**把私有 \`CARGO_HOME\` 交出去` +
        "（隔离后补丁在 `.gm-build/libsqlite3-sys-<ver>/`，cargo 靠私有 `CARGO_HOME` 的 `[patch.crates-io]` 才走那份副本；" +
        "`$GITHUB_ENV` 是 **job 级**的，别的 job 导了不算）" +
        "；修法：在**这个 job 里**补一行 `node scripts/sm-library-build.mjs --openssl-dir \"$OPENSSL_DIR\" --print-env >> \"$GITHUB_ENV\"`（单独一步、或并进补丁那一步都行）" +
        "（少这一行 ⇒ `build.rs` 在 `sm-library` 上如期 panic：run 36092999092 第 23 步；现场像「补丁没打」，其实打了没交接）",
    );
  }
  return problems;
}

/**
 * 纯函数：**交接不能早于 `--prepare`**（同一个 job 内，按行序看）。
 *
 * 为什么（2026-09-25 的 release dry-run 实测，run 36098799341 的 ubuntu job step 15）：
 * `--print-env` **目前不是只读的** —— 补丁那一段的 `patchApplyDecision` 在没有 `--check`/`--no-apply`
 * 时**默认为真**，所以 `--print-env` 自己就会建隔离（`.gm-build/cargo-home` 出现）并因此把
 * **私有** `CARGO_HOME` 写进 `$GITHUB_ENV`。此后同一个 job 里的 `--prepare` 就会拿私有 home 去解析
 * "共享 registry 源码" ⇒ 一条不存在的路径 ⇒ `ENOENT`（现场像"源码没了"，其实是**交接早了**）：
 *
 *     Linux system deps:  node … --print-env >> "$GITHUB_ENV"   ← 提前交接（隔离被它建出来）
 *     ★ 库级国密:          node … --prepare                     ← 此时 CARGO_HOME 已是私有 home ⇒ 红
 *
 * 判据只看 `--print-env >> …` 这种写法：`CARGO_HOME: …/.gm-build/…` 那种是 job 级 env，无先后可言。
 * 与第三条一样，**只看非注释行**、**按 job 切**。
 */
export function gmHandoffOrderProblems(text, { file = "workflow" } = {}) {
  const problems = [];
  for (const { job, text: body } of splitJobs(text)) {
    const lines = body.split("\n");
    const firstMatch = (re) => lines.findIndex((l) => !l.trim().startsWith("#") && re.test(l));
    const prep = firstMatch(/sm-library-build\.mjs[^\n]*--prepare/);
    const handoff = firstMatch(/sm-library-build\.mjs[^\n]*--print-env[^\n]*>>/);
    if (prep < 0 || handoff < 0) continue;
    if (handoff < prep) {
      problems.push(
        `${file}：job \`${job}\` 里 \`sm-library-build.mjs … --print-env >> "$GITHUB_ENV"\` 出现在 \`--prepare\` **之前**` +
          "（`--print-env` **不是只读的**：它会自己建隔离 ⇒ 于是把**私有** `CARGO_HOME` 提前交出去，" +
          "后面的 `--prepare` 就会拿私有 home 去解析共享 registry 源码 ⇒ `ENOENT`；" +
          "2026-09-25 dry run：`release.yml` 的 Linux 桌面 job step 15 就是这么红的，`Build bundles` 被 skip）" +
          "；修法：把交接挪到 `--prepare` **之后**（`release.yml` 的规范位置是国密那一步的末尾，与 android job 同名同形）",
      );
    }
  }
  return problems;
}

function indentWidth(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 8;
    else break;
  }
  return n;
}

// 去掉裸标量尾部的行内注释：按 YAML 的规矩，`#` 只有在行首或**前面是空白**、且不在引号内
// 时才开始注释。不这么做就会把 `run: echo x #备注:` 这类**合法**行误判成违规。
function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && i > 0 && /\s/.test(value[i - 1])) return value.slice(0, i);
  }
  return value;
}

/** 纯函数：窄规则本体（吃文本，不吃路径 ⇒ 判据不用建临时文件）。 */
export function checkText(text) {
  const lines = text.split("\n");
  const hits = [];
  // 块标量（`run: |`）的内部行不是 YAML 结构，必须整段跳过，否则里面的
  // `某个: 东西:` 会被误报。进入块标量后，缩进更深的行都算内容，退到同级/更浅才出来。
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    const indent = indentWidth(raw);
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    let body = trimmed;
    if (body.startsWith("- ")) body = body.slice(2).trim(); // 覆盖 `- run: …:` 这类列表项
    else if (body === "-") continue;
    const m = MAPPING.exec(body);
    if (!m) continue;
    const value = stripComment(m[3]).trimEnd(); // 行尾空白不属于 plain scalar，先去掉
    if (value === "") continue; // 值为空：`key:` / `key:   `
    if (BLOCK_SCALAR.test(value)) {
      blockIndent = indent; // `|` / `>` 块标量：往后缩进更深的行都是内容
      continue;
    }
    if (value.startsWith('"') || value.startsWith("'")) continue; // 已加引号的值是合法写法
    if (value.endsWith(":")) hits.push({ line: i + 1, text: raw });
  }
  return hits;
}

function checkFile(file) {
  return checkText(readFileSync(file, "utf8"));
}

const argDirs = process.argv.slice(2);
const dirs = argDirs.length ? argDirs.map((d) => resolve(d)) : DEFAULT_DIRS.map((d) => join(root, d));

const files = [];
for (const dir of dirs) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    continue; // 目录不存在（例如只有 GitHub、没有 GitCode）就跳过
  }
  for (const name of names.sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    files.push(p);
  }
}

if (files.length === 0) {
  console.error(`没扫到任何 workflow 文件：${dirs.join("、")}——目录结构变了？`);
  process.exit(1);
}

const bad = [];
const gmBad = [];
for (const f of files) {
  const path = f.startsWith(root) ? relative(root, f) : f;
  for (const hit of checkFile(f)) bad.push({ path, ...hit });
  const text = readFileSync(f, "utf8");
  // ★ 第二条规则只作用在发版工作流上（别的 workflow 不发布，不该被它管）
  if (/release\.ya?ml$/i.test(path)) {
    for (const p of gmPipelineRequirements(text, { file: path })) gmBad.push(p);
  }
  // ★ 第三条规则对**所有** workflow 生效：哪个 job 跑了 `--prepare`，那个 job 就得自己交接私有 `CARGO_HOME`
  for (const p of gmCargoHomeHandoffProblems(text, { file: path })) gmBad.push(p);
  // ★ 第四条规则（2026-09-25，同一天第二回 CI 实测教出来的）：交接**不能早于** `--prepare`
  for (const p of gmHandoffOrderProblems(text, { file: path })) gmBad.push(p);
}

if (gmBad.length) {
  console.error("国密链的必备项不全（配置少一行、构建照样绿/红在别处、用户端才暴露）：");
  for (const p of gmBad) console.error(`  - ${p}`);
  console.error(
    "  决定与理由见 docs/RELEASING.md「库级国密：单一口味」；这几件的分工写在 `.github/workflows/release.yml` 那两步的注释里，" +
      "私有 `CARGO_HOME` 那条见 scripts/lib/sm-library-isolate.mjs 头注。",
  );
  process.exit(1);
}

if (bad.length) {
  console.error("workflow 里有**裸标量以 `:` 结尾**——这是非法 YAML，整个 workflow 文件编译不过：");
  for (const b of bad) console.error(`  - ${b.path}:${b.line}\n      ${b.text.trim()}`);
  console.error("  症状：GitHub 不给行号、不给日志，只产出一条 **0 个 job** 的红色 run，且无视 branches 过滤。");
  console.error("  修法：把整个值加引号（如 `run: \"…plugins::\"`），或去掉行尾那个冒号。");
  process.exit(1);
}

console.log(`workflow YAML 窄规则通过：${files.length} 个文件，没有裸标量以冒号结尾`);
