#!/usr/bin/env node
// check-spec-judge-carriers.mjs —— 「规格里点名的**承重渠道**必须真实存在」
//
// ## 为什么需要它（incident，2026-09-30 实测）
//
// `nearby-devices-spec` 那族（`INV-NS-*`／`INV-NEARBY-*`／`INV-AWARE-*`）**按本仓铁律不进
// `INVARIANTS.md`**（五条里三条 `❌ 无（要立）`）⇒ 于是 `check-invariants-pointers` 那种
// "**规格里写着「能」的行必须点名一个已注册的 `check-*.mjs`**" 的判据**够不到它**：
//   · 它的判据**大多不是 `check-*.mjs`**，而是 **Rust 单测**（`mesh::tests::…`）与
//     **vitest wiring**（`syncPanelMesh.wiring.test.ts`）⇒ 硬套既有门禁只会**逼人写假名字**；
//   · 而它的表是 **4 列 / 3 列**的形态（不是 7 列）⇒ 既有门禁的行解析器（要求 ≥7 列、
//     且状态在第 5 格）**一行都解析不到** ⇒ 只会"没检查到东西"（**假红**）。
// ⇒ ⇒ 而"**散文里承诺了、机器不盯**"这件事今晚已经害过三次（编号撞车漏数 4 条／`presence.page_id`
//    打穿"只知元数据"／`check-licenses` 被写成"已有"却不存在）⇒ 所以补这一条**窄**判据。
//
// ## 判据（2 条，纯读文本 ＋ 两个注册表 ⇒ 本机可验）
//
// C1 **判据载体必须真实存在**：目标规格里点名的**承重渠道**只有两种写法，逐种核：
//    · `` `check-xxx` `` / `` `check-xxx.mjs` `` ⇒ `scripts/check-xxx.mjs` **必须存在**
//      ＋ **必须在 `scripts/lib/gates.mjs` 里注册**（＝没人跑 ≠ 判据）；
//    · `` mod::tests::name `` ⇒ `src-tauri/src/<mod>.rs`（找不到该文件就遍历 `src-tauri/src/**`）
//      **必须真的含这个测试名**（改名 ⇒ 规格里那句承诺就烂了）。
// C2 **§18.1 索引表的 id 卫生**（`DEC-10` 那类病的机器版）：
//    · 同一个 id 在 **§18.1 里不许有两行**（同一件事两处各判一次）；
//    · 被划掉（`~~…~~`）的行**必须点出取代者**（含 `取代/并入/改名/现名/退休` 之一）。
//
// ## ⚠️ 刻意**不做**的（边界，写下来免得后人「顺手扩大」）
//
// · **不扫普通路径引用**（`src/…`、`../specs/…`、`_workspace/…`）：本规格是**留痕很重**的文档
//   —— 例如 `src-tauri/src/nearby_invite.rs` 是**已按 `0c7ad349` 删除**的、`scripts/criteria-mutations.json`
//   是**从来没存在过**的通道 ⇒ 一律"路径必须在"会**误伤留痕**（本仓口径：「引用了已废的东西 ≠ 矛盾」）。
//   那类要靠人读，不是本判据的事。
// · **不判"它跑起来绿不绿"**（那是 `test-report` / `check-all` 的事）；也不判措辞。
// · **不判 §18.1 的「在哪节」指向对不对**（那要解析全文档结构 ⇒ 另立一条时再说）。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 环境不具备（读不到目标规格或注册表 ⇒ **不算通过**）／ 3 无可检查对象
// 用法：node scripts/check-spec-judge-carriers.mjs ／ --self-test

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const GATES = join(ROOT, "scripts", "lib", "gates.mjs");

/** 目标清单：一份规格一行（加新规格就加一行 —— 与 `check-invariants-pointers` 同一手感） */
export const TARGETS = [
  { label: "附近设备（INV-NEARBY／INV-NS）", spec: "docs/specs/2026-09-29-nearby-devices-spec.md" },
];

const CHECK_RE = /\bcheck-[a-z0-9-]+(?:\.mjs)?\b/g;
// ⚠️ 名称段用**宽字符集**（`[A-Za-z0-9_]+`）：**别用 `[a-z0-9_]+`** —— 那样遇到大小写混合的名字
//    会在第一个大写处**截断**，于是"改脏了的名字"退化成"真名字的前缀"⇒ **假绿**（2026-09-30 变异实测抓到的）。
const RUST_TEST_RE = /\b([A-Za-z_][A-Za-z0-9_]*)::tests::([A-Za-z0-9_]+)/g;
const SEC_18_1_RE = /^###\s*18\.1\b/;
const SEC_18_2_RE = /^###\s*18\.2\b/;
const ID_RE = /`(INV-[A-Za-z-]+-[a-z-]+)`/;

/** 纯判据：返回 findings（空数组 ＝ 干净）。`root` 用于解析仓内路径。 */
export function checkTarget({ label, specText, gatesText, exists, readFile, listSrc }) {
  const out = [];
  const hit = (m) => `${label} ｜ ${m}`;

  // ── C1 判据载体 ───────────────────────────────────────────────
  const checks = [...new Set([...specText.matchAll(CHECK_RE)].map((m) => m[0]))];
  for (const c of checks) {
    const base = c.replace(/\.mjs$/, "");
    const rel = "scripts/" + base + ".mjs";
    if (!exists(rel)) {
      out.push(hit(`C1 点名了 \`${c}\`，但 ${rel} **不存在** ⇒ 规格在说一件没有的事`));
      continue;
    }
    if (!gatesText.includes(base)) {
      out.push(hit(`C1 点名了 \`${c}\`：文件在，但**没进 \`scripts/lib/gates.mjs\`** ⇒ 等于没人跑`));
    }
  }

  const rustTests = [...new Set([...specText.matchAll(RUST_TEST_RE)].map((m) => m[0]))];
  for (const t of rustTests) {
    const [mod, , name] = t.split("::");
    const direct = "src-tauri/src/" + mod + ".rs";
    const files = exists(direct.toString()) ? [direct] : listSrc();
    // ⚠️ 必须**整名**匹配 `fn <name>`（`\b` 收尾）—— 只判"含前缀"会让**改脏的名字**照样绿。
    const want = new RegExp("\\bfn\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    const found = files.some((f) => want.test(readFile(f)));
    if (!found) {
      out.push(
        hit(`C1 点名了 \`${t}\`：**没有任何 .rs 里有 \`fn ${name}\`**（改名／删了／写脏了？）⇒ 规格里那句承诺已经烂了`)
      );
    }
  }
  if (checks.length === 0 && rustTests.length === 0) {
    out.push(hit("C1 **一个判据载体都没解析到** ⇒ 判据没检查到东西（不算通过 ✗）"));
  }

  // ── C2 §18.1 的 id 卫生 ──────────────────────────────────────
  const lines = specText.split("\n");
  const start = lines.findIndex((l) => SEC_18_1_RE.test(l));
  const endRel = lines.findIndex((l, i) => i > start && SEC_18_2_RE.test(l));
  const end = endRel > start ? endRel : lines.length;
  if (start < 0) {
    out.push(hit("C2 找不到 `### 18.1` 那一节 ⇒ 判据没检查到东西（不算通过 ✗）"));
  } else {
    const seen = new Map();
    let rows = 0;
    for (let i = start + 1; i < end; i++) {
      const id = (lines[i].match(ID_RE) || [])[1];
      if (!id || !lines[i].startsWith("|")) continue;
      rows++;
      const struck = lines[i].includes("~~");
      if (!struck) {
        const n = (seen.get(id) || 0) + 1;
        seen.set(id, n);
        if (n > 1) {
          out.push(
            hit(`C2 §18.1 里 \`${id}\` **有两行都没划掉**（第 ${i + 1} 行是第二次）⇒ 同一件事两处各判一次`)
          );
        }
      } else if (!/(取代|并入|改名|现名|退休)/.test(lines[i])) {
        out.push(hit(`C2 §18.1 第 ${i + 1} 行把 \`${id}\` 划掉了，却**没说谁取代它** ⇒ 留痕不完整`));
      }
    }
    if (rows === 0) out.push(hit("C2 §18.1 里一行 id 都没解析到 ⇒ 判据没检查到东西（不算通过 ✗）"));
  }
  return out;
}

/** 真跑：读目标规格 ＋ 注册表 ⇒ findings */
export function run(root = ROOT) {
  const gatesPath = join(root, "scripts", "lib", "gates.mjs");
  if (!existsSync(gatesPath)) return { envMissing: gatesPath };
  const gatesText = readFileSync(gatesPath, "utf8");
  const exists = (rel) => existsSync(join(root, rel));
  const readFile = (rel) => readFileSync(join(root, rel), "utf8");
  const listSrc = () => {
    const dir = join(root, "src-tauri", "src");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".rs"))
      .map((f) => "src-tauri/src/" + f);
  };
  const findings = [];
  let carriers = 0;
  for (const t of TARGETS) {
    const p = join(root, t.spec);
    if (!existsSync(p)) return { envMissing: p };
    const specText = readFileSync(p, "utf8");
    carriers += new Set([...specText.matchAll(CHECK_RE)].map((m) => m[0])).size;
    carriers += new Set([...specText.matchAll(RUST_TEST_RE)].map((m) => m[0])).size;
    findings.push(...checkTarget({ ...t, specText, gatesText, exists, readFile, listSrc }));
  }
  return { findings, carriers };
}

function selfTest() {
  const gatesText = 'id: "check-real", group: "contract"';
  const exists = (rel) => rel === "scripts/check-real.mjs" || rel === "src-tauri/src/mesh.rs";
  const readFile = (rel) =>
    rel === "src-tauri/src/mesh.rs" ? "fn resolves_the_fingerprint_pair() {}" : "";
  const listSrc = () => ["src-tauri/src/mesh.rs"];
  const mk = (body) =>
    "### 18.1 x\n| id | 一句话 | 在哪节 |\n|---|---|---|\n" +
    "| **`INV-NS-a`** | 甲 | §1 |\n" +
    "| ⚠️ ~~**`INV-NS-b`**~~ **【已并入 `INV-NS-a`】** | 乙 | §1 |\n" +
    body;
  const cases = [
    ["正例：判据都在 ＋ id 各一行 ⇒ 空", checkTarget({ label: "t", specText: mk("`check-real` ＋ `mesh::tests::resolves_the_fingerprint_pair`\n"), gatesText, exists, readFile, listSrc }).length === 0],
    ["C1：点名不存在的 check ⇒ 红", checkTarget({ label: "t", specText: mk("`check-nope`\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("不存在"))],
    ["C1：check 在但没注册 ⇒ 红", checkTarget({ label: "t", specText: mk("`check-real`\n"), gatesText: "// 空注册表", exists, readFile, listSrc }).some((s) => s.includes("没进"))],
    ["⭐ C1：Rust 测试名不存在 ⇒ 红（改名就烂）", checkTarget({ label: "t", specText: mk("`mesh::tests::renamed_away`\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("没有任何 .rs"))],
    ["⭐⭐ C1：名字被**改脏**（前缀还在）也必须红 —— 只判前缀会假绿", checkTarget({ label: "t", specText: mk("`mesh::tests::resolves_the_fingerprint_pairX`\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("没有任何 .rs"))],
    ["C1：一个载体都没有 ⇒ 红（不许假绿）", checkTarget({ label: "t", specText: mk("没有判据\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("没检查到东西"))],
    ["C2：同一 id 两行都没划掉 ⇒ 红", checkTarget({ label: "t", specText: mk("| **`INV-NS-a`** | 又一遍 | §1 |\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("两行都没划掉"))],
    ["C2：划掉了但没说谁取代 ⇒ 红", checkTarget({ label: "t", specText: mk("| ⚠️ ~~**`INV-NS-c`**~~ | 丙 | §1 |\n"), gatesText, exists, readFile, listSrc }).some((s) => s.includes("没说谁取代"))],
    ["C2：找不到 §18.1 ⇒ 红（不算通过）", checkTarget({ label: "t", specText: "没有这一节 `check-real`\n", gatesText, exists, readFile, listSrc }).some((s) => s.includes("找不到"))],
  ];
  let pass = 0;
  for (const [name, ok] of cases) {
    console.log((ok ? "  ✓ " : "  ✗ ") + name);
    if (ok) pass++;
  }
  console.log("self-test: " + pass + "/" + cases.length + " 通过");
  process.exit(pass === cases.length ? 0 : 1);
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  const r = run();
  if (r.envMissing) {
    console.error("环境不具备：读不到 " + r.envMissing + " ⇒ **不算通过**");
    process.exit(2);
  }
  if (r.findings.length) {
    console.error("规格判据载体门禁未通过：" + r.findings.length + " 处");
    for (const f of r.findings) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log(
    "✓ 规格点名的承重渠道都在：查了 " + TARGETS.length + " 份规格 / " + r.carriers +
      " 个判据载体（`check-*.mjs` 对 `gates.mjs` ＋ `mod::tests::name` 对 `src-tauri/src/*.rs`）＋ §18.1 id 卫生 ✓"
  );
}
