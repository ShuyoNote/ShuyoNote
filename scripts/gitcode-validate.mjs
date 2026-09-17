// 用 GitCode 自己的校验接口验 `.gitcode/workflows/*.yml`（**不在门禁里跑**：需要 token + 外网）。
//
// 为什么要它：`.gitcode/workflows/*.yml` 一旦不合法，GitCode 会**整条流水线都不调度**——
// 表现是"0 个 job 的红 run"，既不报行号也不报日志（与 `check-workflow-yaml.mjs` 记的那类事故同源）。
// 离线那条窄规则门禁（`check-gitcode-workflow-rules.mjs`）只覆盖已知的三类平台约束；
// 这个脚本调的是**权威校验器**，能发现窄规则覆盖不到的问题（例如 action 是否真实存在）。
//
// 接口（2026-09-16 实测；别照 GitHub 的习惯写）：
//   POST https://api.gitcode.com/api/v8/repos/:owner/:repo/actions/workflows/validate?access_token=<token>
//   body: {"base64_content": "<yml 的 base64>"}   →   {valid: boolean, diagnostics: [{range, severity, message}]}
//   ⚠️ 主机是 api.gitcode.com；认证走 access_token **查询参数**（放 PRIVATE-TOKEN 头会 404）。
//
// 用法：
//   $env:GITCODE_TOKEN = '<你的访问令牌>'          # 或 GITCODE_TOKEN=... 前缀
//   pnpm gitcode:validate                          # 校验 .gitcode/workflows 下全部 yml
//   pnpm gitcode:validate -- .gitcode/workflows/ci.yml   # 只校验指定文件
//
// 令牌从哪来：与推仓库用的是同一个（仓库设置 → 访问令牌）；**不要**把它写进仓库或 CI 配置。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".gitcode", "workflows");
const owner = process.env.GITCODE_OWNER ?? "shuyo-cn";
const repo = process.env.GITCODE_REPO ?? "ShuyoNote";

const token = process.env.GITCODE_TOKEN;
if (!token) {
  console.error("需要 GITCODE_TOKEN（仓库设置 → 访问令牌；不要写进仓库或 CI 配置）。");
  process.exit(2);
}

const args = process.argv.slice(2).filter((a) => a !== "--");
let files = args.map((a) => resolve(root, a));
if (files.length === 0) {
  files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}
if (files.length === 0) {
  console.log("没有要校验的文件。");
  process.exit(0);
}

const api = `https://api.gitcode.com/api/v8/repos/${owner}/${repo}/actions/workflows/validate?access_token=${encodeURIComponent(token)}`;

let allValid = true;
for (const file of files) {
  const yaml = readFileSync(file, "utf8");
  let json;
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base64_content: Buffer.from(yaml, "utf8").toString("base64") }),
    });
    const text = await res.text();
    json = JSON.parse(text);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (err) {
    console.error(`✗ ${basename(file)}：请求失败 —— ${err.message}`);
    allValid = false;
    continue;
  }
  const diags = json.diagnostics ?? [];
  console.log(`${json.valid ? "✓" : "✗"} ${basename(file)}  valid=${json.valid}  diagnostics=${diags.length}`);
  for (const d of diags) {
    const at = d.range?.start ? `${d.range.start.line}:${d.range.start.column}` : "-";
    console.log(`    ${at} [${d.severity ?? "Error"}] ${d.message}`);
  }
  if (!json.valid) allValid = false;
}

console.log(allValid ? "\n全部通过 GitCode 校验。" : "\n存在不合法项（上面逐条列出；不合法 = 该流水线不会被调度）。");
// 用 exitCode 而不是 process.exit()：后者会与仍在关闭的 libuv 句柄抢收尾，
// 在 Windows 上打出 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（smoke-web.mjs 记过同一条）。
process.exitCode = allValid ? 0 : 1;
