// P4 的**端到端真跑**读数：真 SQLite（sql.js）+ 真派生 store + 真取材 + 真模型。
//
// ## 为什么还要这一条（`librarySummaryRun.test.ts` 已经 17 例全绿了）
// 那个文件里 `chunksOf` 是我手写的假 store —— 它只能证明"我按我想的读法读对了"，
// **证明不了真 SQL 里那几列读出来是这样**。这条把假 store 换成真表：
//   `createChunkStore(真 sql.js) → ensureIndex → collectSummarySources → 真模型`
// ⇒ "取材"这条链上"跑起来才知道"的部分（列名、排序、loc 的字面值、回链页码）都进了判据。
//
// 分两半：
//   ① **不需要模型**就能跑（真 SQL 那半）—— 环境里没模型时它照样是硬判据；
//   ② 需要本机模型那半 **跳过**（与 `image.localVlm.test.ts` 同一条纪律），
//      没服务不是回归。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    listPages: vi.fn(),
    getPage: vi.fn(),
    listPageAttachments: vi.fn(),
  },
}));

import { api } from "../api";
import { createAttachmentTextStore } from "../extract/store";
import { createChunkStore } from "../extract/chunkStore";
import { DERIVED_SCHEMA_DDL } from "../extract/schema";
import { SqliteStore, setWasmBytesProvider } from "../platform/sqliteStore";
import type { Chunk } from "../extract/chunk";
import type { Platform } from "../platform/types";
import { createOpenAICompatTransport } from "./llm";
import { extractRefs, summarizerFromTransport } from "./librarySummary";
import { collectSummarySources, runLibrarySummary } from "./librarySummaryRun";

const BASE = process.env.HERDSMAN_BASE ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.HERDSMAN_MODEL ?? "Qwen3.8-Flash-Next";

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  setWasmBytesProvider(async () => new Uint8Array(readFileSync(wasm)));
});

async function serviceUp(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${BASE}/models`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** 真库 + 真 store；把"库里有什么"灌进去（页面块 / PDF 逐页块 / docx 块 / 未整理附件块）。 */
async function seeded() {
  const db = new SqliteStore({ load: async () => null, save: async () => {} });
  await db.init();
  const text = createAttachmentTextStore(db);
  const chunks = createChunkStore(db);
  await text.ensureSchema(DERIVED_SCHEMA_DDL);
  await chunks.ensureSchema(DERIVED_SCHEMA_DDL);

  const mk = (o: Partial<Chunk> & { text: string; loc: string }): Chunk => ({
    id: o.id ?? `c${Math.random().toString(36).slice(2, 8)}`,
    pageId: o.pageId ?? null,
    attId: o.attId ?? null,
    ord: o.ord ?? 0,
    loc: o.loc,
    lang: "zh",
    text: o.text,
    hash: "h",
  });
  await chunks.replace({ kind: "page", pageId: "p1" }, [
    mk({ pageId: "p1", ord: 0, loc: "", text: "本季度营收 1200 万，主要来自企业版。" }),
  ]);
  await chunks.replace({ kind: "attachment", attId: "a1" }, [
    mk({ attId: "a1", ord: 0, loc: "p.1", text: "年报第 1 页：公司概况。" }),
    mk({ attId: "a1", ord: 1, loc: "p.3", text: "年报第 3 页：研发投入 300 万，占营收 25%。" }),
  ]);
  await chunks.replace({ kind: "attachment", attId: "a2" }, [
    mk({ attId: "a2", ord: 0, loc: "S1!A1", text: "差旅预算 8 万。" }),
  ]);
  await chunks.replace({ kind: "attachment", attId: "a3" }, [
    mk({ attId: "a3", ord: 0, loc: "", text: "未整理附件里的技术路线摘要。" }),
  ]);

  vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "季度总结" }] as never);
  vi.mocked(api.listPageAttachments).mockImplementation((async (pageId: string | null) =>
    pageId === "p1"
      ? [
          { id: "a1", name: "年报.pdf", mime: "application/pdf", size: 1, hash: "h", path: "" },
          { id: "a2", name: "预算.xlsx", mime: "application/vnd.ms-excel", size: 1, hash: "h", path: "" },
        ]
      : [{ id: "a3", name: "路线.txt", mime: "text/plain", size: 1, hash: "h", path: "" }]) as never);

  const platform = {
    derivedStores: async () => ({ text, chunks }),
  } as unknown as Platform;
  return { db, platform };
}

describe("跨库总结·真 SQL 端到端（不需要模型）", () => {
  it("★ 真表读出来：页面 [[标题]] / PDF 逐页 pdf://att#0基页 / 非 PDF att://id / 未整理也算", async () => {
    const { platform } = await seeded();
    const r = await collectSummarySources({ platform });
    expect(r.sources.map((s) => s.ref)).toEqual([
      "[[季度总结]]",
      "pdf://a1#0", // p.1 → 0 基 0
      "pdf://a1#2", // p.3 → 0 基 2
      "att://a2",
      "att://a3", // 未整理附件（includeUnfiled 默认 true）
    ]);
    expect(r).toMatchObject({ pages: 1, attachments: 3, skipped: [] });
    expect(r.chars).toBeGreaterThan(0);
    // 每个发出去的回链都得被自己的口径认出来（否则模型抄了也会被判没出处）
    for (const s of r.sources) expect(extractRefs(s.ref)).toContain(s.ref);
  });

  it("库里什么都没索引 ⇒ 来源为空、逐条如实报（这是「先点开始索引」那句话的来源）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "空页" }] as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([] as never);
    const db = new SqliteStore({ load: async () => null, save: async () => {} });
    await db.init();
    const chunks = createChunkStore(db);
    await chunks.ensureSchema(DERIVED_SCHEMA_DDL);
    const r = await collectSummarySources({ platform: { derivedStores: async () => ({ text: createAttachmentTextStore(db), chunks }) } as unknown as Platform });
    expect(r.sources).toEqual([]);
    expect(r.skipped).toEqual([{ ref: "[[空页]]", reason: "还没有可检索文本（先点「开始索引」）" }]);
  });
});

const up = await serviceUp();
const skipReason = up ? "" : `本机模型服务不可达（${BASE}）—— 这是环境，不是回归`;

describe.skipIf(skipReason !== "")(`跨库总结·真 SQL + 真模型（${skipReason || BASE}）`, () => {
  it("★ 真跑：从真库取材 → 真模型分批总结 → 每条结论都带回链（且回链全来自输入）", async () => {
    const { platform } = await seeded();
    const transport = createOpenAICompatTransport(BASE, MODEL);
    const r = await runLibrarySummary({
      platform,
      summarize: summarizerFromTransport(transport, 1024),
      question: "本季度营收与研发投入分别是多少？",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    console.log(`[live e2e] ${r.note}`);
    console.log(`[live e2e]\n${r.summary.markdown}`);

    const allowed = new Set(r.collected.sources.map((s) => s.ref));
    for (const ref of extractRefs(r.summary.markdown)) {
      expect(allowed.has(ref), `输出里出现了取材没有的回链：${ref}`).toBe(true);
    }
    expect(r.summary.markdown.trim().length).toBeGreaterThan(0);
  }, 300_000);
});
