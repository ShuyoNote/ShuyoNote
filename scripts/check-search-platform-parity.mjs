#!/usr/bin/env node
// scripts/check-search-platform-parity.mjs —— 「桌面专属的检索能力必须写进 app 侧文档」的静态判据
//
// 挡的是哪一类事故（为什么它危险）：
//   块级检索在**桌面**走 FTS5/BM25、在 **Web** 走 LIKE（`sql.js` 没编 FTS5）✗ ——
//   两边**同一个查询的排序可以不同** ✓，而这件事只写在 Rust 注释里时，app 侧读代码的人
//   会以为两边一样 ✗。用户看到的是「同一份笔记，换个平台搜出来顺序变了」，而他**没有任何线索** ✓。
//   ⇒ 这正是本仓反复罚的那族：**平台差异不炸、不报错，只是行为不同** ✗。
//
// 判据四条（窄；纯读源码 ⇒ 本机可跑 ✓）：
//   ① `src-tauri/src/db.rs` 里桌面专属的块级 FTS DDL 常量（`CHUNK_FTS_DDL`）必须在 ✓
//      —— 它没了 ⇒ 桌面的 BM25 能力消失（真回归 ✗）
//   ② 同一处必须写明「为什么它只建在桌面」（出现 `sql.js` ✓）—— 理由丢了 ⇒ 后人会把规则当怪癖删掉 ✗
//   ③ ⭐ **app 侧必须写明这个限定**：`src/lib/platform/commands.ts` 的 `search_chunks` 条目里，
//      必须同时出现「桌面」与（`FTS` 或 `BM25`）✓ —— 这是本条判据的主目标 ✓
//   ④ ⭐ **桌面专属 DDL 不许漏进共享 DDL**：TS 侧共享 schema（`src/lib/extract/schema.ts`）
//      不许出现 `chunk_fts`／`USING fts5` ✓ —— 代码注释逐字说过：放进去 ⇒ Web 建表即失败 ✗
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到必要文件（不算通过）
// 用法：node scripts/check-search-platform-parity.mjs ／ --root <夹具根> ／ --self-test
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
const REL = {
  db: "src-tauri/src/db.rs",
  cmds: "src/lib/platform/commands.ts",
  schema: "src/lib/extract/schema.ts",
};

/** 纯判据：三份文本 ⇒ { findings, passed }（findings 空＝干净 ✓） */
export function judge({ db, cmds, schema }) {
  const out = [];
  let passed = 0;
  const miss = (m) => out.push("✗ " + m);

  // ① 桌面专属 DDL 常量在不在
  if (db === null) miss("读不到 " + REL.db + " ⇒ 判据没检查到东西（不算通过 ✗）");
  else if (!db.includes("CHUNK_FTS_DDL")) miss(REL.db + " 里找不到 CHUNK_FTS_DDL ⇒ 桌面块级 FTS 能力没了（真回归 ✗）");
  else passed++;

  // ② 「为什么只建在桌面」的理由还在不在
  if (db !== null) {
    if (!/sql\.js/.test(db)) miss(REL.db + " 里不再出现 sql.js ⇒ **只建在桌面的理由丢了** ✗（后人会把它当怪癖删掉）");
    else passed++;
  }

  // ③ app 侧 search_chunks 条目必须写明限定（主目标 ✓）
  if (cmds === null) miss("读不到 " + REL.cmds + " ⇒ 不算通过 ✗");
  else {
    const i = cmds.indexOf("search_chunks");
    if (i < 0) miss(REL.cmds + " 里找不到 search_chunks 条目 ⇒ 判据没对象（不算通过 ✗）");
    else {
      const before = cmds.lastIndexOf("/**", i);
      const endBrace = cmds.indexOf("};", i);
      const block = cmds.slice(before < 0 ? i : before, endBrace < 0 ? Math.min(cmds.length, i + 400) : endBrace + 2);
      const hasDesk = /桌面/.test(block);
      const hasFts = /FTS|BM25/.test(block);
      if (!hasDesk || !hasFts) {
        miss(REL.cmds + " 的 search_chunks 条目**没有写明桌面专属**（桌面=" + hasDesk + " ／ FTS|BM25=" + hasFts
          + "）⇒ 读代码的人会以为**两个平台一样** ✗（Web 走 LIKE、排序可不同 ✓）");
      } else passed++;
    }
  }

  // ④ 桌面专属 DDL 不许漏进共享 DDL
  if (schema === null) miss("读不到 " + REL.schema + " ⇒ 判据没检查到东西（不算通过 ✗）");
  else if (/chunk_fts|USING\s+fts5/i.test(schema)) {
    miss(REL.schema + " 里出现了 chunk_fts／USING fts5 ⇒ **桌面专属 DDL 漏进共享 DDL** ✗"
      + "（`db.rs` 注释逐字：sql.js 没编 FTS5 ⇒ 放进去 ⇒ **Web 平台建表即失败** ✗）");
  } else passed++;

  return { findings: out, passed };
}

function run(root) {
  const read = (rel) => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
  const { findings, passed } = judge({ db: read(REL.db), cmds: read(REL.cmds), schema: read(REL.schema) });
  if (findings.length) {
    for (const x of findings) console.error(x);
    console.error("[结果] " + passed + " 通过 / " + findings.length + " 失败");
    return 1;
  }
  console.log("✓ 平台差异写清楚了：桌面专属 DDL 在 ＋ 理由在（sql.js 没编 FTS5）＋ app 侧写明限定 ＋ 没漏进共享 DDL");
  console.log("[结果] " + passed + " 通过 / 0 失败");
  return 0;
}

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

if (argv.includes("--self-test")) {
  const dir = mkdtempSync(join(tmpdir(), "search-parity-"));
  try {
    const write = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };
    const dbOk = '// 块级 FTS（桌面专属）\n// sql.js 没有编 FTS5 ⇒ 只建在桌面\npub const CHUNK_FTS_DDL: &str = "CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id, text)";\n';
    const cmdsOk = '  /** 块级检索（只读）。⚠️ **BM25 / FTS 那半只在桌面**，Web 走 LIKE ⇒ 排序可不同。 */\n  search_chunks: {\n    args: { args: { query: string } };\n    result: ChunkHit[];\n  };\n  other: { args: {} };\n';
    const schemaOk = 'export const DERIVED_SCHEMA_DDL = `CREATE TABLE chunks(id TEXT PRIMARY KEY);`;\n';
    const put = (k, v) => write(REL[k], v);
    const reset = () => { put("db", dbOk); put("cmds", cmdsOk); put("schema", schemaOk); };
    const noLimit = cmdsOk.replace("⚠️ **BM25 / FTS 那半只在桌面**，Web 走 LIKE ⇒ 排序可不同。", "只读。");
    const noWhy = dbOk.replace(/sql\.js/g, "某些运行时");
    const cases = [
      ["正例（四条都满足）", () => {}, 0],
      ["变异①（DDL 常量没了）", () => { put("db", dbOk.replace("CHUNK_FTS_DDL", "SOMETHING_ELSE")); }, 1],
      ["变异②（理由丢了：不再提 sql.js）", () => { put("db", noWhy); }, 1],
      ["变异③（app 侧没写桌面专属限定 ⇒ **主目标**）", () => { put("cmds", noLimit); }, 1],
      ["变异④（桌面专属 DDL 漏进共享 DDL）", () => { put("schema", schemaOk + "\nCREATE VIRTUAL TABLE chunk_fts USING fts5(x);"); }, 1],
    ];
    let pass = 0;
    for (const [name, setup, want] of cases) {
      reset();
      setup();
      const got = run(dir);
      const okc = got === want;
      if (okc) pass++;
      console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ exit=${got}（期望 ${want}）`);
    }
    const got2 = run(join(dir, "nope"));
    const ok2 = got2 === 1;
    if (ok2) pass++;
    console.log(`  ${ok2 ? "✓" : "✗"} 空扫（三份文件都不在）⇒ exit=${got2}（期望 1 ＝ 有发现，**不是 0** ✗）`);
    const total = cases.length + 1;
    console.log(`self-test: ${pass}/${total} 通过`);
    process.exit(pass === total ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

process.exit(run(argOf("--root", ROOT)));
