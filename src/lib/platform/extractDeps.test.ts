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
import { isPng } from "../pngEncode";
import { createChunkStore } from "../extract/chunkStore";
import { createAttachmentTextStore, type SqlRunner } from "../extract/store";
import { setWasmBytesProvider } from "./sqliteStore";
import type { Platform } from "./types";
import { platform, setPlatform } from "./index";
import { attachmentDeps, extractAttachment } from "./extractDeps";
import { legacyExtractor } from "../extract/legacy";

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
  const text = createAttachmentTextStore(runner);
  (await text.ensureSchema(DERIVED_SCHEMA_DDL));
  const chunks = createChunkStore(runner);
  (await chunks.ensureSchema(DERIVED_SCHEMA_DDL));
  return { text, chunks };
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
  it("`rasterize` 由**平台驱动**装上：把驱动给的**裸 RGBA 编码成图**，页号与缩放原样透传", async () => {
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
    // 契约要求 `rasterize` 产出**编码图**（`vision` 只接受编码图）⇒ 适配器负责编码
    expect(page.mime).toBe("image/png");
    expect(isPng(page.bytes)).toBe(true);
    expect([page.width, page.height]).toEqual([1, 1]);
  });

  it("**不给 `vision` 时不编假实现**：gpu 抽取器据此走 provider_error（契约 §15.3-7）", async () => {
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

  it("★ 给了 `transcribe` 就透传；**不给也照样没有这个键**（⇒ 音频抽取走 provider_error）", async () => {
    setPlatform(fakePlatform());
    const transcribe = async () => ({ text: "今天天气不错" });
    const withIt = attachmentDeps("att-1", { transcribe });
    expect(withIt.transcribe).toBe(transcribe);
    await expect(withIt.transcribe!(new Uint8Array([1]), "audio/wav", {})).resolves.toEqual({
      text: "今天天气不错",
    });
    // 两条通道**各自独立**：只给 vision 不许把 transcribe 也变出来（那是编假实现）
    const onlyVision = attachmentDeps("att-1", { vision: async () => "x" });
    expect("transcribe" in onlyVision).toBe(false);
    expect("vision" in attachmentDeps("att-1")).toBe(false);
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

    const stores = await realStore();
    const { meta, outcome } = await extractAttachment("att-1", stores);

    expect(seen).toEqual(["get_attachment", "read_attachment_bytes"]);
    expect(meta.name).toBe("报告.docx");
    expect(outcome).toMatchObject({ status: "stored", extractor: "ooxml.docx@1" });
    const rows = (await stores.text.segmentsOf("att-1"));
    expect(rows.map((r) => r.text)).toEqual(["季度总结"]);
    // hash 取自 meta ⇒ 内容没变时第二次是 cached（缓存失效口径真的接上了）
    const second = await extractAttachment("att-1", stores);
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

    const stores = await realStore();
    await extractAttachment("a", stores);
    expect((await stores.text.segmentsOf("a")).map((r) => r.text)).toEqual(["第一版"]);

    hash = "H2";
    const again = await extractAttachment("a", stores);
    expect(again.outcome.status).toBe("stored"); // 不是 cached
    expect((await stores.text.segmentsOf("a")).map((r) => r.text)).toEqual(["第二版"]);
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
    const stores = await realStore();
    await expect(extractAttachment("nope", stores)).rejects.toThrow("附件不存在");
  });
});

// 一条"这个文件的断言确实在跑"的自证（避免全部用例因筛条件写错而静默跳过）
// ---------------------------------------------------------------- 顺手分块

/** 假平台：附件内容由 `content()` 决定（便于在同一个用例里切换"内容变了/没变"）。 */
function platformWith(content: () => { hash: string; bytes: Uint8Array; name?: string }) {
  return fakePlatform({
    executor: {
      invoke: (async (cmd: string) => {
        const c = content();
        if (cmd === "get_attachment") {
          return { id: "a", name: c.name ?? "长文.docx", hash: c.hash, mime: "", size: 1, path: "" };
        }
        return c.bytes.buffer;
      }) as Platform["executor"]["invoke"],
    },
  });
}

const longText = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${i}条讲了预算与差旅报销的具体规定。`).join("");

describe("extractAttachment 顺手分块（让「文本」与「块」不会漂移）", () => {
  it("抽取即产生块，且切的是**落库后**的文本（归一化之后的那份）", async () => {
    setPlatform(platformWith(() => ({ hash: "H", bytes: tinyDocx(longText(150)) })));
    const stores = await realStore();
    const r = await extractAttachment("a", stores);

    expect(r.outcome.status).toBe("stored");
    expect(r.chunks).toBeGreaterThan(1); // 长文确实被切了
    const owner = { kind: "attachment" as const, attId: "a" };
    expect((await stores.chunks.chunksOf(owner))).toHaveLength(r.chunks);
  });

  it("内容变了 ⇒ 块被**整体替换**，不留孤儿块", async () => {
    let hash = "H1";
    let text = longText(150);
    setPlatform(platformWith(() => ({ hash, bytes: tinyDocx(text) })));
    const stores = await realStore();
    const owner = { kind: "attachment" as const, attId: "a" };

    const before = await extractAttachment("a", stores);
    expect(before.chunks).toBeGreaterThan(1);

    hash = "H2";
    text = "只剩一句话了。";
    const after = await extractAttachment("a", stores);

    expect(after.outcome.status).toBe("stored");
    expect(after.chunks).toBe(1);
    expect((await stores.chunks.chunksOf(owner))).toHaveLength(1); // 旧的多块已被删掉
    expect((await stores.chunks.chunksOf(owner))[0].text).toContain("只剩一句话");
  });

  it("**cached 且已有块 ⇒ 不重切**（每次调用都重切是白做功）", async () => {
    setPlatform(platformWith(() => ({ hash: "H", bytes: tinyDocx(longText(150)) })));
    const stores = await realStore();
    const owner = { kind: "attachment" as const, attId: "a" };

    await extractAttachment("a", stores);
    // 用记数包装观察第二次是否真的没再写
    let replaces = 0;
    const counting = {
      ...stores.chunks,
      replace: (
        o: typeof owner,
        c: Parameters<typeof stores.chunks.replace>[1],
      ) => {
        replaces++;
        stores.chunks.replace(o, c);
      },
    };

    const second = await extractAttachment("a", { text: stores.text, chunks: counting });
    expect(second.outcome.status).toBe("cached");
    expect(replaces).toBe(0);
  });

  it("**cached 但没有块 ⇒ 补切一次**（给「分块能力上线之前就抽好的附件」）", async () => {
    setPlatform(platformWith(() => ({ hash: "H", bytes: tinyDocx(longText(150)) })));
    const stores = await realStore();
    const owner = { kind: "attachment" as const, attId: "a" };

    await extractAttachment("a", stores);
    (await stores.chunks.remove(owner)); // 模拟"文本在库里、块还没生成过"
    expect((await stores.chunks.chunksOf(owner))).toHaveLength(0);

    const again = await extractAttachment("a", stores);
    expect(again.outcome.status).toBe("cached"); // 文本没变，没重抽
    expect(again.chunks).toBeGreaterThan(1); // 但块补上了
    expect((await stores.chunks.chunksOf(owner))).toHaveLength(again.chunks);
  });

  it("抽取失败时**不动已有块**（与「失败不毁旧数据」同一条口径）", async () => {
    setPlatform(platformWith(() => ({ hash: "H", bytes: tinyDocx("正常内容。") })));
    const stores = await realStore();
    const owner = { kind: "attachment" as const, attId: "a" };
    await extractAttachment("a", stores);
    const good = (await stores.chunks.chunksOf(owner)).length;

    // 换成不是 zip 的字节 ⇒ 不会走 stored
    setPlatform(platformWith(() => ({ hash: "H2", bytes: new Uint8Array([1, 2, 3]) })));
    const bad = await extractAttachment("a", stores);
    expect(bad.outcome.status).not.toBe("stored");
    expect((await stores.chunks.chunksOf(owner))).toHaveLength(good); // 旧块还在
  });
});

describe("自证", () => {
  it("平台门面确实是可替换的（否则上面那些用例测的是真平台）", async () => {
    const marker = fakePlatform();
    setPlatform(marker);
    expect(platform.executor).toBe(marker.executor);
  });
});

// ---------------------------------------------------------------- 旧格式转换（2026-09-23）

describe("attachmentDeps：旧二进制 Office 的转换从**平台命令面**装上", () => {
  it("★ `convertLegacy` 在：调用它会发 `convert_legacy_office{data,to}`，并把回来的 number[] 变成字节", async () => {
    const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
    setPlatform(
      fakePlatform({
        executor: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            calls.push({ cmd, args });
            return [0x50, 0x4b, 0x03, 0x04];
          },
        },
      } as unknown as Partial<Platform>),
    );

    const deps = attachmentDeps("att-1");
    expect(typeof deps.convertLegacy).toBe("function");
    const out = await deps.convertLegacy!(new Uint8Array([1, 2, 3]), "application/vnd.ms-excel", {
      to: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("convert_legacy_office");
    // `to` **原样**转发（由抽取器决定）；字节按命令面约定走 number[]
    expect(calls[0].args).toEqual({
      data: [1, 2, 3],
      to: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("★ 平台拒绝（Web stub / 没装 LibreOffice）⇒ 抽取器如实报 `provider_error`，**不是** `empty`", async () => {
    setPlatform(
      fakePlatform({
        executor: {
          invoke: async () => {
            throw new Error("Web 版不支持旧格式转换（请用桌面版）");
          },
        },
      } as unknown as Partial<Platform>),
    );

    const deps = attachmentDeps("att-2");
    const r = await legacyExtractor.extract({
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), // OLE 魔数：旧 .doc 的真实形态
      filename: "旧报告.doc",
      mime: "application/msword",
      hash: "fixture",
      deps,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("Web 版不支持旧格式转换"); // 平台那句话要透出来
    expect(r.code).not.toBe("empty"); // "抽不了" 与 "文件里没内容" 必须分得开
  });
});
