// 分块与块存储的判据。用**真 sqlite**（假 store 会造出假结论 —— 今天已在真样张跑器上踩过一次）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fnv1a32 } from "../hash";
import { embedHash } from "../semanticEmbed";
import { DEFAULT_CHUNK_POLICY, chunkSegments, chunkText, detectLang, overlapTail } from "./chunk";
import { createChunkStore } from "./chunkStore";
import { DERIVED_SCHEMA_DDL } from "./schema";
import { setWasmBytesProvider } from "../platform/sqliteStore";
import type { SqlRunner } from "./store";

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
    exec: (sql) => db.exec(sql),
  };
  const store = createChunkStore(runner);
  store.ensureSchema(DERIVED_SCHEMA_DDL);
  return store;
}

const seg = (text: string, loc = "") => ({ text, loc });

/** 造 n 个中文字的长文本（每句 ~20 字，便于预测切点）。 */
function longZh(n: number): string {
  return Array.from({ length: n }, (_, i) => `第${i}段讲了预算与差旅报销的具体规定。`).join("");
}

describe("分块 · 基本口径", () => {
  it("短文本 ⇒ 一块；`loc` 保留；`hash` 是内容哈希", () => {
    const chunks = chunkSegments({ kind: "attachment", attId: "a1" }, [seg("季度总结", "p.1")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageId: null, attId: "a1", ord: 0, loc: "p.1", text: "季度总结" });
    expect(chunks[0].hash).toBe(fnv1a32("季度总结"));
    expect(chunks[0].id).toBe("att:a1#0000");
  });

  it("**不超硬上限**：一份长文本切出来的每一块都 ≤ max", () => {
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(longZh(200))]);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_POLICY.max);
  });

  it("**块是被「填满」的，不是一段一块**：多个短段会装进同一块", () => {
    const segs = Array.from({ length: 10 }, (_, i) => seg(`第${i}条：若干规定文字。`, `p.${i + 1}`));
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, segs);
    expect(chunks.length).toBeLessThan(segs.length); // 确实合并了
    expect(chunks[0].loc).toBe("p.1"); // 块的 loc 是**第一段**的定位
  });

  it("**单句超上限只能硬切**（并说明：没有更好的边界可用，但硬上限必须成立）", () => {
    const oneSentence = "甲".repeat(2000); // 没有任何句末标点
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(oneSentence)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_POLICY.max);
    // 硬切后的后续片没有更细的定位可用 ⇒ loc 留空，**不编**
    expect(chunks[1].loc).toBe("");
  });

  it("超长**段**被切开时，只有第一片继承 loc（后几片没有更细的定位可给）", () => {
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(longZh(120), "p.9")]);
    expect(chunks[0].loc).toBe("p.9");
    // 后续块要么继承（若来自同一个原子组的后续原子）要么为空；这里整篇只有一个原子源
    expect(chunks.slice(1).every((c) => c.loc === "")).toBe(true);
  });
});

describe("分块 · 重叠", () => {
  it("第二块起带上一块的**末尾**作为前缀，且不超过上限", () => {
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(longZh(120))]);
    expect(chunks.length).toBeGreaterThan(1);
    const prevTail = overlapTail(chunks[0].text, DEFAULT_CHUNK_POLICY.overlap);
    expect(prevTail.length).toBeGreaterThan(0);
    expect(chunks[1].text.startsWith(prevTail)).toBe(true);
  });

  it("第一块**没有**前缀（没有上一块可借）", () => {
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(longZh(120))]);
    expect(chunks[0].text.startsWith("第0段")).toBe(true);
  });

  it("重叠前缀尽量从边界起（不以半个词开头）", () => {
    // 纯拉丁：重叠应当从空格后开始，而不是切断一个词
    const latin = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(latin)]);
    const tail = chunks[1].text.slice(0, 8);
    expect(tail).toMatch(/^word\d/); // 从一个完整词开始
  });

  it("overlap = 0 时行为退化：无前缀（策略是可设的，不是写死的）", () => {
    const p = { ...DEFAULT_CHUNK_POLICY, overlap: 0 };
    const chunks = chunkSegments({ kind: "attachment", attId: "a" }, [seg(longZh(120))], p);
    expect(chunks[1].text.startsWith("第")).toBe(true); // 直接从正文开始
  });
});

describe("分块 · 确定性（缓存与回链都依赖它）", () => {
  it("同一输入连切两次，结果深度相等", () => {
    const segs = [seg(longZh(60), "p.1"), seg("补充说明。", "p.2")];
    const a = chunkSegments({ kind: "attachment", attId: "a" }, segs);
    const b = chunkSegments({ kind: "attachment", attId: "a" }, segs);
    expect(a).toEqual(b);
  });

  it("**id 随 ord 稳定** ⇒ 源文本没变时 id 不变（块嵌入因此能复用）", () => {
    const before = chunkSegments({ kind: "attachment", attId: "a" }, [seg("第一段。")]);
    const after = chunkSegments({ kind: "attachment", attId: "a" }, [seg("第一段。")]);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].hash).toBe(before[0].hash);
  });

  it("内容变了 hash 就变（这就是「要不要重算嵌入」的判据）", () => {
    const a = chunkSegments({ kind: "attachment", attId: "a" }, [seg("第一版内容。")]);
    const b = chunkSegments({ kind: "attachment", attId: "a" }, [seg("第二版内容。")]);
    expect(b[0].hash).not.toBe(a[0].hash);
    expect(b[0].id).toBe(a[0].id); // id 只跟 ord 走
  });
});

describe("分块 · 页面路径", () => {
  it("标题只挂在**第一块**（每块都挂会让标题在向量里反复出现、并被摊薄）", () => {
    const chunks = chunkText({ kind: "page", pageId: "p1" }, longZh(120), "差旅报销制度");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.startsWith("差旅报销制度\n")).toBe(true);
    expect(chunks[1].text.includes("差旅报销制度")).toBe(false);
  });

  it("空正文 ⇒ 没有块（不是一块空文本）", () => {
    expect(chunkText({ kind: "page", pageId: "p1" }, "   ", "标题")).toEqual([]);
  });
});

describe("语言记录（**只记录，目前不改变策略** —— §13 第 5 项未拍板）", () => {
  it("中文为主 ⇒ zh；拉丁为主 ⇒ latin；认不出来 ⇒ 空（不猜）", () => {
    expect(detectLang("这是一段中文说明文字。")).toBe("zh");
    expect(detectLang("this is an english paragraph")).toBe("latin");
    expect(detectLang("12345 —— 6789")).toBe("");
  });
});

describe("块存储（真 sqlite）", () => {
  it("整体替换 + 按 ord 取回", async () => {
    const store = await realStore();
    const chunks = chunkSegments({ kind: "attachment", attId: "a1" }, [seg(longZh(80), "p.1")]);
    store.replace({ kind: "attachment", attId: "a1" }, chunks);
    const back = store.chunksOf({ kind: "attachment", attId: "a1" });
    expect(back.map((c) => c.ord)).toEqual(chunks.map((c) => c.ord));
    expect(back.map((c) => c.text)).toEqual(chunks.map((c) => c.text));
  });

  it("**重切不会留下孤儿行**：新块更少时，多出来的旧行必须被删掉", async () => {
    const store = await realStore();
    const owner = { kind: "attachment" as const, attId: "a1" };
    store.replace(owner, chunkSegments(owner, [seg(longZh(200))]));
    const many = store.stats().chunks;
    store.replace(owner, chunkSegments(owner, [seg("只有一句话。")]));
    expect(store.stats().chunks).toBe(1);
    expect(many).toBeGreaterThan(1);
  });

  it("页面块与附件块互不干扰（同一个库里两种 owner 共存）", async () => {
    const store = await realStore();
    store.replace({ kind: "attachment", attId: "a1" }, chunkSegments({ kind: "attachment", attId: "a1" }, [seg("附件文本。")]));
    store.replace({ kind: "page", pageId: "p1" }, chunkText({ kind: "page", pageId: "p1" }, "页面正文。"));
    expect(store.chunksOf({ kind: "attachment", attId: "a1" }).map((c) => c.text)).toEqual(["附件文本。"]);
    expect(store.chunksOf({ kind: "page", pageId: "p1" }).map((c) => c.text)).toEqual(["页面正文。"]);
    expect(store.chunksOf({ kind: "attachment", attId: "p1" })).toHaveLength(0); // att 与 page 的 id 空间不混
  });

  it("remove 清空该 owner", async () => {
    const store = await realStore();
    const owner = { kind: "page" as const, pageId: "p9" };
    store.replace(owner, chunkText(owner, "一些正文。"));
    store.remove(owner);
    expect(store.chunksOf(owner)).toHaveLength(0);
  });
});

describe("哈希口径统一（防「两处实现漂移」）", () => {
  it("分块用的 `fnv1a32` 与既有 `embedHash` **逐字一致**", () => {
    for (const s of ["", "abc", "第⼀段中文", "mixed 中英 123"]) {
      expect(fnv1a32(s)).toBe(embedHash(s));
    }
  });
});
