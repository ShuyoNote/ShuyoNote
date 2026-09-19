// 「检查索引覆盖」取材层的判据。
//
// 重点在**取材**：报告算得再对，取错清单就全错。特别是 `listPageAttachments(null)`
// 那条语义（`null` = 未整理，**不是**全部）—— 搞错会静默漏掉大多数附件。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    listPages: vi.fn(),
    listPageAttachments: vi.fn(),
  },
}));

import { api } from "./api";
import { scanLibraryCoverage } from "./libraryCoverage";
import { DERIVED_SCHEMA_DDL } from "./extract/schema";
import { createAttachmentTextStore, type SqlRunner } from "./extract/store";
import { createChunkStore } from "./extract/chunkStore";
import { setWasmBytesProvider } from "./platform/sqliteStore";

beforeAll(() => {
  const bytes = readFileSync(join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"));
  setWasmBytesProvider(async () => new Uint8Array(bytes));
});

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): { values: unknown[][] }[];
  prepare(sql: string): {
    bind(p?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
}

async function stores() {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as unknown as SqlJsDatabase;
  const runner: SqlRunner = {
    run: (sql, params = []) => db.run(sql, [...params]),
    query: <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind([...params]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
  };
  const text = createAttachmentTextStore(runner);
  (await text.ensureSchema(DERIVED_SCHEMA_DDL));
  const chunks = createChunkStore(runner);
  (await chunks.ensureSchema(DERIVED_SCHEMA_DDL));
  return { text, chunks };
}

const att = (id: string, name = `${id}.docx`) => ({ id, name, mime: "", hash: "h", size: 1, path: "" });

describe("scanLibraryCoverage（取材层）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("**`null` 那一路要单独取**：只调它会漏掉归属页面的附件（大多数）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (pageId: string | null) =>
        pageId === "p1" ? [att("a1")] : pageId === "p2" ? [att("a2")] : [att("loose")],
    );

    const s = await stores();
    const r = await scanLibraryCoverage(s);

    // 三个附件都进了报告：p1 的、p2 的、未整理的
    expect(r.attachments.total).toBe(3);
    // ⚠️ `gaps` 里**同时有页面缺口**（p1/p2 没有块本来就是缺口）⇒ 断言前先按 kind 过滤，
    //    否则这条测试会因为"页面也在 gaps 里"而红 —— 那是**测试写松了**，不是实现错。
    expect(r.gaps.filter((g) => g.kind === "attachment").map((g) => g.id).sort())
      .toEqual(["a1", "a2", "loose"]);
    expect(r.gaps.filter((g) => g.kind === "page").map((g) => g.id).sort()).toEqual(["p1", "p2"]);
    // 取材调用：2 页各一次 + 未整理一次
    expect((api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]))
      .toEqual(["p1", "p2", null]);
  });

  it("**按 id 去重**：同一附件被两处返回时 total 不能虚高", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (pageId: string | null) => (pageId === "p1" ? [att("dup")] : [att("dup")]),
    );

    const s = await stores();
    const r = await scanLibraryCoverage(s);
    expect(r.attachments.total).toBe(1); // 而不是 2
  });

  it("页面清单进了报告的 `pages`（含页数为 0 的库）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const s = await stores();
    const r = await scanLibraryCoverage(s);
    expect(r.pages.total).toBe(0);
    expect(r.gaps).toEqual([]);
  });

  it("已有的派生数据会被如实计入（取材 + 计算确实接上了）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([att("a1")]);

    const s = await stores();
    s.text.replace("a1", "ooxml.docx@1", "h", [{ kind: "text", text: "已抽", loc: "" }], 1);
    const r = await scanLibraryCoverage(s);

    expect(r.attachments).toMatchObject({ total: 1, extracted: 1, indexed: 0, notIndexed: 1 });
    // 同样是按 kind 找（页面缺口排在前面）
    expect(r.gaps.find((g) => g.kind === "attachment")?.reason).toBe("not_chunked"); // 抽了但没切块
    expect(r.derived).toMatchObject({ segments: 1, chars: 2 });
  });
});
