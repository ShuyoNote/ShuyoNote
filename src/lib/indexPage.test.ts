// 「把一个页面索引完整」的判据 —— 假平台 + mock api + **真 sqlite**。
//
// 这条链把三块接在一起（页面分块 / 附件抽取 / 汇总），所以最值得钉的是**接缝**：
// 一个附件坏了会不会拖垮整页、重复调用会不会白做功、`listPageAttachments` 的作用域别越界。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import initSqlJs from "sql.js";
import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: { listPages: vi.fn(), listPageAttachments: vi.fn() },
}));

import { api } from "./api";
import { indexLibrary, indexPage, indexUnfiled } from "./indexPage";
import { DERIVED_SCHEMA_DDL } from "./extract/schema";
import { createAttachmentTextStore, type SqlRunner } from "./extract/store";
import { createChunkStore } from "./extract/chunkStore";
import { desktopDerivedStores } from "./platform/derivedStores";
import { setWasmBytesProvider } from "./platform/sqliteStore";
import { setPlatform as setActivePlatform } from "./platform/index";
import type { Platform } from "./platform/types";

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

/**
 * 把**同步** store 包成"每次调用都让出一个 tick"的**异步** store。
 *
 * 为什么需要这个假后端：`AttachmentTextStore`/`ChunkStore` 的返回类型这一轮放宽成了 `Awaitable<T>`
 * （桌面侧走命令面、`invoke` 必然异步），而**漏写 `await`** 在 TS 里抓不住（仓库没有
 * `no-floating-promises`）：同步实现下漏了也能跑过（值就在手边），异步实现下漏了会读到旧值/空值。
 * ⇒ 让每次调用都真的异步，就能把"漏 await"放大成**必然可见**的差异。
 */
function asAsync<T extends object>(store: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store as Record<string, unknown>)) {
    out[k] =
      typeof v === "function"
        ? async (...args: unknown[]) => {
            await new Promise((r) => setTimeout(r, 0));
            return await (v as (...a: unknown[]) => unknown)(...args);
          }
        : v;
  }
  return out as T;
}

/**
 * 「类 Rust 后端」：把运输层的 op **派发到已有的同步 store**（不新写一份 SQL）——
 * 这样端到端验的是**适配器 + 编排**这一条链；Rust 侧那半另有它自己的 6 条判据
 * （`src-tauri/src/derived_transport.rs`，真实 rusqlite + 真事务）。
 */
async function rustishBackend() {
  const s = await stores();
  /**
   * 返回类型声明成 `DerivedInvoker["invoke"]`：`invoke` 的契约是**泛型**的
   * （调用方按 T 收窄），所以这里用 `as` 把"按命令返回不同形状"的实现挂上去 ——
   * 与真命令面（`platform.executor.invoke`）同一种写法。
   */
  const invoke = (async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (cmd === "derived_apply") {
        const ops = (args?.ops ?? []) as {
          op: string;
          attId?: string;
          extractor?: string;
          srcHash?: string;
          now?: number;
          segments?: { kind: string; text: string; loc?: string }[];
          owner?: { kind: "page"; pageId: string } | { kind: "attachment"; attId: string };
          chunks?: { id: string; pageId?: string | null; attId?: string | null; ord: number; loc?: string; lang?: string; text: string; hash: string }[];
        }[];
        for (const op of ops) {
          if (op.op === "replaceAttachmentText") {
            s.text.replace(
              op.attId!,
              op.extractor!,
              op.srcHash!,
              (op.segments ?? []).map((x) => ({ kind: x.kind as never, text: x.text, loc: x.loc ?? "" })),
              op.now!,
            );
          } else if (op.op === "removeAttachmentText") {
            s.text.removeAttachment(op.attId!);
          } else if (op.op === "replaceChunks") {
            s.chunks.replace(
              op.owner!,
              (op.chunks ?? []).map((c) => ({
                id: c.id,
                pageId: c.pageId ?? null,
                attId: c.attId ?? null,
                ord: c.ord,
                loc: c.loc ?? "",
                lang: c.lang ?? "",
                text: c.text,
                hash: c.hash,
              })),
            );
          } else if (op.op === "removeChunks") {
            s.chunks.remove(op.owner!);
          }
        }
        return { ops: ops.length, rows: 0 };
      }
      if (cmd === "derived_query") {
        const q = args?.query as { op: string; attId?: string; owner?: never };
        if (q.op === "attachmentTextSegments") return s.text.segmentsOf(q.attId!);
        if (q.op === "chunkRows") return s.chunks.chunksOf(q.owner!);
        if (q.op === "chunkStats") return s.chunks.stats();
        if (q.op === "attachmentTextStats") return s.text.stats();
      }
      throw new Error(`假后端不认识的命令：${cmd}`);
  }) as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  return { stores: s, invoke };
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (text: string) =>
  zipSync({
    "word/document.xml": strToU8(
      `<w:document ${W}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });

const longBody = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${i}条讲了预算与差旅报销的具体规定。`).join("");

/**
 * 假平台：`get_page` 给页面正文；附件字节由 `files` 决定（`null` ⇒ 读字节时抛错，模拟盘上没字节）；
 * `metas` 给每个附件的 name/mime —— ⚠️ **必须按 id 给对**，因为分派用的 mime/文件名来自
 * `get_attachment`（`extractAttachment` 自己去平台取 meta，那是**单一来源**），不是来自 `api` 列表。
 */
function platformWith(
  pages: Record<string, string>,
  files: Record<string, Uint8Array | null>,
  metas: Record<string, { name: string; mime: string }> = {},
) {
  return {
    executor: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_page") {
          const id = String(args?.id ?? "");
          if (!(id in pages)) throw new Error(`页面不存在: ${id}`);
          return { id, title: "T", content_text: pages[id] };
        }
        if (cmd === "get_attachment") {
          const id = String(args?.id ?? "");
          return {
            id,
            name: metas[id]?.name ?? "x.docx",
            mime: metas[id]?.mime ?? "",
            hash: id,
            size: 1,
            path: "",
          };
        }
        if (cmd === "read_attachment_bytes") {
          // 用 hash 反查（hash 就是 attId，见上）
          const f = files[String(args?.hash ?? "")];
          if (!f) throw new Error("盘上没有这份字节");
          return f.buffer;
        }
        throw new Error(`意外命令 ${cmd}`);
      },
    },
  } as unknown as Platform;
}

const listed = (ids: string[]) => ids.map((id) => ({ id, name: `${id}.docx`, mime: "", hash: id, size: 1, path: "" }));

beforeEach(() => {
  vi.clearAllMocks();
  setActivePlatform({ executor: { invoke: async () => { throw new Error("未提供"); } } } as unknown as Platform);
});

describe("indexPage：把一个页面索引完整", () => {
  it("页面正文进块 + 该页每个附件都被抽取并分块", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["a1", "a2"]));
    setActivePlatform(platformWith({ p1: longBody(120) }, { a1: docx("附件一"), a2: docx(longBody(80)) }));

    const s = await stores();
    const r = await indexPage("p1", s);

    expect(r.page.chunks).toBeGreaterThan(1); // 页面正文被切了
    expect(r.attachments.map((a) => a.status)).toEqual(["stored", "stored"]);
    expect((await s.chunks.chunksOf({ kind: "page", pageId: "p1" })).length).toBe(r.page.chunks);
    expect((await s.chunks.chunksOf({ kind: "attachment", attId: "a2" })).length).toBeGreaterThan(1);
    expect(r.summary).toContain("附件 2 个（可检索 2）");
  });

  it("★ 慢后端（异步 store，每次调用让出一个 tick）下索引结果与同步 store **逐字相同** —— 这条守「漏 await」", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["a1"]));
    setActivePlatform(platformWith({ p1: longBody(120) }, { a1: docx("附件一") }));

    const sync = await stores();
    const syncResult = await indexPage("p1", sync);

    const delayed = await stores();
    const asyncResult = await indexPage("p1", { text: asAsync(delayed.text), chunks: asAsync(delayed.chunks) });

    // ① 对外结果一致（摘要/块数/每个附件的状态与计数）
    expect(asyncResult.summary).toBe(syncResult.summary);
    expect(asyncResult.page.chunks).toBe(syncResult.page.chunks);
    expect(asyncResult.attachments).toEqual(syncResult.attachments);
    // ② **落库状态**一致 —— 漏 await 时最典型的症状就是这里空/旧（读发生在写之前）
    expect(await delayed.chunks.chunksOf({ kind: "page", pageId: "p1" })).toEqual(
      await sync.chunks.chunksOf({ kind: "page", pageId: "p1" }),
    );
    expect((await delayed.text.segmentsOf("a1")).length).toBeGreaterThan(0);
    expect((await delayed.chunks.chunksOf({ kind: "attachment", attId: "a1" })).length).toBeGreaterThan(0);
  });

  it("★ **桌面路径端到端**：`desktopDerivedStores` + 类 Rust 后端跑通同一个 `indexPage` —— 索引真的填进去了", async () => {
    // 这条是「全库 AI 覆盖」在**主力平台**上的第一份端到端读数：桌面没有 sql.js，
    // 索引只能过命令面（`derived_apply`/`derived_query`）⇒ 走的正是这条链。
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["a1"]));
    setActivePlatform(platformWith({ p1: longBody(120) }, { a1: docx("附件一里的内容") }));

    const backend = await rustishBackend();
    const desktop = desktopDerivedStores(backend);

    const r = await indexPage("p1", desktop);

    expect(r.page.chunks).toBeGreaterThan(1);
    expect(r.attachments[0].status).toBe("stored");
    // ① 派生文本落库了（读回来，而不是只看返回值）
    expect((await desktop.text.segmentsOf("a1")).length).toBeGreaterThan(0);
    // ② 块也落库了，且页面块数与编排报的一致
    expect((await desktop.chunks.chunksOf({ kind: "page", pageId: "p1" })).length).toBe(r.page.chunks);
    expect((await desktop.chunks.stats()).chunks).toBeGreaterThan(r.page.chunks);
    // ③ 附件块里能搜到原文（AI 的 `files.search` / `search_chunks` 走的就是这张表）
    const attRows = await desktop.chunks.chunksOf({ kind: "attachment", attId: "a1" });
    expect(attRows.some((c) => c.text.includes("附件一"))).toBe(true);
    // ④ `ensureSchema` 在桌面是 no-op（表由后端/Rust migrate 保证）⇒ 用真读回的行反过来验缓存判据：
    const segs = await desktop.text.segmentsOf("a1");
    const ids = [...new Set(segs.map((s) => s.extractor))];
    expect(ids.length).toBeGreaterThan(0);
    expect(await desktop.text.needsExtract("a1", "a1", ids)).toBe(false); // 内容没变 ⇒ 不必重抽
    expect(await desktop.text.needsExtract("a1", "换了个 hash", ids)).toBe(true); // 内容变了 ⇒ 必须重抽
  });

  it("**一个附件失败不拖垮整页**：其余照常索引，失败如实进结果（含错误码）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["ok", "broken", "gone"]));
    setActivePlatform(
      platformWith({ p1: "正文。" }, { ok: docx("好的"), broken: new Uint8Array([1, 2, 3]), gone: null }),
    );

    const s = await stores();
    const r = await indexPage("p1", s);

    expect(r.attachments.find((a) => a.attId === "ok")?.status).toBe("stored");
    // 不是 zip ⇒ 走不了 docx；`gone` 连字节都读不到 ⇒ 也不能假装成功
    const broken = r.attachments.find((a) => a.attId === "broken")!;
    const gone = r.attachments.find((a) => a.attId === "gone")!;
    expect(["no_extractor", "failed"]).toContain(broken.status);
    expect(gone.status).toBe("failed");
    expect(gone.code).toBe("internal");
    // 页面正文**照样**有块（不被附件拖累）
    expect((await s.chunks.chunksOf({ kind: "page", pageId: "p1" })).length).toBe(1);
  });

  it("**重复调用很便宜**：第二次全是 cached / 页面块 unchanged（所以保存时无脑调它即可）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["a1"]));
    setActivePlatform(platformWith({ p1: longBody(80) }, { a1: docx("附件一") }));

    const s = await stores();
    const first = await indexPage("p1", s);
    expect(first.page.changed).toBe(true);
    expect(first.attachments[0].status).toBe("stored");

    const second = await indexPage("p1", s);
    expect(second.page.changed).toBe(false); // 内容没变 ⇒ 不写库
    expect(second.attachments[0].status).toBe("cached"); // 命中抽取缓存
  });

  it("`onlyAttachmentIds` 只处理指定附件（「我只要重抽这一个」）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["a1", "a2", "a3"]));
    setActivePlatform(platformWith({ p1: "正文。" }, { a2: docx("只有二") }));

    const s = await stores();
    const r = await indexPage("p1", s, { onlyAttachmentIds: ["a2"] });
    expect(r.attachments.map((a) => a.attId)).toEqual(["a2"]);
    expect(r.attachments[0].status).toBe("stored");
  });

  it("**作用域不越界**：只取该页的附件（`listPageAttachments` 只被按页调用一次，不传 null）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({ p1: "正文。" }, {}));
    const s = await stores();
    await indexPage("p1", s);

    const calls = (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("p1"); // 不是 null（null 是"未整理"，属另一批）
  });

  it("gpu 抽取器没注入 vision ⇒ **provider_error**（不会瞎试网络）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "img", name: "扫描件.png", mime: "image/png", hash: "img", size: 1, path: "" },
    ]);
    setActivePlatform(
      platformWith({ p1: "正文。" }, { img: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, {
        img: { name: "扫描件.png", mime: "image/png" },
      }),
    );

    const s = await stores();
    const r = await indexPage("p1", s); // 不给 vision
    expect(r.attachments[0].status).toBe("failed");
    expect(r.attachments[0].code).toBe("provider_error");
    expect(r.summary).toContain("provider_error");
  });

  it("★ 音频附件没注入 transcribe ⇒ **provider_error**（不会瞎试网络）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "av", name: "会议录音.wav", mime: "audio/wav", hash: "av", size: 1, path: "" },
    ]);
    setActivePlatform(
      platformWith({ p1: "正文。" }, { av: new Uint8Array([1, 2, 3]) }, {
        av: { name: "会议录音.wav", mime: "audio/wav" },
      }),
    );

    const s = await stores();
    const r = await indexPage("p1", s); // 不给 transcribe
    expect(r.attachments[0].status).toBe("failed");
    expect(r.attachments[0].code).toBe("provider_error");
  });

  it("★ 注入了 transcribe ⇒ 它**真的被调用**，且带时间戳的段进了内容层（能力 ≠ 行为）", async () => {
    // 这条是"接线"判据，不是"函数返回什么"：`transcribe` 是抽取层**收到**的 deps，
    // 从 UI 传到抽取器中间要经过 `runLibraryIndex → indexLibrary → indexPage → indexOne → extractAttachment`
    // 五跳 —— 任何一跳漏传，`av.transcript@1` 都会安静地退回 `provider_error`，
    // 而"没注入"和"注入了但没传下去"在结果上**长得一模一样**。
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "av", name: "会议录音.wav", mime: "audio/wav", hash: "av", size: 1, path: "" },
    ]);
    setActivePlatform(
      platformWith({ p1: "正文。" }, { av: new Uint8Array([1, 2, 3]) }, {
        av: { name: "会议录音.wav", mime: "audio/wav" },
      }),
    );

    const calls: { mime: string; model?: string; bytes: number }[] = [];
    const transcribe = async (audio: Uint8Array, mime: string, opts: { model?: string }) => {
      calls.push({ mime, model: opts.model, bytes: audio.byteLength });
      return {
        text: "今天天气不错，我们下午三点开会。",
        segments: [
          { start: 0, end: 3.5, text: "今天天气不错，" },
          { start: 3.5, end: 7, text: "我们下午三点开会。" },
        ],
      };
    };

    const s = await stores();
    const r = await indexPage("p1", s, { transcribe });

    // ① 真的调到了（mime 与字节都从平台取到的那一份）
    expect(calls).toEqual([{ mime: "audio/wav", model: "funasr-nano", bytes: 3 }]);
    expect(r.attachments[0].status).toBe("stored");
    // ② 文本进了内容层，且 `loc` 是**时间戳定位**（HH:MM:SS）—— 转写与其它抽取器最本质的区别
    const segs = await s.text.segmentsOf("av");
    expect(segs.map((x) => x.text)).toEqual(["今天天气不错，", "我们下午三点开会。"]);
    expect(segs.map((x) => x.loc)).toEqual(["00:00:00", "00:00:03"]);
    expect(segs.every((x) => x.kind === "transcript")).toBe(true);
    // ③ 顺手分块（同一入口的职责）⇒ 检索面立刻看得到
    expect((await s.chunks.chunksOf({ kind: "attachment", attId: "av" })).length).toBeGreaterThan(0);
  });

  it("页面不存在 ⇒ 抛出（调用方的错，不该被伪装成「索引了 0 块」）", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({}, {}));
    const s = await stores();
    await expect(indexPage("nope", s)).rejects.toThrow("页面不存在");
  });
});

describe("indexLibrary：全库索引（UI 上那个「开始索引」）", () => {
  const setPages = (ids: string[]) =>
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ids.map((id) => ({ id })));

  it("逐页 + 未整理，一起汇总；块数来自一次 stats", async () => {
    setPages(["p1", "p2"]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (pageId: string | null) => (pageId === "p1" ? listed(["a1"]) : pageId === "p2" ? [] : listed(["u1"])),
    );
    setActivePlatform(platformWith({ p1: "正文一。", p2: longBody(80) }, { a1: docx("附件"), u1: docx("散件") }));

    const s = await stores();
    const r = await indexLibrary(s);

    expect(r.pages).toEqual({ total: 2, ok: 2, failed: 0 });
    expect(r.attachments).toMatchObject({ total: 2, searchable: 2 });
    expect(r.attachments.byStatus).toEqual({ stored: 2 });
    expect(r.unfiled.attachments.map((a) => a.attId)).toEqual(["u1"]);
    // 块总数**就是库里的真实值**（来自一次 stats，不编造分项）
    expect(r.chunks.total).toBe((await s.chunks.stats()).chunks);
    expect(r.chunks.total).toBeGreaterThan(0);
    expect(r.summary).toContain("页面 2/2 已索引");
  });

  it("**一页坏掉不停整个库**：其余页面照常索引完，坏页进 failures", async () => {
    setPages(["good", "bad"]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({ good: "好的正文。" }, {})); // `bad` 不存在 ⇒ get_page 抛

    const s = await stores();
    const r = await indexLibrary(s);

    expect(r.pages).toEqual({ total: 2, ok: 1, failed: 1 });
    expect(r.failures).toEqual([{ kind: "page", id: "bad", reason: "页面不存在: bad" }]);
    // 好页面**确实**被索引了（不是"因为有人坏就整批放弃"）
    expect((await s.chunks.chunksOf({ kind: "page", pageId: "good" })).length).toBeGreaterThan(0);
    expect(r.summary).toContain("失败 1");
  });

  it("进度回调**单调递增且收尾到 total**（可直接驱动进度条）", async () => {
    setPages(["p1", "p2"]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({ p1: "甲。", p2: "乙。" }, {}));

    const seen: [number, number, string][] = [];
    const s = await stores();
    await indexLibrary(s, { onProgress: (d, t, label) => seen.push([d, t, label]) });

    expect(seen.length).toBeGreaterThanOrEqual(4); // 2 页 + 未整理 + 完成
    expect(seen.every(([, t]) => t === 3)).toBe(true); // 2 页 + 1 步
    const dones = seen.map(([d]) => d);
    expect(dones).toEqual([...dones].sort((a, b) => a - b)); // 单调
    expect(dones[dones.length - 1]).toBe(3); // 收尾
    expect(seen[seen.length - 1][2]).toBe("完成");
  });

  it("**可重复**：第二次全是 cached / 无新写（中断后重跑几乎不花时间）", async () => {
    setPages(["p1"]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (pageId: string | null) => (pageId === "p1" ? listed(["a1"]) : []),
    );
    setActivePlatform(platformWith({ p1: longBody(80) }, { a1: docx("附件") }));

    const s = await stores();
    await indexLibrary(s);
    const again = await indexLibrary(s);

    expect(again.attachments.byStatus).toEqual({ cached: 1 });
    expect(again.pages).toEqual({ total: 1, ok: 1, failed: 0 });
  });

  it("空库 ⇒ 不报错（页 0/0、只有未整理那一步）", async () => {
    setPages([]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({}, {}));
    const s = await stores();
    const r = await indexLibrary(s);
    expect(r.pages).toEqual({ total: 0, ok: 0, failed: 0 });
    expect(r.summary).toContain("页面 0/0");
  });
});

describe("indexUnfiled：把「未整理」的附件也索引掉（否则报告指着一个补不掉的缺口）", () => {
  it("**只取未整理那一批**（`listPageAttachments(null)`），并如实汇总", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["u1", "u2"]));
    setActivePlatform(platformWith({}, { u1: docx("散件一"), u2: new Uint8Array([9, 9]) }));

    const s = await stores();
    const r = await indexUnfiled(s);

    expect(r.attachments).toHaveLength(2);
    expect(r.attachments.find((a) => a.attId === "u1")?.status).toBe("stored");
    expect(r.summary).toContain("未整理附件 2 个");
    expect((await s.chunks.chunksOf({ kind: "attachment", attId: "u1" })).length).toBeGreaterThan(0);

    // 取材的是"未整理"那一路 —— 与覆盖报告的取材口径一致（否则报告说缺、这里索引不到）
    const calls = (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeNull();
  });

  it("重复调用便宜：第二次是 cached", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listed(["u1"]));
    setActivePlatform(platformWith({}, { u1: docx("散件") }));
    const s = await stores();
    await indexUnfiled(s);
    const again = await indexUnfiled(s);
    expect(again.attachments[0].status).toBe("cached");
  });

  it("空库（没有未整理附件）⇒ 不报错、摘要说 0", async () => {
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    setActivePlatform(platformWith({}, {}));
    const s = await stores();
    const r = await indexUnfiled(s);
    expect(r.attachments).toEqual([]);
    expect(r.summary).toContain("0 个");
  });
});
