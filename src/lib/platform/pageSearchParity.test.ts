// S1③ 跨平台检索一致性 —— **Web 侧那一半**（真 `SqliteStore` ＋ 真 sql.js ＋ 真 `search` 命令）。
//
// 桌面侧那半在 `src-tauri/src/search.rs`（`search_parity_fixture_hit_sets`），两侧读的是
// **同一份** `tests/search-parity.json`、断的是**同一组**期望值 ⇒ "同一查询两平台命中集合相等"是
// **传递**出来的，而不是两边各自记一份现状 ✗。
//
// 为什么必须有这一条：桌面走 FTS5/trigram 与 LIKE、Web 走 token-TF + `indexOf` 子串 ——
// 「同一份笔记换个平台搜出来少了一条」不炸、不报错，只是结果不同，本仓最罚的就是这一族 ✓。
//
// ⚠️ 夹具里的 `knownDivergences` 是**读数，不是约定**：这里只断言"Web 侧今天确实是这个集合"，
// 语义对齐那天它会当场红 ⇒ 逼人同步夹具那一节（而不是让分歧静默漂着 ✗）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteStore, setWasmBytesProvider } from "./sqliteStore";
import { makeInvoke } from "./web";

interface FixtureCase {
  name: string;
  query: string;
  expect?: string[];
  desktop?: string[];
  web?: string[];
  pages?: { id: string; title: string; text: string }[];
}
interface Fixture {
  note: string;
  pages: { id: string; title: string; text: string }[];
  cases: FixtureCase[];
  knownDivergences: FixtureCase[];
}

const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), "tests", "search-parity.json"), "utf8")) as Fixture;

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  setWasmBytesProvider(async () => new Uint8Array(readFileSync(wasm)));
});

/** 真 `SqliteStore`（`init()` 会建**真** `pages` schema ⇒ 别自己抄一份表 ✗），只插检索要用的那几列。 */
async function storeWith(pages: { id: string; title: string; text: string }[]) {
  const store = new SqliteStore({ load: async () => null, save: async () => {} });
  await store.init();
  const invoke = makeInvoke(store);
  // 平台自己说它当前是哪个空间 —— 别在测试里猜（猜错就是"一条都搜不到"的假红 ✓）
  const wsId = await invoke<string>("get_active_workspace_id", {});
  for (const p of pages) {
    store.run(
      "INSERT INTO pages (id, workspace_id, title, content_text, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, 1, 1, NULL)",
      [p.id, wsId, p.title, p.text],
    );
  }
  return invoke;
}

async function webHits(pages: { id: string; title: string; text: string }[], query: string): Promise<string[]> {
  const invoke = await storeWith(pages);
  const hits = await invoke<{ id: string }[]>("search", { query });
  return [...new Set(hits.map((h) => String(h.id)))].sort();
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

describe("S1③ 跨平台检索一致性（tests/search-parity.json）", () => {
  it("夹具形状：note 在 ＋ 至少两条用例 ＋ 每条有 query/expect", () => {
    expect(FIXTURE.note.length).toBeGreaterThan(40);
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(2);
    for (const c of FIXTURE.cases) {
      expect(typeof c.query).toBe("string");
      expect(Array.isArray(c.expect)).toBe(true);
    }
  });

  it("每条用例的 Web 命中集合 === 夹具期望（桌面侧断同一组值）", async () => {
    const bad: string[] = [];
    for (const c of FIXTURE.cases) {
      const got = await webHits(FIXTURE.pages, c.query);
      const want = sorted(c.expect ?? []);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`「${c.name}」（query=${c.query}）：Web=${JSON.stringify(got)} 期望=${JSON.stringify(want)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("knownDivergences 的 Web 侧读数与实测一致（读数变了就得同步夹具那一节）", async () => {
    const bad: string[] = [];
    for (const d of FIXTURE.knownDivergences) {
      const got = await webHits(d.pages ?? [], d.query);
      const want = sorted(d.web ?? []);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`「${d.name}」（query=${d.query}）：Web=${JSON.stringify(got)} 记录=${JSON.stringify(want)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
