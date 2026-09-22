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
//   ⇒ 这里只认**四件套文本在场**（`--features sm-library` / `sm-library-build.mjs … --prepare` /
//   `SHUYONOTE_EXPECT_SM_PATCH=applied` / `SHUYONOTE_EXPECT_PAGE_CIPHER=sm4`，外加 `OPENSSL_DIR`），
//   判据在 `scripts/check-workflow-yaml.test.mjs`（含变异证明）。
//   ⚠️ 反过来也要知道它的边界：**文本在场 ≠ 那条命令真的跑对了** —— 那件事只有真流水线能证。
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
 * 纯函数：`release.yml` 里「单一口味＝国密」的四件套必须都在场（外加一个 OPENSSL_DIR）。
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
    [/OPENSSL_DIR/, "没有 `OPENSSL_DIR`（`build.rs` 在 `sm-library` 上是 fail-fast，不给必红；但也别靠「它自己会发现」）"],
  ];
  for (const [re, why] of need) if (!re.test(effective)) problems.push(`${file}：${why}`);
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
  // ★ 第二条规则只作用在发版工作流上（别的 workflow 不发布，不该被它管）
  if (/release\.ya?ml$/i.test(path)) {
    for (const p of gmPipelineRequirements(readFileSync(f, "utf8"), { file: path })) gmBad.push(p);
  }
}

if (gmBad.length) {
  console.error("发版工作流里**单一口味＝国密**的四件套不全（配置少一行、构建照样绿、用户端才暴露）：");
  for (const p of gmBad) console.error(`  - ${p}`);
  console.error("  决定与理由见 docs/RELEASING.md「库级国密：单一口味」；这四件的分工写在 `.github/workflows/release.yml` 那两步的注释里。");
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
