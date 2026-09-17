// 真样张冒烟跑器 —— 用**真实文档**跑一遍抽取，而不是我造的最小夹具。
//
// 为什么需要它：合成夹具只能验"我想到的情况"。真实 WPS/Office/各类 PDF 里有一堆我没写进夹具的结构
// （段内换行、稀疏单元格、修订模式、域代码、公式、图片占位……）。**落地当天就靠这一层抓到过
// 一次真 bug**（docx 的 `<w:br/>`/`<w:tab/>` 被整段丢掉，而合成夹具全绿）。
//
// 设计上的三个刻意选择：
//  1. **不做内容断言**。真样张的"期望文本"不该由我凭空写死——那只是把我的猜测固化成判据。
//     这里只做**健全性检查**（不抛、非空、无标签残留）并**打印摘要**，内容对不对由人在集成验收时看。
//  2. **没配 `EXTRACT_SAMPLES` 就整体跳过**（`describe.skipIf`），所以它在 CI 里是惰性的，
//     不会因为"某台机器上恰好没有样张"而变红或假绿。
//  3. **不把样张放进仓库**：路径由环境变量给，`tmp/` 也已 gitignore ⇒ 仓库里不留二进制。
//
// 用法（在仓库根）：
//   EXTRACT_SAMPLES=<某个目录> npx vitest run src/lib/extract/realSamples.test.ts --reporter=verbose
// 目录会被**递归**遍历，不认识的后缀会走到 `no_extractor` 并如实报告（这本身也是被测行为）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";

import { extractAndStore } from "./pipeline";
import { DERIVED_SCHEMA_DDL } from "./schema";
import { createAttachmentTextStore, type SqlRunner } from "./store";
import { pickExtractor, REGISTRY } from "./registry";

const ROOT = process.env.EXTRACT_SAMPLES ?? "";

/** 递归列出目录下所有文件（跳过隐藏目录）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/**
 * 真 SQLite（sql.js）——**不能用假对象**。
 * 我第一版图省事写了个内存假 store，结果它没实现 SELECT，于是每个样张都报"0 段 / 0 字"，
 * 看起来像"抽取器坏了"实际上是跑器坏了（**差点据此报一条假 bug 给 Mac 侧**）。
 */
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): { values: unknown[][] }[];
  prepare(sql: string): {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
}

let sqlModule: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

function runnerFrom(db: SqlJsDatabase): SqlRunner {
  return {
    run: (sql, params = []) => db.run(sql, [...params]),
    query: <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind([...params]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
    exec: (sql) => db.exec(sql),
    transaction: <T>(fn: () => T) => {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

async function makeStore() {
  sqlModule ??= initSqlJs();
  const SQL = await sqlModule;
  const db = new SQL.Database() as unknown as SqlJsDatabase;
  const store = createAttachmentTextStore(runnerFrom(db));
  store.ensureSchema(DERIVED_SCHEMA_DDL);
  return store;
}

describe.skipIf(!ROOT)("真样张冒烟（EXTRACT_SAMPLES）", () => {
  const files = ROOT ? walk(ROOT) : [];

  it("目录里至少有一个文件（否则是路径配错了，不是「没有样张」）", () => {
    expect(files.length, `EXTRACT_SAMPLES=${ROOT} 下一个文件都没有`).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(ROOT, file);

    it(`${rel}`, async () => {
      const bytes = new Uint8Array(readFileSync(file));
      const ex = pickExtractor("", file, REGISTRY);

      if (!ex) {
        // 不认识的扩展名 ⇒ 如实报告，**不算失败**（真目录里本来就会混着一堆无关文件）
        // eslint-disable-next-line no-console
        console.log(`  [no_extractor] ${rel}  (${bytes.length} B)`);
        return;
      }

      const store = await makeStore();
      const started = Date.now();
      const outcome = await extractAndStore({
        attId: "sample",
        bytes,
        filename: file,
        mime: "",
        hash: `sample-${bytes.length}`,
        store,
        registry: REGISTRY,
      });
      const ms = Date.now() - started;

      if (outcome.status === "failed") {
        // 失败也**不算测试失败**：真样张里可能有加密件/扫描件/损坏件，那正是要"看见"的事实
        // eslint-disable-next-line no-console
        console.log(`  [${outcome.code}] ${rel}  (${bytes.length} B, ${ms}ms) — ${outcome.message}`);
        return;
      }
      if (outcome.status === "no_extractor") {
        // eslint-disable-next-line no-console
        console.log(`  [no_extractor] ${rel}`);
        return;
      }

      const segs = store.segmentsOf("sample");
      const chars = segs.reduce((n, r) => n + r.text.length, 0);
      const head = (segs[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 60);
      // eslint-disable-next-line no-console
      console.log(
        `  [${outcome.status}] ${rel}  (${bytes.length} B, ${ms}ms)\n` +
          `      ${outcome.extractor} · ${segs.length} 段 / ${chars} 字 · kinds=${segs.map((s) => s.kind).join(",")}\n` +
          `      首段：${head}`,
      );

      // ---- 健全性检查（只有这些，内容对不对由人看）----
      // ① 大文件不该抽出空文本（小文件可能是合法空文档）
      if (bytes.length > 4096 && chars === 0) {
        // eslint-disable-next-line no-console
        console.log(`      ⚠️ ${bytes.length} B 的文档抽出 0 字 —— 值得人工看一眼`);
      }
      // ② 出现 `<` 只**提示**、不判失败。
      //    合成夹具里可以断言"不许残留标签"（输入是我造的）；**真样张不行**——
      //    真文档里本来就可能出现 `<`（例如正文在讲 HTML/XML）。硬判会把跑器训练成
      //    "红了也没人看"，那比没有检查更糟。
      if (segs.some((s) => /<[a-zA-Z/]/.test(s.text))) {
        // eslint-disable-next-line no-console
        console.log("      ℹ️ 文本里出现 `<` —— 真样张里可能是正常内容，人工扫一眼首段即可");
      }
      // ③ 段序号必须从 0 连续（回链与缓存都依赖它）——这条对真样张同样成立，保留为硬判据
      expect(segs.map((s) => s.seq)).toEqual(segs.map((_, i) => i));
    });
  }
});
