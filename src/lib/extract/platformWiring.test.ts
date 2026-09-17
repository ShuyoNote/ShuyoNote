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
