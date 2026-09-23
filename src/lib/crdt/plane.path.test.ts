// Slice B 的两条**路径级**判据（施工单 §3 ①②③ 的落地版）。
//
// 为什么单独一个文件：这里要的是"**落库字节**"层面的证据，与 `crdt/plane.test.ts` 那种薄壳判据不同
// —— 前者证明"开关本身是恒等的"，这里证明"**整条读写路径**在关掉时一个字都没变"。
// 用一个极小的内存假库（只认 UPDATE/SELECT 两种形状），不依赖测试夹具，读起来一眼能对上是哪条。
import { describe, expect, it, beforeEach } from "vitest";
import { readAllContents, readContent, writeContent, type ContentSql, type DocContent } from "../docContent";
import { setCrdtPlaneEnabled } from "./plane";
import { roundTripContentJson } from "./contentJsonYDoc";

/** 极简内存库：够 `readContent` / `readAllContents` / `writeContent` 三条用（别扩成通用 mock）。 */
function fakeDb() {
  const rows = new Map<string, { id: string; title: string; content_json: string; content_text: string }>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/^\s*UPDATE pages/.test(sql)) {
        const [title, json, text, , id] = params as [string, string, string, number, string];
        rows.set(id, { id, title, content_json: json, content_text: text });
        return;
      }
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 40)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/WHERE id = \?/.test(sql)) {
        const r = rows.get(String((params ?? [])[0]));
        return r ? [r] : [];
      }
      return [...rows.values()];
    },
  };
  return { db: db as unknown as ContentSql, rows };
}

const SAMPLE: DocContent = {
  title: "页",
  json: '{"root":{"type":"root","version":1,"children":[{"type":"paragraph","blockId":"b1","children":[]}]}}',
  text: "正文",
};

describe("Slice B：开关接进读写路径之后", () => {
  beforeEach(() => setCrdtPlaneEnabled(false));

  it("① ★ 关着（默认）⇒ 落库的 `content_json` 与传入**逐字节相同**，读回来也原样", () => {
    const { db, rows } = fakeDb();
    writeContent(db, "p1", SAMPLE, 1);
    expect(rows.get("p1")!.content_json).toBe(SAMPLE.json); // 同一内容，逐字节
    const back = readContent(db, "p1");
    expect(back!.json).toBe(SAMPLE.json);
    expect(readAllContents(db)[0].json).toBe(SAMPLE.json);
  });

  it("② 开着 ⇒ 落库的是**往返后**的字节（允许不同），读回来仍是同一条内容", () => {
    const { db, rows } = fakeDb();
    setCrdtPlaneEnabled(true);
    writeContent(db, "p1", SAMPLE, 1);
    expect(rows.get("p1")!.content_json).toBe(roundTripContentJson(SAMPLE.json));
    // 内容层面：块身份没丢（这是"允许不同"的边界——只准形态不同，不准丢东西）
    expect(readContent(db, "p1")!.json).toContain('"blockId":"b1"');
    setCrdtPlaneEnabled(false);
  });

  it("③ ★ 切换开关**不改变已落盘内容**：关着写一版 → 开着读一遍再写回 → 落库字节不变", () => {
    const { db, rows } = fakeDb();
    writeContent(db, "p1", SAMPLE, 1);
    const before = rows.get("p1")!.content_json;

    setCrdtPlaneEnabled(true);
    const read = readContent(db, "p1")!;
    writeContent(db, "p1", read, 2);
    const afterPlane = rows.get("p1")!.content_json;

    setCrdtPlaneEnabled(false);
    const read2 = readContent(db, "p1")!;
    writeContent(db, "p1", read2, 3);

    // 允许"过一遍平面"把形态改写一次，但**关着再读再写**不允许再变（收敛）
    expect(rows.get("p1")!.content_json).toBe(afterPlane);
    expect(afterPlane).toBe(roundTripContentJson(before));
  });
});
