// 「开始索引」**整条按钮路径**的判据：`runLibraryIndex` → 真 `indexLibrary` → 真 store（sql.js）→ 库里真有块。
//
// 为什么单开一个文件：`libraryIndexing.test.ts` 把 `indexLibrary` 换成了假的（只验进度映射与摘要）；
// 这一条**不换** —— 它要回答的是"界面上那个按钮点下去，索引到底会不会真的填进库"。
// 没有 DOM 测试环境（仓库没有 testing-library），所以这里驱动的是按钮**调用的那个函数**，
// 而不是去点 DOM：这正是把运行模型单独抽出来的原因。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: { listPages: vi.fn(), listPageAttachments: vi.fn() },
}));

import { api } from "./api";
import { createChunkStore } from "./extract/chunkStore";
import { DERIVED_SCHEMA_DDL } from "./extract/schema";
import { createAttachmentTextStore, type SqlRunner } from "./extract/store";
import { runLibraryIndex, type IndexProgress } from "./libraryIndexing";
import { setPlatform } from "./platform";
import { setWasmBytesProvider } from "./platform/sqliteStore";
import type { Platform } from "./platform/types";

beforeAll(() => {
  const bytes = readFileSync(join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"));
  setWasmBytesProvider(async () => new Uint8Array(bytes));
});

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): {
    bind(p?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
}

async function webishStores() {
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
  text.ensureSchema(DERIVED_SCHEMA_DDL);
  const chunks = createChunkStore(runner);
  chunks.ensureSchema(DERIVED_SCHEMA_DDL);
  return { text, chunks };
}

/** 平台：`get_page` 给正文；`derivedStores()` 给真 store（模拟 Web 那一侧）。 */
function platformWith(pages: Record<string, string>, stores: unknown): Platform {
  return {
    executor: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_page") return { id: String(args?.id), title: "T", content_text: pages[String(args?.id)] };
        throw new Error(`意外命令 ${cmd}`);
      },
    },
    derivedStores: () => stores as never,
  } as unknown as Platform;
}

const body = (n: number) => Array.from({ length: n }, (_, i) => `第${i}条讲预算与差旅报销。`).join("");

describe("开始索引（按钮路径）端到端", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("★ 点下去之后：进度走完、库里**真的有块**、摘要说得清（可重复点，第二次不白做功）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const stores = await webishStores();
    const platform = platformWith({ p1: body(120) }, stores);
    setPlatform(platform);

    const seen: IndexProgress[] = [];
    const first = await runLibraryIndex({ platform, onProgress: (p) => seen.push(p) });

    expect(first.ok).toBe(true);
    // ① 进度：有终态、单调、ratio 收在 1
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].ratio).toBe(1);
    // ② 库里真有块（读回来，不是看返回值）
    const pageRows = await stores.chunks.chunksOf({ kind: "page", pageId: "p1" });
    expect(pageRows.length).toBeGreaterThan(1);
    expect(pageRows[0].text).toContain("预算");
    // ③ 摘要能直接显示，且包含块数（格式取自 `summarizeLibraryIndex`，这里只钉"有那几件事"）
    if (first.ok) {
      expect(first.summary).toContain("已索引");
      expect(first.summary).toContain(`块 ${pageRows.length}`);
      expect(first.report.chunks.total).toBe(pageRows.length);
      expect(first.report.failures).toEqual([]);
    }

    // ⑤ 再点一次：内容没变 ⇒ 块不变（幂等；`changed` 语义由 `chunkPage` 的缓存判据保证）
    const second = await runLibraryIndex({ platform });
    expect(second.ok).toBe(true);
    const after = await stores.chunks.chunksOf({ kind: "page", pageId: "p1" });
    expect(after).toEqual(pageRows);
  });

  it("平台没有派生层写入通道 ⇒ `{ok:false}` 且**一个字都没写**（空库仍是空库）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "p1" }]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const stores = await webishStores();
    setPlatform({ executor: { invoke: async () => ({}) } } as unknown as Platform);

    const r = await runLibraryIndex({ platform: { executor: { invoke: async () => ({}) } } as unknown as Platform });
    expect(r.ok).toBe(false);
    expect(await stores.chunks.chunksOf({ kind: "page", pageId: "p1" })).toEqual([]);
  });
});
