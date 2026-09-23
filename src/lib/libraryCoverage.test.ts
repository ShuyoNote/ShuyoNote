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
import { coverageReportTool, scanLibraryCoverage } from "./libraryCoverage";
import { FRONTEND_ADAPTERS } from "./capabilities/frontend";
import { summarizeCoverage } from "./extract/coverageReport";
import { chunkSegments } from "./extract/chunk";
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

// ---------------------------------------------------------------------------
// `coverage.report`（能力面/AI 工具）的返回形状 —— 2026-09-23
//
// 这一组钉的是"**AI 读到的东西**"，与"界面上那一行"不同：模型要计数 + 分类 + 明细。
// 三条失败面全是安静的：① 只给"已索引 N/N" ⇒ 模型答"内容全在检索面里"（§15.10 那条老坑）；
// ② 明细被截断却不说 ⇒ 模型把"前 20 条"当成全部；③ 报告本身在，但工具形状与报告口径各写一遍 ⇒ 漂移。
// ---------------------------------------------------------------------------
describe("coverageReportTool（能力面形状）", () => {
  /** 造一份报告：`indexed` 份已索引（完整读数）、其中 `partial` 份带缺口读数、`missing` 份没抽到。 */
  async function reportWith(indexed: number, partial: number, missing: number) {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const list = [
      ...[...Array(indexed).keys()].map((i) => att(`ok${i}.docx`)),
      ...[...Array(partial).keys()].map((i) => att(`part${i}.pdf`)),
      ...[...Array(missing).keys()].map((i) => att(`miss${i}.docx`)),
    ];
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(list);

    const s = await stores();
    for (let i = 0; i < indexed; i++) {
      s.text.replace(`ok${i}.docx`, "ooxml.docx@1", "h", [{ kind: "text", text: "正文", loc: "" }], 1, {
        complete: true,
      });
      s.chunks.replace({ kind: "attachment", attId: `ok${i}.docx` }, chunkSegments({ kind: "attachment", attId: `ok${i}.docx` }, [{ text: "正文", loc: "" }]));
    }
    for (let i = 0; i < partial; i++) {
      s.text.replace(`part${i}.pdf`, "pdf.text@1", "h", [{ kind: "text", text: "只抽到正文页", loc: "p.1" }], 1, {
        complete: false,
        gapIndexes: [1, 2],
        note: "2 页没有文本层",
      });
      // 用自己拼的段切块（`chunkSegments` 的签名与上面一致）
      s.chunks.replace({ kind: "attachment", attId: `part${i}.pdf` }, chunkSegments({ kind: "attachment", attId: `part${i}.pdf` }, [{ text: "只抽到正文页", loc: "p.1" }]));
    }
    // `missing` 份什么都不写 ⇒ `no_content`（认领了但抽出来是空）
    return scanLibraryCoverage(s);
  }

  beforeEach(() => vi.clearAllMocks());

  it("★ 摘要里必须出现「没抽全」，且 `partial` 与 `indexed` 并列给出", async () => {
    const report = await reportWith(1, 1, 0);
    const tool = coverageReportTool(report);

    expect(tool.ok).toBe(true);
    expect(tool.report.attachments).toMatchObject({ total: 2, indexed: 2, partial: 1 });
    expect(tool.summary).toContain("已索引");
    expect(tool.summary).toContain("没抽全"); // 只看这一行的人不会把"已索引 2/2"读成"内容全在"
    // 明细里那条缺口要带 reason 与"该怎么办"
    const gap = tool.report.gaps.find((g) => g.id === "part0.pdf")!;
    expect(gap.reason).toBe("partial");
    expect(gap.detail).toContain("只是一部分");
  });

  it("未索引的那些仍按原来的分类给（`no_content`），不与 `partial` 混", async () => {
    const report = await reportWith(0, 0, 1);
    const tool = coverageReportTool(report);
    expect(tool.report.attachments).toMatchObject({ total: 1, indexed: 0, partial: 0, notIndexed: 1 });
    expect(tool.report.attachments.byReason).toEqual({ no_content: 1 });
    expect(tool.report.gaps.map((g) => g.reason)).toEqual(["no_content"]);
  });

  it("★ 明细被截断时必须**说出来**（`gapsTotal`/`gapsTruncated`/`note` 三件套）", async () => {
    const report = await reportWith(0, 0, 3);
    const tool = coverageReportTool(report, 2); // 故意把上限压到 2

    expect(tool.report.gaps).toHaveLength(2);
    expect(tool.report.gapsTotal).toBe(3);
    expect(tool.report.gapsTruncated).toBe(true);
    expect(tool.report.note).toContain("共 3 条");
    // 反例（否则"永远报截断"也能让上面过）
    const full = coverageReportTool(report, 10);
    expect(full.report.gapsTruncated).toBe(false);
    expect(full.report.note).toBe("");
  });

  it("能力面形状与报告口径**同一处**：summary 就是 `summarizeCoverage(report)`", async () => {
    const report = await reportWith(1, 1, 1);
    expect(coverageReportTool(report).summary).toBe(summarizeCoverage(report));
  });

  it("★ 能力面适配器用的就是**同一份**报告（注入 provider ⇒ 与纯函数逐字相同）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([att("a1")]);
    const s = await stores();
    s.text.replace("a1", "pdf.text@1", "h", [{ kind: "text", text: "只抽到正文页", loc: "p.1" }], 1, {
      complete: false,
      gapIndexes: [1],
    });
    s.chunks.replace(
      { kind: "attachment", attId: "a1" },
      chunkSegments({ kind: "attachment", attId: "a1" }, [{ text: "只抽到正文页", loc: "p.1" }]),
    );

    const viaTool = await FRONTEND_ADAPTERS["coverage.report"]({}, { derivedStores: async () => s });
    const direct = coverageReportTool(await scanLibraryCoverage(s));
    // ⚠️ 这条是"**不许两份实现**"的判据：适配器若自己再算一遍，这里迟早会漂
    expect(viaTool).toEqual(direct);
    expect((viaTool as { report: { attachments: { partial: number } } }).report.attachments.partial).toBe(1);
  });

  it("★ 没注入 provider ⇒ **如实报错**（不许假装成一份空报告）", async () => {
    const r = (await FRONTEND_ADAPTERS["coverage.report"]({}, {})) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("覆盖报告");
    // 反例：provider 在、但平台没有这对 store ⇒ 同样如实报错（不是空报告）
    const r2 = (await FRONTEND_ADAPTERS["coverage.report"]({}, { derivedStores: async () => undefined })) as {
      ok: boolean;
    };
    expect(r2.ok).toBe(false);
  });
});
