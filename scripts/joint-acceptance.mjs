#!/usr/bin/env node
// **三平面联合验收**（国密 × 全库 AI 覆盖 × 块级 CRDT）—— 执行器。
//
// 登记表在 `scripts/lib/joint-planes.mjs`（平面 / 探针 / 联合格子 / 每格判据），
// 这里只做四件事：**看就绪**、**列格子**、**跑格子**、**如实报三态**。
//
// ## 为什么要有"看就绪"这一步（而不是直接开跑）
// 三条线都在飞：谁先到、谁还没到，**不该靠记忆**。`--plan` 把"哪一平面具备联合条件"读成事实
// （文件在不在、能力进没进注册表、本机有没有可链接的 SM 前缀），缺什么就点名什么 —— 于是
// "等 AI 全覆盖和 CRDT 具备测试条件"这句话有了一个可以随时重跑的判据，而不是一句口头约定。
//
// ## 三态（**未实查 ≠ 红**，与 check-release-state / check-gm-wired 同一口径）
//   · 就绪 / 未就绪：本机探针的事（`--check` 下未就绪 ⇒ **退出码 2**，不是 1）
//   · 未实查：需要真机/外部机器的读数（真机重启、Windows 静态前缀、LibreOffice、真模型……）
//     —— 它不判红，但联合验收**开跑前**必须有着落（`--require-external` 会把这些列出来）
//   · 红（退出码 1）：探针自己坏了（登记表指向的文件不存在、命令跑不出 `test result:` 行、
//     判据下限没达到）。**空跑即红**是这套东西的生命线：跳过与通过必须长得不一样。
//
// ## 用法
//   node scripts/joint-acceptance.mjs                      # ＝ --plan：就绪面板 ＋ 格子矩阵
//   node scripts/joint-acceptance.mjs --plan --json        # 机器可读
//   node scripts/joint-acceptance.mjs --check              # 就绪即 0；未就绪即 2；探针坏了即 1
//   node scripts/joint-acceptance.mjs --check --require sm,crdt
//   node scripts/joint-acceptance.mjs --list               # 只看格子
//   node scripts/joint-acceptance.mjs --run j1             # 跑一个格子（未落地/真机格子会如实说）
//   node scripts/joint-acceptance.mjs --run all            # 跑所有 landed 格子
//   node scripts/joint-acceptance.mjs --run j1 --dry       # 只打印命令
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { pickOpensslDir, prefixLooksLinkable, parseTestResult } from "./check-gm-wired.mjs";
import {
  PLANES,
  JOINT_CELLS,
  evaluateProbe,
  planeReadiness,
  renderJointText,
} from "./lib/joint-planes.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ---- 真 IO：**全部**注入给纯函数，纯函数里没有一行 fs ------------------------

const envImpl = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  },
  hasCommand: (name) => {
    const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    return dirs.some((d) => exts.some((e) => existsSync(join(d, name + e))));
  },
  prefixVerdict: () => {
    const dir = pickOpensslDir();
    if (!dir) {
      return {
        ok: false,
        detail:
          "没有 SM 版 OpenSSL 前缀（`OPENSSL_DIR` 未设；非 Linux 也没有默认候选）——" +
          "本机装一份 Tongsuo 或设 `OPENSSL_DIR` 再跑；否则 `check-gm-wired` 会**自报跳过**",
      };
    }
    if (!prefixLooksLinkable(dir)) {
      return { ok: false, detail: `${dir} 里没有**开发用**的 crypto 库文件（只有运行时 .so.N 链接不了）` };
    }
    return { ok: true, detail: `前缀 ${dir}（可链接）` };
  },
};

function measure() {
  const readiness = [];
  const probes = [];
  let broken = [];
  for (const plane of PLANES) {
    const results = plane.probes.map((p) => {
      let r;
      try {
        r = evaluateProbe(p, envImpl);
      } catch (e) {
        // 登记表自己坏了（例如新加了 kind 却没给分支）⇒ **红**，不是未实查。
        r = { id: p.id, external: Boolean(p.external), ok: false, detail: `探针抛错：${e.message}` };
        broken.push(p.id);
      }
      return { ...r, label: p.label, kind: p.kind, why: p.why ?? "" };
    });
    probes.push({ plane: plane.id, results });
    readiness.push(planeReadiness(plane, results));
  }
  return { readiness, probes, broken };
}

function printPlan({ readiness, probes }, { json = false } = {}) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          readiness: readiness.map((r) => ({
            id: r.id,
            state: r.state,
            missing: r.missing.map((m) => ({ id: m.id, detail: m.detail })),
            pending: r.pending.map((m) => ({ id: m.id, detail: m.detail })),
          })),
          cells: JOINT_CELLS.map((c) => ({ ...c, planes: [...c.planes] })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("═══ 三平面联合验收：就绪面板 ═══");
  for (const plane of PLANES) {
    const r = readiness.find((x) => x.id === plane.id);
    const mark = r.state === "ready" ? "✅" : "⏳";
    const local = r.local - r.missing.length;
    console.log(`\n${mark} ${plane.id} —— ${plane.title}`);
    console.log(`   ${r.state === "ready" ? "就绪" : "未就绪"}（本机探针 ${local}/${r.local} 命中）`);
    const got = probes.find((p) => p.plane === plane.id).results;
    for (const p of got) {
      const tag = p.external ? "○" : p.ok === true ? "✅" : "❌";
      console.log(`   ${tag} ${p.label}`);
      if (p.ok !== true) console.log(`        ${p.detail}`);
    }
    if (r.state === "ready" && r.pending.length) {
      console.log(`   ⚠️ 就绪只说明**本机**这一半；还有 ${r.pending.length} 条外部读数要有落着（见下）`);
    }
  }
  console.log("\n═══ 联合格子 ═══");
  for (const c of JOINT_CELLS) {
    const tag = c.state === "landed" ? "▶" : c.state === "todo" ? "✎" : "◻";
    console.log(`${tag} ${c.id} [${c.state} · ${c.owner} · ${c.planes.join("+")}] ${c.title}`);
    console.log(`    判据：${c.criterion}`);
    if (c.cmd) console.log(`    命令：${c.cmd}`);
    if (c.ref) console.log(`    参考：${c.ref}`);
  }
  console.log("\n═══ 说明 ═══");
  console.log("· `▶`=判据已在岗（今天就能跑） `✎`=施工单已写、还没落地 `◻`=需真机或外部读数");
  console.log("· `--check` 只把**本机探针**当就绪条件；外部读数（真机/Windows/LibreOffice/真模型）见 `○` 那几条");
  console.log("· 未实查**不算红**；但联合验收**开跑前**每一条 `○` 都要有着落");
}

function runCell(cell, { dry = false } = {}) {
  if (!cell.cmd) {
    console.log(`⏳ ${cell.id}：${cell.state === "todo" ? "还没落地" : "需要真机/外部读数"} —— 不是红，是「还没到」`);
    console.log(`   ${cell.criterion}`);
    if (cell.ref) console.log(`   ${cell.ref}`);
    return "pending";
  }
  console.log(`▶ ${cell.id}：${cell.title}`);
  console.log(`   $ ${cell.cmd}`);
  if (dry) return "dry";
  const started = Date.now();
  const r = spawnSync(cell.cmd, { shell: true, encoding: "utf8", env: process.env });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const tail = out.split("\n").filter((l) => l.trim()).slice(-6);
  const isCargo = /cargo test/.test(cell.cmd);
  if (isCargo) {
    const counts = parseTestResult(out);
    if (!counts) {
      console.error(`❌ ${cell.id}：拿不到 \`test result:\` 行 —— 这一格等于没跑（空跑即红）。尾部：`);
      for (const l of tail) console.error(`   | ${l}`);
      return "red";
    }
    const floor = cell.minPassed ?? 1;
    if (counts.failed !== 0 || counts.passed < floor) {
      console.error(`❌ ${cell.id}：${counts.passed} passed / ${counts.failed} failed（下限 ${floor}/0，${secs}s）`);
      for (const l of tail) console.error(`   | ${l}`);
      return "red";
    }
    console.log(`✅ ${cell.id}：${counts.passed} passed / 0 failed（${secs}s）`);
    return "green";
  }
  if (r.status !== 0) {
    console.error(`❌ ${cell.id}：退出码 ${r.status}（${secs}s）`);
    for (const l of tail) console.error(`   | ${l}`);
    return "red";
  }
  // ★ 「自报跳过 ≠ 绿」：`check-gm-wired` 这类门禁在拿不到 SM 前缀时会 `exit 0` 并说明跳过。
  //   在**单跑**的语境里那是对的（本机没这个能力，不该判红）；但在**联合验收**里，
  //   "跳过"和"跑过"必须长得不一样 —— 否则一次全绿的报告里可能有两格根本没跑。
  if (cell.forbidSkip && /跳过|skip(ped)?\b/i.test(out)) {
    console.error(`❌ ${cell.id}：命令自己报了「跳过」—— 联合验收里这一格等于**没跑**（自报跳过 ≠ 绿）`);
    for (const l of tail) console.error(`   | ${l}`);
    return "red";
  }
  console.log(`✅ ${cell.id}：退出码 0（${secs}s）`);
  return "green";
}

function main() {
  const wantCheck = has("--check");
  const wantList = has("--list");
  const runArg = argOf("--run");
  const json = has("--json");

  if (wantList) {
    for (const c of JOINT_CELLS) console.log(`${c.id} ${c.state} ${c.owner} ${c.planes.join("+")} — ${c.title}`);
    return 0;
  }

  if (runArg) {
    const targets = runArg === "all" ? JOINT_CELLS.filter((c) => c.state === "landed") : JOINT_CELLS.filter((c) => c.id === runArg);
    if (!targets.length) {
      console.error(`没找到格子 ${runArg}（--list 看全部）`);
      return 1;
    }
    const verdicts = targets.map((c) => [c.id, runCell(c, { dry: has("--dry") })]);
    console.log(`\n本轮：${verdicts.map(([id, v]) => `${id}=${v}`).join(" · ")}`);
    if (verdicts.some(([, v]) => v === "red")) return 1;
    if (verdicts.some(([, v]) => v === "pending")) return 2;
    return 0;
  }

  const measured = measure();
  printPlan(measured, { json });
  if (json) return 0;

  const broken = measured.broken.length > 0;
  const required = (argOf("--require") || "sm,coverage,crdt").split(",").map((s) => s.trim()).filter(Boolean);
  const notReady = measured.readiness.filter((r) => required.includes(r.id) && r.state !== "ready");
  if (wantCheck || has("--require")) {
    if (broken) {
      console.error(`\n❌ 探针自己坏了：${measured.broken.join(" · ")} —— 这是红（登记表与代码不一致）`);
      return 1;
    }
    if (notReady.length) {
      console.log(`\n⏳ 未就绪：${notReady.map((r) => r.id).join(" · ")} —— 联合验收还开不了（这**不是红**）`);
      console.log(`   ${renderJointText({ readiness: measured.readiness }).split("\n")[0]}`);
      return 2;
    }
    console.log(`\n✅ 就绪：${required.join(" · ")} —— 可以开跑了`);
    return 0;
  }
  return broken ? 1 : 0;
}

process.exit(main());
