// 派生文本存储 + 抽取调度的单测。
//
// **用真 SQLite（sql.js）而不是假对象**：假对象只能印证我自己写的 SQL 字符串，
// 建表、主键、GROUP BY、参数绑定这些真会出错的地方它一律测不到。

import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";

import { extractAndStore } from "./pipeline";
import { candidates, pickExtractor, REGISTRY } from "./registry";
import { DERIVED_SCHEMA_DDL } from "./schema";
import { createAttachmentTextStore, COVERAGE_COLUMN_MIGRATION, type SqlRunner } from "./store";
import { docxExtractor } from "./ooxml";
import { fail, ok, type Extractor } from "./types";

/** 只声明我们真正用到的那几个方法（结构化类型）——不去追 sql.js 的类型导出。 */
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

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** 把 sql.js 适配成 store 需要的最小接口。 */
function runner(db: SqlJsDatabase): SqlRunner {
  return {
    run(sql, params = []) {
      db.run(sql, [...params]);
    },
    query<T>(sql: string, params: readonly unknown[] = []) {
      const stmt = db.prepare(sql);
      stmt.bind([...params]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
    // 单语句即可，这里统一走 exec（sql.js 的 exec 支持多语句，也更省一次 prepare）
    exec(sql) {
      db.exec(sql);
    },
    transaction(fn) {
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

function freshStore() {
  const db = new SQL.Database() as unknown as SqlJsDatabase;
  const store = createAttachmentTextStore(runner(db));
  // 同步 sql.js store ⇒ 不必 await（Awaitable<void> 允许同步实现）。
  store.ensureSchema(DERIVED_SCHEMA_DDL);
  return { db, store };
}

// ── 覆盖度落库（2026-09-23）──────────────────────────────────────────────────
//
// 这一列回答的是"**这份派生文本抽全了没有**"（方案 §15.10：成功 ≠ 抽全了）。此前它被算出来又被丢掉，
// 于是「混合文档里那几页扫描件没抽到内容」与「文件里本来就没有」在 AI 工具面**长得一模一样**。
// ⚠️ 这一组里最要紧的是第 ②③ 条：**未知 ≠ 完整** —— 缺信息时必须读成"不知道"，不许读成"抽全了"。
describe("覆盖度落库（`coverage` 列）", () => {
  const seg = [{ kind: "text" as const, text: "第一页", loc: "p.1" }];

  // ⚠️ 这一组必须 `async/await`：`coverageOf` 的返回类型是 `Awaitable<…>`（同步实现直接给值、
  //    桌面走命令面给 Promise）—— 漏 `await` 在同步实现下照样"过"，所以判据一律按异步写。
  it("① 写进去能原样读回（complete / gapIndexes / note 都在）", async () => {
    const { store } = freshStore();
    await store.replace("att1", "pdf.text@1", "h1", seg, 100, {
      complete: false,
      gapIndexes: [1],
      note: "跳过 p.2",
    });
    expect(await store.coverageOf("att1")).toEqual([
      { extractor: "pdf.text@1", coverage: { complete: false, gapIndexes: [1], note: "跳过 p.2" } },
    ]);
  });

  it("② ★ **不传覆盖度 ⇒ 读回来是「没有这一格」**（未知 ≠ 完整）", async () => {
    const { store } = freshStore();
    await store.replace("att1", "text.plain@1", "h1", seg, 100);
    const got = await store.coverageOf("att1");
    expect(got).toEqual([{ extractor: "text.plain@1" }]);
    expect("coverage" in got[0]!).toBe(false); // 不是 `{complete:true}`，是**根本没有**
  });

  it("③ ★ 库里那份不是合法 JSON（旧格式/手改）⇒ 也只算**未知**，不许猜成完整", async () => {
    const { db, store } = freshStore();
    await store.replace("att1", "x@1", "h1", seg, 100, { complete: false });
    db.run("UPDATE attachment_text SET coverage = ? WHERE att_id = ?", ["{不是 json", "att1"]);
    expect(await store.coverageOf("att1")).toEqual([{ extractor: "x@1" }]);
  });

  it("④ 多个抽取器 ⇒ 按 extractor 稳定排序，各带各的（不合并、不串味）", async () => {
    const { store } = freshStore();
    await store.replace("att1", "pdf.ocr@1", "h1", seg, 100, { complete: true });
    await store.replace("att1", "pdf.text@1", "h1", seg, 100, { complete: false, gapIndexes: [2] });
    expect(await store.coverageOf("att1")).toEqual([
      { extractor: "pdf.ocr@1", coverage: { complete: true } },
      { extractor: "pdf.text@1", coverage: { complete: false, gapIndexes: [2] } },
    ]);
  });

  it("⑤ 换了抽取器/重抽 ⇒ 覆盖度跟着整体替换（不留上一次的残值）", async () => {
    const { store } = freshStore();
    await store.replace("att1", "pdf.text@1", "h1", seg, 100, { complete: false, gapIndexes: [1] });
    await store.replace("att1", "pdf.text@1", "h1", seg, 200, { complete: true });
    expect(await store.coverageOf("att1")).toEqual([
      { extractor: "pdf.text@1", coverage: { complete: true } },
    ]);
  });

  it("⑥ ★ **老库**（表里没有 coverage 列）能靠那条幂等迁移补上，补完可读可写", async () => {
    const db = new SQL.Database() as unknown as SqlJsDatabase;
    // 先造一张"按老 DDL 建的表"（没有 coverage 列）
    const oldDdl = DERIVED_SCHEMA_DDL.map((s) =>
      s.includes("attachment_text") ? s.replace(/\n  coverage   TEXT    NOT NULL DEFAULT '',/, "") : s,
    );
    for (const stmt of oldDdl) db.exec(stmt);
    const cols = () =>
      (db.exec("PRAGMA table_info(attachment_text)")[0]?.values ?? []).map((v) => String(v[1]));
    expect(cols()).not.toContain("coverage");

    db.run(COVERAGE_COLUMN_MIGRATION); // 与 Rust/Web 的 migrate 同一条
    expect(cols()).toContain("coverage");

    const store = createAttachmentTextStore(runner(db));
    await store.replace("att1", "pdf.text@1", "h1", seg, 100, { complete: true });
    expect(await store.coverageOf("att1")).toEqual([
      { extractor: "pdf.text@1", coverage: { complete: true } },
    ]);
  });
});

const SEG = [
  { kind: "heading" as const, text: "季度总结", loc: "" },
  { kind: "text" as const, text: "第一段", loc: "" },
];

describe("schema", () => {
  it("三张表都能建出来（DDL 是单语句、幂等）", async () => {
    const { db, store } = freshStore();
    // 同步 sql.js store ⇒ 不必 await（Awaitable<void> 允许同步实现）。
  store.ensureSchema(DERIVED_SCHEMA_DDL); // 再跑一次必须无害
    const names = db
      .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]
      .values.flat()
      .map(String);
    expect(names).toContain("attachment_text");
    expect(names).toContain("chunks");
    expect(names).toContain("chunk_embeddings");
  });
});

describe("AttachmentTextStore", () => {
  it("replace 后能读回，且 seq 从 0 连续", async () => {
    const { store } = freshStore();
    store.replace("att1", "ooxml.docx@1", "h1", SEG, 1000);
    const rows = (await store.segmentsOf("att1"));
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.kind)).toEqual(["heading", "text"]);
    expect(rows.map((r) => r.text)).toEqual(["季度总结", "第一段"]);
    expect(rows.every((r) => r.src_hash === "h1")).toBe(true);
    expect(rows.every((r) => r.updated_at === 1000)).toBe(true);
  });

  it("replace 是**整体替换**：再次调用不会留下上一次的残段", async () => {
    const { store } = freshStore();
    store.replace("att1", "ooxml.docx@1", "h1", SEG, 1000);
    store.replace("att1", "ooxml.docx@1", "h2", [SEG[0]], 2000);
    const rows = (await store.segmentsOf("att1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].src_hash).toBe("h2");
    expect(rows[0].updated_at).toBe(2000);
  });

  it("needsExtract：没抽过 ⇒ true；抽过且 hash 一致 ⇒ false；hash 变了 ⇒ true", async () => {
    const { store } = freshStore();
    expect((await store.needsExtract("att1", "h1", ["ooxml.docx@1"]))).toBe(true);

    store.replace("att1", "ooxml.docx@1", "h1", SEG, 1000);
    expect((await store.needsExtract("att1", "h1", ["ooxml.docx@1"]))).toBe(false);
    expect((await store.needsExtract("att1", "h2", ["ooxml.docx@1"]))).toBe(true);
  });

  it("needsExtract：要求**每个**候选抽取器都有当前 hash 的行", async () => {
    const { store } = freshStore();
    store.replace("att1", "pdf.text@1", "h1", SEG, 1000);
    // pdf.ocr@1 还没抽 ⇒ 仍需抽（否则会出现"换了个抽取器却没抽"的静默空洞）
    expect((await store.needsExtract("att1", "h1", ["pdf.text@1", "pdf.ocr@1"]))).toBe(true);
    store.replace("att1", "pdf.ocr@1", "h1", SEG, 1000);
    expect((await store.needsExtract("att1", "h1", ["pdf.text@1", "pdf.ocr@1"]))).toBe(false);
  });

  it("needsExtract：空候选列表 ⇒ false（没有要抽的东西）", async () => {
    const { store } = freshStore();
    expect((await store.needsExtract("att1", "h1", []))).toBe(false);
  });

  it("removeAttachment 只删该附件", async () => {
    const { store } = freshStore();
    store.replace("att1", "x@1", "h", SEG, 1);
    store.replace("att2", "x@1", "h", SEG, 1);
    (await store.removeAttachment("att1"));
    expect((await store.segmentsOf("att1"))).toHaveLength(0);
    expect((await store.segmentsOf("att2"))).toHaveLength(2);
  });

  it("stats 按抽取器汇总段数与字符数", async () => {
    const { store } = freshStore();
    store.replace("att1", "a@1", "h", SEG, 1); // 4 + 3 = 7 字
    store.replace("att2", "b@1", "h", [SEG[0]], 1); // 4 字
    expect(store.stats()).toEqual([
      { extractor: "a@1", rows: 2, chars: 7 },
      { extractor: "b@1", rows: 1, chars: 4 },
    ]);
  });

  it("主键约束真实生效：(att_id, extractor, seq) 重复插入被 SQLite 拒绝", async () => {
    const { db, store } = freshStore();
    store.replace("att1", "a@1", "h", SEG, 1);
    // 绕过 replace（它会先删）直接插入同样的主键 ⇒ 必须报错，否则"整体替换"的语义没有保障
    expect(() =>
      db.run(
        "INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        ["att1", "a@1", 0, "text", "重复", "", "h", 1],
      ),
    ).toThrow();
  });
});

describe("registry 候选", () => {
  it("candidates 保持顺序、含 mime 命中与扩展名命中、且去重", async () => {
    const a: Extractor = { ...docxExtractor, id: "a@1" };
    const b: Extractor = { ...docxExtractor, id: "b@1" };
    const list = candidates("application/msword", "x.docx", [a, b]);
    // 两个都靠 .docx 命中，顺序即注册表顺序
    expect(list.map((e) => e.id)).toEqual(["a@1", "b@1"]);
  });

  it("pickExtractor 就是 candidates[0]", async () => {
    expect(pickExtractor("", "x.docx", REGISTRY)?.id).toBe("ooxml.docx@1");
    expect(pickExtractor("", "x.docx", REGISTRY)).toBe(candidates("", "x.docx", REGISTRY)[0]);
  });

  it("真实注册表：三个 OOXML 抽取器各认自己的扩展名", async () => {
    expect(pickExtractor("", "a.docx", REGISTRY)?.id).toBe("ooxml.docx@1");
    expect(pickExtractor("", "a.xlsx", REGISTRY)?.id).toBe("ooxml.xlsx@1");
    expect(pickExtractor("", "a.pptx", REGISTRY)?.id).toBe("ooxml.pptx@1");
    // 2026-09-17：`pdf.text@1` 落地后，`.pdf` **不再**是"没人认"的扩展名（原断言写的是 toBeNull）——
    // 「没人认」的用例改用真正没抽取器的扩展名，别让这条判据随着注册表长大而失效。
    expect(pickExtractor("", "a.pdf", REGISTRY)?.id).toBe("pdf.text@1");
    expect(pickExtractor("", "a.unknownext", REGISTRY)).toBeNull();
  });
});

describe("extractAndStore", () => {
  /** 造一个总能成功的假抽取器（只用于调度语义，不测解析）。 */
  function fakeOk(id: string, exts: string[], kinds: ("text" | "sheet")[] = ["text"]): Extractor {
    return {
      id,
      mimes: [],
      extensions: exts,
      cost: "cpu",
      extract: async () => ok(id, kinds.map((k, i) => ({ kind: k, text: `t${i}`, loc: "" }))),
    };
  }

  const base = {
    attId: "att1",
    filename: "a.docx",
    mime: "",
    hash: "h1",
    bytes: new Uint8Array([1, 2, 3]),
  };

  it("首次：stored，并真的落库", async () => {
    const { store } = freshStore();
    const r = await extractAndStore({ ...base, store, registry: [fakeOk("x@1", [".docx"])] });
    expect(r).toMatchObject({ status: "stored", extractor: "x@1", segments: 1 });
    expect((await store.segmentsOf("att1"))).toHaveLength(1);
  });

  it("第二次同 hash：cached，不重复写（updated_at 保持不变）", async () => {
    const { store } = freshStore();
    const reg = [fakeOk("x@1", [".docx"])];
    await extractAndStore({ ...base, store, registry: reg, now: 111 });
    const r = await extractAndStore({ ...base, store, registry: reg, now: 999 });
    expect(r).toMatchObject({ status: "cached" });
    expect((await store.segmentsOf("att1"))[0].updated_at).toBe(111);
  });

  it("hash 变了：重抽并覆盖", async () => {
    const { store } = freshStore();
    const reg = [fakeOk("x@1", [".docx"])];
    await extractAndStore({ ...base, store, registry: reg, now: 111 });
    await extractAndStore({ ...base, hash: "h2", store, registry: reg, now: 222 });
    expect((await store.segmentsOf("att1"))[0].src_hash).toBe("h2");
  });

  it("没有抽取器认：no_extractor", async () => {
    const { store } = freshStore();
    const r = await extractAndStore({ ...base, filename: "a.zip", store, registry: [] });
    expect(r).toMatchObject({ status: "no_extractor" });
  });

  it("unsupported ⇒ 换下一个候选（模拟 pdf.text 空了落到 pdf.ocr）", async () => {
    const { store } = freshStore();
    const first: Extractor = {
      id: "p1@1", mimes: [], extensions: [".pdf"], cost: "cpu",
      extract: async () => fail("p1@1", "unsupported", "不是我的格式"),
    };
    const second = fakeOk("p2@1", [".pdf"]);
    const r = await extractAndStore({ ...base, filename: "a.pdf", store, registry: [first, second] });
    expect(r).toMatchObject({ status: "stored", extractor: "p2@1" });
  });

  it("empty 也换下一个候选", async () => {
    const { store } = freshStore();
    const first: Extractor = {
      id: "p1@1", mimes: [], extensions: [".pdf"], cost: "cpu",
      extract: async () => fail("p1@1", "empty", "抽不出"),
    };
    const second = fakeOk("p2@1", [".pdf"]);
    const r = await extractAndStore({ ...base, filename: "a.pdf", store, registry: [first, second] });
    expect(r).toMatchObject({ status: "stored", extractor: "p2@1" });
  });

  it("encrypted ⇒ **不换**候选，直接报告（换了也不会好）", async () => {
    const { store } = freshStore();
    let secondCalled = false;
    const first: Extractor = {
      id: "p1@1", mimes: [], extensions: [".pdf"], cost: "cpu",
      extract: async () => fail("p1@1", "encrypted", "加密"),
    };
    const second: Extractor = {
      id: "p2@1", mimes: [], extensions: [".pdf"], cost: "cpu",
      extract: async () => {
        secondCalled = true;
        return ok("p2@1", [{ kind: "text", text: "x", loc: "" }]);
      },
    };
    const r = await extractAndStore({ ...base, filename: "a.pdf", store, registry: [first, second] });
    expect(r).toMatchObject({ status: "failed", code: "encrypted", tried: ["p1@1"] });
    expect(secondCalled).toBe(false);
  });

  it("失败时**不动**库里已有的行（瞬时 provider_error 不该毁掉已抽好的文本）", async () => {
    const { store } = freshStore();
    const good = fakeOk("x@1", [".docx"]);
    await extractAndStore({ ...base, store, registry: [good], now: 111 });

    // 附件内容变了（h1 → h2）才会真的触发重抽；这次抽取器失败。
    const bad: Extractor = {
      id: "x@1", mimes: [], extensions: [".docx"], cost: "gpu",
      extract: async () => fail("x@1", "provider_error", "端点不可达"),
    };
    const r = await extractAndStore({ ...base, hash: "h2", store, registry: [bad] });
    expect(r).toMatchObject({ status: "failed", code: "provider_error" });

    // 旧行原样保留（仍带 h1）——
    const rows = (await store.segmentsOf("att1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].src_hash).toBe("h1");
    // 于是"过期"由 src_hash 自己暴露：下次仍会重试，不会静默停在残缺状态
    expect((await store.needsExtract("att1", "h2", ["x@1"]))).toBe(true);
  });

  // ---- gpu 抽取器端到端（用真的 image.ocr@1，不是假的）--------------------
  // 契约里最容易在"最后一公里"漏掉的两条：真实注册表能否选到它、以及
  // 没有视觉模型时**什么都不该写库**。

  it("真实注册表 + 真 image.ocr@1：没配视觉模型 ⇒ provider_error，且**一行都不写**", async () => {
    const { store } = freshStore();
    const r = await extractAndStore({
      ...base,
      filename: "扫描件.png",
      mime: "image/png",
      store,
      registry: REGISTRY,
    });
    expect(r).toMatchObject({ status: "failed", code: "provider_error", tried: ["image.ocr@1"] });
    expect((await store.segmentsOf("att1"))).toHaveLength(0);
    // 没写库 ⇒ 下次仍会重试（不会因为"试过了"就永久跳过）
    expect((await store.needsExtract("att1", "h1", ["image.ocr@1"]))).toBe(true);
  });

  it("真实注册表 + 真 image.ocr@1：注入 vision 后落库，kind = ocr", async () => {
    const { store } = freshStore();
    const r = await extractAndStore({
      ...base,
      filename: "扫描件.png",
      mime: "image/png",
      store,
      registry: REGISTRY,
      deps: { vision: async () => "发票号码 001" },
      now: 500,
    });
    expect(r).toMatchObject({ status: "stored", extractor: "image.ocr@1", kinds: ["ocr"] });
    const rows = (await store.segmentsOf("att1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ocr", text: "发票号码 001", loc: "", src_hash: "h1" });
    // 第二次同 hash ⇒ cached（gpu 抽取器也不该被重复调用——那是最贵的一种浪费）
    const again = await extractAndStore({
      ...base,
      filename: "扫描件.png",
      mime: "image/png",
      store,
      registry: REGISTRY,
      deps: { vision: async () => "不该被调用" },
      now: 999,
    });
    expect(again).toMatchObject({ status: "cached" });
    expect((await store.segmentsOf("att1"))[0].updated_at).toBe(500);
  });
});
