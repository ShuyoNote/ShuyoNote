// `.gitcode/workflows/*.yml` 的**平台规则门禁**（离线，不依赖 token / 网络）。
//
// 规则不是我猜的，是 2026-09-16 用 GitCode 自己的校验接口实测出来的：
//   POST https://api.gitcode.com/api/v8/repos/:owner/:repo/actions/workflows/validate
//   body: {"base64_content": "<yaml 的 base64>"}   →  {valid, diagnostics[]}
// 三条硬约束（GitHub 侧没有这些限制，所以照抄 GitHub 的写法会踩）：
//   1) `runs-on` 以单个字符串给出时，只接受
//      [default, ubuntu-latest, euler-latest, ubuntu-24, ubuntu-22]
//      —— 仓库原有用的是 `euleros-2.10.1`，校验器直接报错。
//   2) 每个 step 都必须有非空的 `name:`（裸 `- uses: ...` 会被拒），且名称只允许
//      中文 / 英文字母数字 / - _ , ; : . / ( ) （） / 空格，长度 1–128。
//   3) action 引用必须是 `actions/xxx@vN` 形式；GitCode 简写
//      （`checkout-action@0.0.1` / `setup-node@0.0.1` / `upload-artifact@0.0.1`）校验器报"不存在"。
//
// 为什么还要这条离线门禁：远端校验器需要 token + 网络，不能进 CI；而"文件在合并后才被发现不合法"
// 的代价是整条流水线根本不会被调度（0 个 job 的红 run，仓库里记过这类事故）。本地这条窄规则
// 把同一组约束前移到 `pnpm verify`。
//
// ⚠️ 诚实边界：这是**窄规则**，不是 YAML 解析器（与 `check-workflow-yaml.mjs` 同一取舍）——
// 它只按行扫描上面三类结构。远端校验器仍是权威；本文件顶部那行接口就是给它用的。
//
// 用法：node scripts/check-gitcode-workflow-rules.mjs   （有违规即非零退出）

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(root, ".gitcode", "workflows");

const RUNS_ON_WHITELIST = ["default", "ubuntu-latest", "euler-latest", "ubuntu-24", "ubuntu-22"];
// 名称字符集：中文 + 英文字母数字 + - _ , ; : . / ( ) （） + 空格
const NAME_RE = /^[\u4e00-\u9fffA-Za-z0-9\-_,;:./()（） ]{1,128}$/;
const ACTION_RE = /^actions\/[A-Za-z0-9._-]+@v\d+$/;

// 已存在的豁免：明确登记，写清原因与出口。一个"会误报"或"说不清为什么豁免"的门禁很快会被绕过。
const EXEMPT = new Map([
  [
    "build-linux.yml",
    "既有发布管线文件，校验器报多条（runs-on 不在白名单 / 步骤缺 name / 名称含非法字符 / 简写 action）。" +
      "本分支**不改**它——发版线由 Windows 侧负责（铁律 2），清单已发到信箱等他们决定。",
  ],
]);

const files = [];
try {
  for (const name of readdirSync(DIR).sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const p = join(DIR, name);
    if (statSync(p).isFile()) files.push({ name, path: p });
  }
} catch {
  console.log("没扫到 .gitcode/workflows 目录（GitHub-only 检出？）——跳过。");
  process.exit(0);
}
if (files.length === 0) {
  console.log(".gitcode/workflows 下没有 yml——跳过。");
  process.exit(0);
}

const problems = [];
const notes = [];

for (const { name, path } of files) {
  const lines = readFileSync(path, "utf8").split("\n");
  const exempt = EXEMPT.get(name);
  const fileProblems = [];

  let inJobs = false;
  let jobIndent = null;
  let currentJob = null;
  let step = null; // { hasName, uses, line }

  const flushStep = () => {
    if (!step) return;
    if (!step.hasName) fileProblems.push(`L${step.line}: 该 step 没有 name（裸 uses/run 会被校验器拒）`);
    if (step.uses && !ACTION_RE.test(step.uses)) {
      fileProblems.push(`L${step.line}: action 写法 \`${step.uses}\` 不合规（应为 actions/xxx@vN）`);
    }
    step = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const noComment = raw.replace(/\s+#.*$/, "");
    if (/^\s*$/.test(noComment) || /^\s*#/.test(noComment)) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const body = noComment.trim();

    if (/^jobs:\s*$/.test(body)) {
      inJobs = true;
      jobIndent = null;
      continue;
    }
    if (inJobs && indent === 0 && !/^jobs:/.test(body)) {
      flushStep();
      inJobs = false;
    }
    if (!inJobs) continue;

    // job 头：两个空格缩进的 `key:`
    if (indent === 2 && /^[A-Za-z0-9_-]+:\s*$/.test(body)) {
      flushStep();
      jobIndent = indent;
      currentJob = body.replace(/:\s*$/, "");
      continue;
    }
    if (jobIndent === null) continue;

    // job 的 name
    const jobName = /^name:\s*(.+)$/.exec(body);
    if (indent === jobIndent + 2 && jobName && !step) {
      const v = jobName[1].trim();
      if (!NAME_RE.test(v)) fileProblems.push(`L${i + 1}: job \`${currentJob}\` 的 name 含非法字符或超长：${v}`);
      continue;
    }

    // step：六个空格缩进的 `- ...`
    if (indent === jobIndent + 4 && body.startsWith("- ")) {
      flushStep();
      step = { hasName: false, uses: "", line: i + 1 };
      const rest = body.slice(2).trim();
      const nm = /^name:\s*(.+)$/.exec(rest);
      if (nm) {
        const v = nm[1].trim().replace(/^["']|["']$/g, "");
        step.hasName = v.length > 0;
        if (!NAME_RE.test(v)) fileProblems.push(`L${i + 1}: step 名含非法字符或超长：${v}`);
      }
      const us = /^uses:\s*(.+)$/.exec(rest);
      if (us) step.uses = us[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (step) {
      const nm = /^name:\s*(.+)$/.exec(body);
      if (nm) {
        const v = nm[1].trim().replace(/^["']|["']$/g, "");
        step.hasName = v.length > 0;
        if (!NAME_RE.test(v)) fileProblems.push(`L${i + 1}: step 名含非法字符或超长：${v}`);
      }
      const us = /^uses:\s*(.+)$/.exec(body);
      if (us) step.uses = us[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    // runs-on（job 级）
    const ro = /^runs-on:\s*(.+)$/.exec(body);
    if (ro && indent === jobIndent + 2) {
      const v = ro[1].trim().replace(/^["']|["']$/g, "");
      if (!v.startsWith("[")) {
        const list = v.split(",").map((s) => s.trim());
        const bad = list.filter((x) => !RUNS_ON_WHITELIST.includes(x));
        if (bad.length) {
          fileProblems.push(
            `L${i + 1}: job \`${currentJob}\` 的 runs-on 不在白名单（${bad.join(", ")}）；允许：${RUNS_ON_WHITELIST.join(", ")}`,
          );
        }
      }
    }
  }
  flushStep();

  if (exempt) {
    notes.push(`${name}：已豁免（${exempt}）${fileProblems.length ? ` —— 校验器类问题 ${fileProblems.length} 条` : ""}`);
  } else {
    problems.push(...fileProblems.map((p) => `${relative(root, path)}:${p}`));
  }
}

for (const n of notes) console.log(`  豁免：${n}`);
if (problems.length) {
  console.error("`.gitcode/workflows/*.yml` 违反 GitCode 平台规则（这些规则由远端校验器实测得出）：");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("  修法见本文件头注；远端权威校验：POST /api/v8/repos/:owner/:repo/actions/workflows/validate");
  process.exit(1);
}
console.log(`GitCode workflow 平台规则通过：${files.length} 个文件（豁免 ${notes.length} 个）。`);
