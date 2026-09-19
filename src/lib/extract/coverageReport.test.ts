// 覆盖报告的判据 —— 用**真 sqlite**（假 store 会造出假结论，今天已踩过一次）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";

import { chunkSegments, chunkText } from "./chunk";
import { createChunkStore } from "./chunkStore";
import { indexCoverage, summarizeCoverage } from "./coverageReport";
import { DERIVED_SCHEMA_DDL } from "./schema";
import { createAttachmentTextStore, type SqlRunner } from "./store";
import { setWasmBytesProvider } from "../platform/sqliteStore";
import { ok, type Extractor } from "./types";

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

/** 认领 `.known` 与 `.docx` 的假抽取器（用来验分类：没人认领 vs 认领了但抽出来是空）。 */
const claimsKnownAndDocx: Extractor = {
  id: "fake.known@1",
  mimes: [],
  extensions: [".known", ".docx"],
  cost: "cpu",
  extract: async () => ok("fake.known@1", [{ kind: "text", text: "x", loc: "" }]),
};

describe("索引覆盖报告", () => {
  it("空库：什么都没有，但报告本身可用（不是抛异常）", async () => {
    const s = await stores();
    const r = (await indexCoverage({ pageIds: [], attachments: [] }, s));
    expect(r).toMatchObject({
      pages: { total: 0, indexed: 0, empty: 0 },
      attachments: { total: 0, indexed: 0, notIndexed: 0 },
      chunks: { total: 0 },
    });
    expect(r.gaps).toEqual([]);
  });

  it("**页面空 ≠ 内容没被索引**：reason 文案必须点明「由附件侧负责」（防看报告的人去修错东西）", async () => {
    const s = await stores();
    const r = (await indexCoverage({ pageIds: ["p1"], attachments: [] }, s));
    expect(r.pages).toMatchObject({ total: 1, indexed: 0, empty: 1 });
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ kind: "page", id: "p1", reason: "page_empty" });
    expect(r.gaps[0].detail).toContain("附件侧");
    expect(r.gaps[0].detail).toContain("不一定是缺口");
  });

  it("有块的页面算已索引，且**不进 gaps**", async () => {
    const s = await stores();
    s.chunks.replace({ kind: "page", pageId: "p1" }, chunkText({ kind: "page", pageId: "p1" }, "正文。"));
    const r = (await indexCoverage({ pageIds: ["p1", "p2"], attachments: [] }, s));
    expect(r.pages).toMatchObject({ total: 2, indexed: 1, empty: 1 });
    expect(r.gaps.map((g) => g.id)).toEqual(["p2"]); // 只有 p2 是缺口
  });

  it("附件三分类：**已索引 / 没人认领 / 抽出来是空** 各归各的", async () => {
    const s = await stores();
    // ① 已索引
    s.text.replace("att-ok", "ooxml.docx@1", "h1", [{ kind: "text", text: "内容", loc: "" }], 1);
    s.chunks.replace(
      { kind: "attachment", attId: "att-ok" },
      chunkSegments({ kind: "attachment", attId: "att-ok" }, [{ text: "内容", loc: "" }]),
    );
    // ② 没人认领（扩展名不在任何抽取器的清单里）
    // ③ 认领了但抽出来是空（库里没有任何行）

    const r = (await indexCoverage(
      {
        pageIds: [],
        attachments: [
          { id: "att-ok", mime: "", filename: "a.docx" },
          { id: "att-none", mime: "application/x-weird", filename: "b.weird" },
          { id: "att-empty", mime: "", filename: "c.docx" },
        ],
      },
      s,
      { registry: [claimsKnownAndDocx] },
    ));

    expect(r.attachments).toMatchObject({ total: 3, extracted: 1, indexed: 1, notIndexed: 2 });
    expect(r.attachments.byReason).toEqual({ no_extractor: 1, no_content: 1 });
    expect(r.gaps.find((g) => g.id === "att-none")?.reason).toBe("no_extractor");
    expect(r.gaps.find((g) => g.id === "att-empty")?.reason).toBe("no_content");
    // 两类文案要给出**不同的下一步**
    expect(r.gaps.find((g) => g.id === "att-none")?.detail).toContain("补一个抽取器");
    expect(r.gaps.find((g) => g.id === "att-empty")?.detail).toContain("加密");
  });

  it("**拿不到 mime/filename 时不瞎猜成 `no_extractor`**（那会把「可能是空文件」说成「格式不支持」）", async () => {
    const s = await stores();
    const r = (await indexCoverage({ pageIds: [], attachments: [{ id: "a" }] }, s, { registry: [] }));
    expect(r.gaps[0].reason).toBe("no_content"); // 而不是 no_extractor
  });

  it("**抽到了文本但没有块 ⇒ `not_chunked`**（「两条链没一起接线」，与「抽不出来」是两回事）", async () => {
    const s = await stores();
    // 只有 attachment_text，没有 chunks —— 正是"抽取跑了、分块没跑"的状态
    s.text.replace("a1", "ooxml.docx@1", "h", [{ kind: "text", text: "有文本", loc: "" }], 1);

    const r = (await indexCoverage({ pageIds: [], attachments: [{ id: "a1", mime: "", filename: "x.docx" }] }, s));
    expect(r.attachments).toMatchObject({ total: 1, extracted: 1, indexed: 0, notIndexed: 1 });
    expect(r.gaps[0].reason).toBe("not_chunked");
    // 文案要指出"不是抽取器的问题"，否则会被当成抽取 bug 去查
    expect(r.gaps[0].detail).toContain("不是抽取器的问题");
    // 摘要里也要能看出来（否则只看摘要的人会以为"未索引"就是没抽出来）
    expect(summarizeCoverage(r)).toContain("抽到了文本但未切块");
  });

  it("总量来自派生层（段数/字数/块数），一次统计而不是逐条累加", async () => {
    const s = await stores();
    s.text.replace("a1", "ooxml.docx@1", "h", [{ kind: "text", text: "甲乙丙", loc: "" }], 1);
    s.text.replace("a2", "text.plain@1", "h", [{ kind: "text", text: "丁戊", loc: "" }], 1);
    s.chunks.replace({ kind: "attachment", attId: "a1" }, chunkSegments({ kind: "attachment", attId: "a1" }, [{ text: "甲乙丙", loc: "" }]));

    const r = (await indexCoverage({ pageIds: [], attachments: [{ id: "a1" }, { id: "a2" }] }, s));
    expect(r.derived).toMatchObject({ extractors: 2, segments: 2, chars: 5 });
    expect(r.chunks.total).toBe(1);
  });

  it("摘要是**一行**、且把三类数在一句里说清（UI/日志直接可用）", async () => {
    const s = await stores();
    const r = (await indexCoverage(
      { pageIds: ["p1"], attachments: [{ id: "a1", mime: "", filename: "x.docx" }] },
      s,
      { registry: [] },
    ));
    const line = summarizeCoverage(r);
    expect(line).toContain("页面 0/1 有块");
    expect(line).toContain("附件 0/1 已索引");
    expect(line).toContain("未索引 1");
    expect(line.split("\n")).toHaveLength(1); // 一行
  });

  it("**只读**：调用报告不写库（不触发抽取、不改行）", async () => {
    const s = await stores();
    s.text.replace("a1", "ooxml.docx@1", "h", [{ kind: "text", text: "原文", loc: "" }], 1);
    const before = (await s.text.segmentsOf("a1")).map((r) => r.text);
    (await indexCoverage({ pageIds: ["p1"], attachments: [{ id: "a1", mime: "", filename: "x.docx" }] }, s));
    expect((await s.text.segmentsOf("a1")).map((r) => r.text)).toEqual(before);
    expect((await s.chunks.stats()).chunks).toBe(0);
  });
});
