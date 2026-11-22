// A1 G0 判据：
//   ① kill switch 解析（默认开；只有显式 0/false/off 才关）；
//   ② 开关关掉 ⇒ 不合并、保留本机（真实调用，不是 source grep）；
//   ③ 合并抛错 ⇒ 保本机 + `mergeFailed`（⛔ 不把坏状态写进库）；
//   ④ 接线（源码级）：开关/失败字段/用户提示都在。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPageCrdtState, type ContentSql } from "../docContent";
import * as Y from "yjs";
import { mergeRemotePageState, a1AutoMergeEnabledFrom } from "./pageBinding";

function fakeDb() {
  const rows = new Map<string, Uint8Array>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        rows.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/DELETE FROM page_crdt/.test(sql)) {
        rows.delete(String(params[0]));
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) return;
      if (/UPDATE pages SET content_json = \?/.test(sql)) return;
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const s = rows.get(String((params ?? [])[0]));
        return s ? [{ state: s }] : [];
      }
      return [];
    },
  };
  return { db: db as unknown as ContentSql, rows };
}

/** 一页合法的初始 CRDT 状态（空文档也行；关键是它是一条真血统）。 */
function initialState(): Uint8Array {
  const d = new Y.Doc();
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

describe("A1 G0", () => {
  it("kill switch：默认开，只有显式 0/false/off 才关", () => {
    expect(a1AutoMergeEnabledFrom(undefined)).toBe(true);
    expect(a1AutoMergeEnabledFrom("1")).toBe(true);
    expect(a1AutoMergeEnabledFrom("true")).toBe(true);
    for (const v of ["0", "false", "off", " OFF "]) expect(a1AutoMergeEnabledFrom(v)).toBe(false);
  });

  it("开关关掉：不写库、保留本机、标 disabled", () => {
    const { db, rows } = fakeDb();
    const localState = initialState();
    rows.set("p1", localState);
    const before = readPageCrdtState(db, "p1");

    const res = mergeRemotePageState(db, "p1", localState, 1, false);
    expect(res.disabled).toBe(true);
    expect(res.adopted).toBe(false);
    expect(res.mergeFailed).toBeUndefined();
    expect(readPageCrdtState(db, "p1")).toEqual(before);
  });

  it("合并抛错：保本机 + mergeFailed（坏字节不落库）", () => {
    const { db, rows } = fakeDb();
    const localState = initialState();
    rows.set("p1", localState);
    const before = readPageCrdtState(db, "p1");

    const res = mergeRemotePageState(db, "p1", new Uint8Array([9, 9, 9, 9]), 1, true);
    expect(res.mergeFailed).toBe(true);
    expect(res.adopted).toBe(false);
    expect(readPageCrdtState(db, "p1")).toEqual(before);
  });

  it("接线：开关、失败字段、用户提示都在", () => {
    const root = process.cwd();
    const pageBinding = readFileSync(resolve(root, "src/lib/crdt/pageBinding.ts"), "utf8");
    const main = readFileSync(resolve(root, "src/main.tsx"), "utf8");
    expect(pageBinding).toContain("VITE_CRDT_A1");
    expect(pageBinding).toContain("mergeFailed");
    expect(main).toContain("res.mergeFailed");
  });
});
