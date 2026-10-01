#!/usr/bin/env node
// scripts/check-decision-ids.mjs
//
// 门禁：**决策编号不许再以裸 `D<数字>` 出现** —— 决策清单用 `DEC-<数字>`。
//
// ## 为什么需要它（incident，2026-09-30 实测）
//
// `docs/plans/2026-09-29-owner-decisions-pending.md` 的**决策**编号是 `D1–D18`，
// 而 `docs/specs/2026-09-29-enterprise-edition-requirements.md` 的**需求**组也是 `D1–D4`
// （§1.4 交付与部署：可自建／零依赖起跑／客户端 AGPL／两边不许互嵌）。
// ⇒ 2026-09-30 一次**独立**的可行性核验（windows）按"指标组"数数时，
//   把**需求的** `D1–D4` 当成了决策项 ⇒ **漏数了四个指标**（读到 32，实际 36）。
// ⇒ ⇒ 这类"同名两组"不会让任何测试变红，只会让人**数错/核错** ⇒ 只能靠命名隔离 ＋ 机器判据。
//
// ## 判据（5 条，全部可机械执行）
//
// R0 **取数**：决策编号集合 = `owner-decisions-pending` 里 `| **D<n>** |` 表行解析出的 id 集合
//    （不硬编码：清单加一条，本门禁自动跟上）。
// R1 **未登记文件**：`docs/` 里没进 `ALLOWED_BARE_D` 清单的文件，**不许出现裸 `D<数字>`**。
//    ⇒ 决策引用今天分散在 `nightly-handoff`／`virtual-lan-*`／`realtime-body-*` 等文件里；
//      它们一旦残留裸 `D#`，就会与需求组再次撞车。
// R2 **已登记文件**：裸 `D<数字>` 的 id 必须落在该文件的**允许集**里（那是它的"自有编号族"）。
// R3 **混用文件**：允许集里既有"需求/待查族"又有决策引用的文件（feasibility／realtime-body-*／nearby-*），
//    含裸 `D<数字>` 的**行**必须带"需求/待查语境"标记 ⇒ 否则判违规（这一条防的正是
//    "同一份文件里 `D3` 既当需求又当决策"那种最危险的混用）。
// R4 **`DEC-<n>` 的取值域**：n 必须 ∈ R0 的集合；且不许 `DEC-0`／`DEC-01`／`DEC_1` 这类形态。
// R5 **改名留痕**：决策主载体里必须至少有一处 `DEC-`（证明改名真的发生过，而不是把 D 全删了）。
//
// ⚠️ 边界（写下来免得后人"顺手扩大"）：本门禁**只管编号形态**，不管"哪条决策拍没拍"。
//    它证明不了语义 —— 那靠人。它保证的是：**两组编号不会再撞车**。
//
// 退出码：0 干净 / 1 有发现 / 2 环境不具备（找不到 docs ⇒ **不算通过**）/ 3 无可检查对象
//
// 用法：
//   node scripts/check-decision-ids.mjs
//   node scripts/check-decision-ids.mjs --root <dir>     # 自测/夹具用
//   node scripts/check-decision-ids.mjs --self-test

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

/** 决策主载体（R0 从这里取决策编号；R5 也钉它）。 */
export const DECISION_CARRIER = "docs/plans/2026-09-29-owner-decisions-pending.md";

/**
 * 允许出现裸 `D<数字>` 的文件 → 该文件**自有编号族**的 id 集。
 * ⚠️ 没进这张表的文件 ⇒ 一个裸 `D#` 都不许有（R1）。
 * `context` 省略 ⇒ 整份文件都是同一族（不做行级语境判定）；
 * 给了正则 ⇒ 只在该正则命中的行上才允许（R3）。
 */
export const ALLOWED_BARE_D = {
  // ---- 决策主载体：它**必须**提到"需求那个同名的 D1–D4"才能讲清歧义 ⇒ 只在需求语境行上放行 ----
  "docs/plans/2026-09-29-owner-decisions-pending.md": {
    ids: [1, 2, 3, 4],
    // 需求语境＝"需求/待查"＋需求 §1.4 那组自己的词（交付与部署：可自建／零依赖／AGPL／不许互嵌）
    context: /(需求|待查|成员角色|审计|内容级治理|SSO|同名的组|交付|部署|可自建|零依赖|AGPL|内嵌)/,
    // 它还要**引述旧编号**（"原 `D1–D18`"）⇒ 那种历史引述放行
    crossRef: { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], context: /(原|当时|改自)/ },
  },
  // ---- 企业版需求的自有组（D＝交付与部署，见 requirements §1.4）----
  "docs/specs/2026-09-29-enterprise-edition-requirements.md": { ids: [1, 2, 3, 4] },
  "docs/specs/2026-09-29-enterprise-edition-spec.md": { ids: [1, 2, 3, 4] },
  "docs/specs/2026-09-29-enterprise-edition-tasks.md": { ids: [1, 2, 3, 4] },
  // 对标表在出处列里会**引用需求的 D1**（交付与部署）⇒ 只在「需求/交付/部署」语境上放行（2026-09-30 加）
  "docs/specs/2026-09-29-strongest-enterprise-benchmark.md": {
    ids: [],
    crossRef: { ids: [1, 2, 3, 4], context: /(需求|交付|部署|可自建|零依赖|AGPL|内嵌)/ },
  },
  "docs/specs/2026-09-29-enterprise-edition-approach.md": {
    ids: [1, 2, 3, 4],
    // 它还会**跨文件**引用 realtime-body 的「§7 待查」编号（如 `§7-D5`）⇒ 那种引用放行
    crossRef: { ids: [1, 2, 3, 4, 5, 6], context: /(§ ?7|§ ?10|需求|待查)/ },
  },
  "docs/plans/2026-09-29-requirements-judgment-matrix.md": { ids: [1, 2, 3, 4] },
  "docs/plans/2026-09-29-both-editions-iteration-plan.md": { ids: [1, 2] },
  // ---- 需求/待查（各自**文件内**的族）----
  "docs/specs/2026-09-29-realtime-body-requirements.md": { ids: [1, 2, 3, 4, 5, 6] },  // 整份文件只有"§7 待查"一族
  "docs/specs/2026-09-29-realtime-body-approach.md": { ids: [1, 2, 3, 4, 5, 6], context: /(需求|待查|§ ?7)/ },
  "docs/specs/2026-09-29-realtime-body-tasks.md": { ids: [1, 2, 3, 4, 5, 6], context: /(需求|待查|§ ?7)/ },
  "docs/specs/2026-09-29-realtime-body-spec.md": { ids: [1, 2, 3, 4, 5, 6], context: /(需求|待查|§ ?7)/ },
  "docs/specs/2026-09-29-nearby-devices-requirements.md": { ids: [1, 2, 3, 4, 5] },  // 整份文件只有"§7 待查"一族
  "docs/specs/2026-09-29-nearby-devices-approach.md": { ids: [1, 2, 3, 4, 5], context: /(需求|待查|§ ?7)/ },
  "docs/specs/2026-09-29-nearby-devices-tasks.md": { ids: [1, 2, 3, 4, 5], context: /(需求|待查|§ ?7)/ },
  // ---- 门禁总表：讲清"为什么要有本门禁"必须拿实例（含裸 D 号）⇒ 只在"讲撞车"的语境上放行 ----
  "docs/TESTING.md": {
    ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    context: /(需求|原|同名|也叫|决策|裸|待查|放行|编号|§ ?7)/,
  },
  // ---- 混用：既有需求族（D1–D4＝交付与部署），又有决策引用 ⇒ 行级语境（R3）----
  "docs/plans/2026-09-30-feasibility-of-requirement-metrics.md": {
    ids: [1, 2, 3, 4],
    context: /(需求|G1|可自建|零依赖|AGPL|内嵌|许可|^\| \*\*D[1-4]\*\* \|)/,
  },
  // ---- 别的编号族（与本决策清单无关，但也不许"顺手"改）----
  "docs/plans/2026-09-10-plugin-host-isolation-plan.md": { ids: [1, 2, 3, 4, 5, 6, 7] },
  "docs/plans/2026-09-23-desktop-near-realtime-stream-design.md": { ids: [2, 3] },
  "docs/roadmap.md": { ids: [7] },
  // ---- 工作区账本（`_workspace/mutation-evidence.json`）的判据编号：D2/D3 ----
  "docs/specs/INVARIANTS.md": { ids: [2, 3] },
  "docs/specs/README.md": { ids: [2, 3] },
  "docs/specs/2026-09-28-mcp-host-spec.md": { ids: [2] },
  "docs/specs/2026-09-28-knowledge-and-agent-access-spec.md": { ids: [2] },
  "docs/specs/2026-09-28-knowledge-and-agent-access-requirements.md": { ids: [1] },
  "docs/specs/2026-09-29-spec-layer-review-findings.md": { ids: [2, 3] },
  // 2026-10-01：同一族（引的是**工作区账本**的判据 D2/D3/D4）—— 补登，别机那笔漏了 ✓
  "docs/specs/2026-09-28-llm-wiki-spec.md": { ids: [2, 3, 4] },
  "docs/plans/2026-09-28-mcp-host-m1-workorder.md": { ids: [2] },
};

const D_RE = /\bD(\d{1,2})\b/g;
const DEC_RE = /\bDEC[_-]?(\d{1,2})\b/g;

function walkMd(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walkMd(p, out);
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

/** R0：从决策主载体解析决策编号集合。 */
export function decisionIds(root) {
  const p = join(root, DECISION_CARRIER);
  if (!existsSync(p)) return null;
  const ids = new Set();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\|\s*\*\*(?:DEC-|D)(\d{1,2})\*\*\s*\|/);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

export function check(root) {
  const ids = decisionIds(root);
  if (!ids || ids.size === 0) return { env: true, findings: [] };
  const findings = [];
  const carrier = readFileSync(join(root, DECISION_CARRIER), "utf8");

  for (const abs of walkMd(join(root, "docs"))) {
    const rel = abs.slice(root.length + 1);
    const allow = ALLOWED_BARE_D[rel];
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");

    // R1 / R2 / R3
    lines.forEach((line, i) => {
      D_RE.lastIndex = 0;
      let m;
      while ((m = D_RE.exec(line))) {
        const id = Number(m[1]);
        const at = `${rel}:${i + 1}`;
        // 语境判定看**命中点周围的窗口**（不是整行）：同一行常同时出现"需求 D1–D4"与"决策 D5"
        const win = line.slice(Math.max(0, m.index - 45), m.index + m[0].length + 45);
        if (!allow) {
          findings.push({ rule: "R1", at, id, line: i + 1, col: m.index + 1, why: "该文件未登记「自有编号族」 ⇒ 裸 D# 必是决策引用" });
        } else if (
          !allow.ids.includes(id) &&
          !(allow.crossRef && allow.crossRef.ids.includes(id) && allow.crossRef.context.test(win))
        ) {
          findings.push({ rule: "R2", at, id, line: i + 1, col: m.index + 1, why: `该文件的编号族只有 D${allow.ids.join("/D")}` });
        } else if (allow.context && !allow.context.test(win)) {
          findings.push({
            rule: "R3",
            at,
            id,
            line: i + 1,
            col: m.index + 1,
            why: "混用文件里，裸 D# 的**命中点周围**必须带「需求/待查语境」标记（否则它读起来就是决策引用）",
          });
        }
      }
    });

    // R4
    lines.forEach((line, i) => {
      DEC_RE.lastIndex = 0;
      let m;
      while ((m = DEC_RE.exec(line))) {
        const id = Number(m[1]);
        if (!ids.has(id)) {
          findings.push({ rule: "R4", at: `${rel}:${i + 1}`, id, why: `DEC-${id} 不在决策编号集合（${[...ids].sort((a, b) => a - b).join(",")}）里` });
        }
      }
    });
    if (/DEC[_-]?0\b/.test(text)) {
      findings.push({ rule: "R4", at: rel, id: 0, why: "不许 DEC-0" });
    }
  }

  // R5
  if (!/\bDEC-/.test(carrier)) {
    findings.push({ rule: "R5", at: DECISION_CARRIER, id: null, why: "决策主载体里一处 DEC- 都没有 ⇒ 改名没发生（或把 D 直接删了）" });
  }
  return { env: false, findings, ids };
}

/** `--self-test`：正例（干净）与负例（三种违规）都验一遍 —— 本仓对静态判据的口径（specs/README §"静态扫描"）。 */
function selfTest() {
  const mk = mkdtempSync(join(tmpdir(), "did-selftest-"));
  mkdirSync(join(mk, "docs", "plans"), { recursive: true });
  const carrier = join(mk, "docs", "plans", "2026-09-29-owner-decisions-pending.md");
  writeFileSync(carrier, "# c\n| **DEC-1** | a |\n| **DEC-2** | b |\n");
  const ok = join(mk, "docs", "ok.md");
  const bad = join(mk, "docs", "bad.md");
  const cases = [
    ["正例：干净", "决策 DEC-1 ✓\n", 0],
    ["负例：未登记文件的裸 D#", "决策 DEC-1，但这里是裸 D5\n", 1],
    ["负例：DEC 超出决策域", "这里写 DEC-9（决策域只有 1,2）\n", 1],
    ["负例：登记文件的号不在自有族里", "裸 D3 出现在未登记的文件\n", 1],
  ];
  let fail = 0;
  for (const [name, text, want] of cases) {
    const clean = name.startsWith("正");
    writeFileSync(clean ? ok : bad, text);
    if (clean) rmSync(bad, { force: true });
    const got = check(mk).findings.length === 0 ? 0 : 1;
    if (got !== want) {
      console.error(`  ✗ self-test「${name}」期望 ${want} 实得 ${got}`);
      fail++;
    }
  }
  rmSync(mk, { recursive: true, force: true });
  if (fail) {
    console.error(`self-test 失败：${fail} 例`);
    process.exit(1);
  }
  console.log(`✓ self-test 通过（${cases.length} 例：1 正 ＋ 3 负）`);
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) selfTest();
  const rootArg = argv.indexOf("--root");
  const root = resolve(rootArg >= 0 ? argv[rootArg + 1] : DEFAULT_ROOT);
  if (!existsSync(join(root, "docs"))) {
    console.error("环境不具备：找不到 docs/ ⇒ 不算通过");
    process.exit(2);
  }
  const { env, findings, ids } = check(root);
  if (env) {
    console.error("环境不具备：找不到决策主载体 ⇒ 不算通过");
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log(`✓ 决策编号无裸 D#：决策域 DEC-1…DEC-${Math.max(...ids)}（${ids.size} 条）｜裸 D# 只出现在登记过的自有编号族里`);
    process.exit(0);
  }
  console.error(`决策编号门禁未通过：${findings.length} 处`);
  for (const f of findings) console.error(`  ✗ [${f.rule}] ${f.at}  D${f.id ?? "?"} —— ${f.why}`);
  console.error("  ⇒ 决策引用一律写成 DEC-<n>（见 docs/plans/2026-09-29-owner-decisions-pending.md 表头）");
  process.exit(1);
}

if (isMain(import.meta.url)) main();
