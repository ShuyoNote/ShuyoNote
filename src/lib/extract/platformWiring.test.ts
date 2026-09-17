// 派生文本层「接进 Web 平台」的验证。
//
// 为什么值得单独测一次：`extract/` 那一套是**纯逻辑 + 注入式 SQL 接口**，它自己全绿
// **并不能证明"接进真平台也能跑"**——中间还有三处会出错：
//   ① DDL 到底有没有被平台执行（表在不在这张库里）；② 参数绑定类型对不对；
//   ③ `SqliteStore.run()` 的"每条写就全库快照"会不会把批量写打爆。
// 这个文件就是钉这三处。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteStore, setWasmBytesProvider } from "../platform/sqliteStore";

beforeAll(() => {
  // 不引 bundler：直接把 sql.js 的 wasm 字节喂进去（这是 setWasmBytesProvider 存在的理由）。
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  const bytes = readFileSync(wasm);
  setWasmBytesProvider(async () => new Uint8Array(bytes));
});

/** 建一个真 SqliteStore（持久化换成内存 no-op，测试不需要落盘）。 */
async function freshStore() {
  const adapter = { load: async () => null, save: async () => {} };
  const store = new SqliteStore(adapter);
  await store.init();
  return store;
}

describe("派生文本层接进 Web 平台", () => {
  it("migrate() 真的建出了三张派生表（不只看代码里写了什么）", async () => {
    const store = await freshStore();
    const names = store
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .map((r) => r.name);
    expect(names).toContain("attachment_text");
    expect(names).toContain("chunks");
    expect(names).toContain("chunk_embeddings");
  });

  it("重复 init（模拟重启已有库）不会因建表报错 —— DDL 必须幂等", async () => {
    const adapter = { load: async () => null, save: async () => {} };
    const first = new SqliteStore(adapter);
    await first.init();
    const bytes = first.snapshot();

    // 用上一份快照当"已存在的库"再 init 一次
    const second = new SqliteStore({ load: async () => bytes, save: async () => {} });
    await expect(second.init()).resolves.toBeUndefined();
    expect(
      second.query("SELECT name FROM sqlite_master WHERE name='attachment_text'").length,
    ).toBe(1);
  });

  it("derivedTextStore() 能直接读写（参数绑定与适配都对）", async () => {
    const store = await freshStore();
    const derived = store.derivedTextStore();

    derived.replace(
      "att-1",
      "ooxml.docx@1",
      "hash-a",
      [
        { kind: "heading", text: "季度总结", loc: "" },
        { kind: "text", text: "第一段", loc: "" },
      ],
      1000,
    );

    const rows = derived.segmentsOf("att-1");
    expect(rows.map((r) => [r.seq, r.kind, r.text])).toEqual([
      [0, "heading", "季度总结"],
      [1, "text", "第一段"],
    ]);
    expect(derived.needsExtract("att-1", "hash-a", ["ooxml.docx@1"])).toBe(false);
    expect(derived.needsExtract("att-1", "hash-b", ["ooxml.docx@1"])).toBe(true);
  });

  it("**纪律 ①**：派生表不参与同步 —— 不在平台建的表清单里被当成业务实体（防回归哨兵）", async () => {
    // 这条是"声明式"的：派生表是本地缓存（§6.1），**不应**出现在 changes/同步实体枚举里。
    // 一旦有人把它接进同步，这里会红，提醒去读方案 §6.1 的"不进同步/备份/导出"。
    const store = await freshStore();
    const sql = readFileSync(
      join(process.cwd(), "src/lib/platform/sqliteStore.ts"),
      "utf8",
    );
    // 平台层不应出现"把 attachment_text 写进 changes"的代码
    expect(/changes[\s\S]{0,200}attachment_text/.test(sql)).toBe(false);
    // 且表确实存在（避免上面那句因为表没建而"假绿"）
    expect(
      store.query("SELECT name FROM sqlite_master WHERE name='attachment_text'").length,
    ).toBe(1);
  });
});

describe("批量写收口（那条平方级开销的修复）", () => {
  /** 数得清 save 次数的适配器 —— **用计数证明，而不是靠读代码相信**。 */
  function countingStore() {
    const saves: number[] = [];
    const adapter = {
      load: async () => null,
      save: async (bytes: Uint8Array) => {
        saves.push(bytes.length);
      },
    };
    return { store: new SqliteStore(adapter), saves };
  }

  it("replace 500 段 ⇒ **只快照 1 次**（修复前会是 501 次）", async () => {
    const { store, saves } = countingStore();
    await store.init();
    saves.length = 0; // init 自己可能有一次；只数 replace 引起的

    const segs = Array.from({ length: 500 }, (_, i) => ({
      kind: "text" as const,
      text: `第 ${i} 段`,
      loc: `p.${i}`,
    }));
    store.derivedTextStore().replace("att-bulk", "pdf.text@1", "h", segs, 1);
    await Promise.resolve(); // persist 是 fire-and-forget，让它跑完

    expect(saves.length).toBe(1);
    expect(store.derivedTextStore().segmentsOf("att-bulk")).toHaveLength(500);
  });

  it("非事务路径仍然是每写一次就快照（行为没变，避免误伤既有代码）", async () => {
    const { store, saves } = countingStore();
    await store.init();
    saves.length = 0;
    store.run("INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
      "a", "x@1", 0, "text", "t", "", "h", 1,
    ]);
    await Promise.resolve();
    expect(saves.length).toBe(1);
  });

  it("transaction 抛错 ⇒ **回滚**（写入不生效），且仍把快照落一次", async () => {
    const { store, saves } = countingStore();
    await store.init();
    saves.length = 0;

    expect(() =>
      store.transaction(() => {
        store.run("INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
          "roll", "x@1", 0, "text", "不该留下", "", "h", 1,
        ]);
        throw new Error("模拟中途失败");
      }),
    ).toThrow("模拟中途失败");

    await Promise.resolve();
    expect(
      store.query("SELECT * FROM attachment_text WHERE att_id='roll'"),
    ).toHaveLength(0);
    expect(saves.length).toBe(1); // 回滚后也要落一次快照，别让磁盘停在更旧的状态
  });

  it("嵌套 transaction 只提交/快照一次（可重入）", async () => {
    const { store, saves } = countingStore();
    await store.init();
    saves.length = 0;
    store.transaction(() => {
      store.run("INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
        "outer", "x@1", 0, "text", "外", "", "h", 1,
      ]);
      store.transaction(() => {
        store.run("INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at) VALUES (?,?,?,?,?,?,?,?)", [
          "inner", "x@1", 0, "text", "内", "", "h", 1,
        ]);
      });
    });
    await Promise.resolve();
    expect(saves.length).toBe(1);
    expect(store.query("SELECT att_id FROM attachment_text ORDER BY att_id").map((r) => (r as { att_id: string }).att_id))
      .toEqual(["inner", "outer"]);
  });
});
