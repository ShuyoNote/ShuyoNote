// 平台侧收口的判据 —— `attachmentDeps`（唯一构造点）与 `extractAttachment`（唯一入口）。
//
// 这里必须用**假平台 + 真派生库**：
//  - 假平台：证明"`deps` 是从平台驱动装出来的"（而不是抽取层自己想办法）；
//  - 真 sqlite：证明"确实落库了"（假 store 会造出假结论 —— 今天已经在真样张跑器上踩过一次，
//    那次假 store 没实现 SELECT，每份样张都报"0 段"，我差点据此向 Mac 侧报假 bug）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DERIVED_SCHEMA_DDL } from "../extract/schema";
import { createAttachmentTextStore, type SqlRunner } from "../extract/store";
import { setWasmBytesProvider } from "./sqliteStore";
import type { Platform } from "./types";
import { platform, setPlatform } from "./index";
import { attachmentDeps, extractAttachment } from "./extractDeps";

// ---------------------------------------------------------------- 基础设施

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  const bytes = readFileSync(wasm);
  // 与 platformWiring.test.ts 同一注入方式（不引 bundler）
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

async function realStore() {
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
  const store = createAttachmentTextStore(runner);
  store.ensureSchema(DERIVED_SCHEMA_DDL);
  return store;
}

/** 造一份最小合法 docx（不引二进制样张）。 */
function tinyDocx(text: string): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zipSync({
    "word/document.xml": strToU8(
      `<w:document ${W}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

function fakePlatform(over: Partial<Platform> = {}): Platform {
  const notProvided = () => {
    throw new Error("本用例未提供这个驱动");
  };
  const base = {
    executor: { invoke: notProvided },
    pdfRender: {
      renderPdfPage: notProvided,
      nativeAvailable: () => false,
    },
  } as unknown as Platform;
  return { ...base, ...over } as Platform;
}

afterEach(() => {
  setPlatform(fakePlatform()); // 复位，别把假平台泄漏给同进程的其他文件
});

// ---------------------------------------------------------------- 构造点

describe("attachmentDeps —— deps 的唯一构造点", () => {
  it("`rasterize` 由**平台驱动**装上，并把 `bytes` 映射成契约里的 `rgba`、页号与缩放原样透传", async () => {
    const calls: { attId: string; page: number; scale: number }[] = [];
    setPlatform(
      fakePlatform({
        pdfRender: {
          nativeAvailable: () => true,
          renderPdfPage: async (attId, pageIndex, scale) => {
            calls.push({ attId, page: pageIndex, scale });
            return { bytes: new Uint8Array([7, 7, 7, 255]), width: 1, height: 1 };
          },
        } as Platform["pdfRender"],
      }),
    );

    const deps = attachmentDeps("att-9");
    const page = await deps.rasterize!(new Uint8Array([1, 2, 3]), 4, 3);

    expect(calls).toEqual([{ attId: "att-9", page: 4, scale: 3 }]); // 页号/缩放**原样**透传
    expect(page).toEqual({ rgba: new Uint8Array([7, 7, 7, 255]), width: 1, height: 1 }); // bytes → rgba
  });

  it("**不给 `vision` 时不编假实现**：gpu 抽取器据此走 provider_error（契约 §15.3-7）", () => {
    setPlatform(fakePlatform());
    const deps = attachmentDeps("att-1");
    expect("vision" in deps).toBe(false); // 不是 undefined 赋值，而是**根本没有这个键**
    expect(typeof deps.rasterize).toBe("function");
  });

  it("给了 `vision` 就透传（平台还没有模型驱动层，见 §13 第 7 项）", async () => {
    setPlatform(fakePlatform());
    const vision = async () => "识别结果";
    const deps = attachmentDeps("att-1", { vision });
    expect(deps.vision).toBe(vision);
    await expect(deps.vision!("p", new Uint8Array(), "image/png")).resolves.toBe("识别结果");
  });

  it("平台渲染失败时**原样抛出**（不许在这里吞掉变成一句「没文字」）", async () => {
    setPlatform(
      fakePlatform({
        pdfRender: {
          nativeAvailable: () => true,
          renderPdfPage: async () => {
            throw new Error("原生渲染器炸了");
          },
        } as Platform["pdfRender"],
      }),
    );
    await expect(attachmentDeps("a").rasterize!(new Uint8Array(), 0, 2)).rejects.toThrow(
      "原生渲染器炸了",
    );
  });
});

// ---------------------------------------------------------------- 唯一入口

describe("extractAttachment —— 抽取的唯一入口（假平台 + 真 sqlite）", () => {
  it("按 id 取 meta 与字节 → 抽取 → **真的落库**，且 filename/mime/hash 取自 meta 而不是自己编", async () => {
    const seen: string[] = [];
    setPlatform(
      fakePlatform({
        executor: {
          invoke: (async (cmd: string, args?: Record<string, unknown>) => {
            seen.push(cmd);
            if (cmd === "get_attachment") {
              expect(args).toEqual({ id: "att-1" });
              return { id: "att-1", name: "报告.docx", hash: "HASH-A", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1, path: "" };
            }
            if (cmd === "read_attachment_bytes") {
              expect(args).toEqual({ hash: "HASH-A" }); // 用 meta 里的 hash 取字节
              return tinyDocx("季度总结").buffer;
            }
            throw new Error(`意外命令 ${cmd}`);
          }) as Platform["executor"]["invoke"],
        },
      }),
    );

    const store = await realStore();
    const { meta, outcome } = await extractAttachment("att-1", store);

    expect(seen).toEqual(["get_attachment", "read_attachment_bytes"]);
    expect(meta.name).toBe("报告.docx");
    expect(outcome).toMatchObject({ status: "stored", extractor: "ooxml.docx@1" });
    const rows = store.segmentsOf("att-1");
    expect(rows.map((r) => r.text)).toEqual(["季度总结"]);
    // hash 取自 meta ⇒ 内容没变时第二次是 cached（缓存失效口径真的接上了）
    const second = await extractAttachment("att-1", store);
    expect(second.outcome.status).toBe("cached");
  });

  it("附件内容变了（hash 变）⇒ **重抽而不是吃旧缓存**", async () => {
    let hash = "H1";
    setPlatform(
      fakePlatform({
        executor: {
          invoke: (async (cmd: string) => {
            if (cmd === "get_attachment") {
              return { id: "a", name: "x.docx", hash, mime: "", size: 1, path: "" };
            }
            return tinyDocx(hash === "H1" ? "第一版" : "第二版").buffer;
          }) as Platform["executor"]["invoke"],
        },
      }),
    );

    const store = await realStore();
    await extractAttachment("a", store);
    expect(store.segmentsOf("a").map((r) => r.text)).toEqual(["第一版"]);

    hash = "H2";
    const again = await extractAttachment("a", store);
    expect(again.outcome.status).toBe("stored"); // 不是 cached
    expect(store.segmentsOf("a").map((r) => r.text)).toEqual(["第二版"]);
  });

  it("平台读不到附件时**抛出**（这是调用方的错，不该被伪装成抽取失败）", async () => {
    setPlatform(
      fakePlatform({
        executor: {
          invoke: (async () => {
            throw new Error("附件不存在");
          }) as Platform["executor"]["invoke"],
        },
      }),
    );
    const store = await realStore();
    await expect(extractAttachment("nope", store)).rejects.toThrow("附件不存在");
  });
});

// 一条"这个文件的断言确实在跑"的自证（避免全部用例因筛条件写错而静默跳过）
describe("自证", () => {
  it("平台门面确实是可替换的（否则上面那些用例测的是真平台）", () => {
    const marker = fakePlatform();
    setPlatform(marker);
    expect(platform.executor).toBe(marker.executor);
  });
});
