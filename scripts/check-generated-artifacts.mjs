#!/usr/bin/env node
// check-generated-artifacts.mjs —— 判据（施工单 Task 5，**收窄版**）：生成物必须**自证来源、并会标脏**
//
// 挡的是哪次真实事故（incident）：
//   本工作区栽过不止一次"**生成物/镜像与实际脱节而没人发现**"——最典型的一句：
//   "那句'缺口还开着'在写下 13 分钟后就过期了，两天没人看过" ✓
//   知识层这边同样危险：本体表 / 工具面 / 接口指纹都是**给人和外部程序看**的东西，
//   一旦源（能力注册表）改了而生成物没重生成，**读到的人会照着旧结构做** ✗
//
// 判据（对 `_generated/*.md` 每一个都适用 ✓，**不针对某个具体文件**）：
//   ① 必须声明**来源路径**（`capabilities/capabilities.json`）
//   ② 必须声明**来源 sha256**（行首含「注册表 sha256」，值 64 位十六进制）⇒ 与**当前**源文件一致
//      ⇒ 不一致 ⇒ **红**（这就是"标脏"：源改了、生成物没跟上 ✓）
//   ③ 必须声明**生成命令**（`node scripts/….mjs`）且该脚本**真的存在** ⇒ 可重建 ✓
// ⚠️ 与既有逐字节判据的分工：那两条比**全文**（更强）；本条是**通用的溯源兜底**（将来新增生成物自动被管 ✓）
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 生成目录不存在（**不算通过**）／ 3 目录里没有 `.md` 生成物
// 用法：node scripts/check-generated-artifacts.mjs ／ --dir <目录>（夹具 ✓）／ --self-test

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const DIR = join(ROOT, "_generated");
const SRC_REL = "capabilities/capabilities.json";

/** 纯判据：给定一个生成物的文本、来源当前 sha、以及"文件是否存在的解析器" ⇒ findings */
export function judgeOne(name, text, sourceSha, scriptExists) {
  const out = [];
  if (!text.includes(SRC_REL)) out.push("✗ " + name + "：没有声明来源路径 `" + SRC_REL + "` ⇒ 读的人不知道它从哪来 ✗");
  const m = text.match(/注册表 sha256\s*\|\s*`?([0-9a-f]{64})`?/);
  if (!m) out.push("✗ " + name + "：没有声明**来源 sha256**（行内需有「注册表 sha256」＋ 64 位十六进制）⇒ 无法标脏 ✗");
  else if (m[1] !== sourceSha) out.push("✗ " + name + "：**已标脏** —— 声明的来源 sha 与当前注册表不一致 ⇒ 重新生成 ✓");
  const c = text.match(/生成命令\s*\|\s*`([^`]+)`/);
  if (!c) out.push("✗ " + name + "：没有声明**生成命令** ⇒ 不可重建 ✗");
  else {
    const script = (c[1].match(/scripts\/[A-Za-z0-9_.\-]+\.mjs/) || [])[0];
    if (!script) out.push("✗ " + name + "：生成命令里找不到 `scripts/…mjs` 形态的脚本 ⇒ 判不了它能不能重建 ✗");
    else if (!scriptExists(script)) out.push("✗ " + name + "：声明的生成脚本不存在：" + script + " ⇒ 不可重建 ✗");
  }
  return out;
}

function run(dir) {
  if (!existsSync(dir)) { console.error("✗ 生成目录不在：" + dir + "（**不算通过**）"); return 2; }
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) { console.log("（本目录没有 .md 生成物 ⇒ 无可检查对象）"); return 3; }
  const src = join(ROOT, SRC_REL);
  if (!existsSync(src)) { console.error("✗ 读不到来源：" + SRC_REL + "（**不算通过**）"); return 2; }
  const sha = createHash("sha256").update(readFileSync(src, "utf8")).digest("hex");
  const exists = (rel) => existsSync(join(ROOT, rel));
  const all = [];
  for (const f of files) all.push(...judgeOne(f, readFileSync(join(dir, f), "utf8"), sha, exists));
  if (all.length) { for (const x of all) console.error(x); return 1; }
  console.log("✓ " + files.length + " 个生成物都自证了来源（sha 与当前注册表一致 ✓）且可重建（脚本存在 ✓）");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "gen-art-"));
  try {
    const sha = createHash("sha256").update(readFileSync(join(ROOT, SRC_REL), "utf8")).digest("hex");
    const good = "来源 `" + SRC_REL + "`\n| 注册表 sha256 | `" + sha + "` |\n| 生成命令 | `node scripts/gen-agent-tool-surface.mjs --phase m1` |\n";
    const dirty = good.replace(sha, "0".repeat(64));
    const noSha = good.replace(/\| 注册表 sha256 \| `[0-9a-f]{64}` \|/, "");
    const noCmd = good.replace(/\| 生成命令 \|[^\n]*/, "");
    const cases = [
      ["合规生成物 ⇒ 空", judgeOne("a.md", good, sha, () => true).length === 0],
      ["sha 不符 ⇒ 红（标脏）", judgeOne("a.md", dirty, sha, () => true).some((s) => s.includes("已标脏"))],
      ["缺 sha 行 ⇒ 红", judgeOne("a.md", noSha, sha, () => true).some((s) => s.includes("sha256"))],
      ["缺生成命令 ⇒ 红（不可重建）", judgeOne("a.md", noCmd, sha, () => true).some((s) => s.includes("生成命令"))],
      ["生成脚本不存在 ⇒ 红", judgeOne("a.md", good, sha, () => false).some((s) => s.includes("不存在"))],
    ];
    let pass = 0;
    for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
    console.log("self-test: " + pass + "/" + cases.length + " 通过");
    process.exit(pass === cases.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const di = argv.indexOf("--dir");
process.exit(run(di >= 0 ? argv[di + 1] : DIR));
