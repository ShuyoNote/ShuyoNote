// 冲刺 S4b-1b 的判据：**远端状态怎么落地**（注入点 ＋ 同步路径只认签名）。
//
// 为什么要有这一组：同步路径（`web.ts`）会被 **Node 侧脚本**加载，所以它不许 import 带编辑器节点表的
// 实现（2026-09-23 那次初始化环就是这么炸的）⇒ 只能注入。注入点的两条纪律必须被钉住：
// **没注册 ⇒ 如实抛**（吞掉远端那一版就是丢更新）、**注册了 ⇒ 原样交给实现**。
import { describe, expect, it } from "vitest";
import { applyRemoteCrdtState, setCrdtRemoteApplier } from "./plane";
import { mergeRemotePageState } from "./pageBinding";
import { readPageCrdtState, type ContentSql } from "../docContent";
import { openPageSession } from "./yDocBridge";

/** 只认 `page_crdt` 三条 SQL 的极简库。 */
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

/** 一份**带块身份**的最小页面（桥接层"不造身份"⇒ 样本必须自带 id）。 */
const SAMPLE =
  '{"root":{"type":"root","version":1,"children":[{"type":"paragraph","blockId":"b1","children":[]}]}}';

describe("冲刺 S4b-1b：远端状态的落地（注入）", () => {
  // ⚠️ 顺序有意义：这一条必须在**任何注册之前**跑（注册是模块级状态，注册过就回不去了）。
  it("① 没注册落地实现 ⇒ **如实抛**（吞掉远端那一版＝丢更新，不许静默）", () => {
    const { db } = fakeDb();
    expect(() => applyRemoteCrdtState(db, "p1", new Uint8Array([1, 2, 3]))).toThrow(/没有注册落地实现/);
  });

  it("② 注册之后 ⇒ 原样交给实现：`(db, pageId, state)` 三个都传到位", () => {
    const { db } = fakeDb();
    const calls: Array<{ pageId: string; n: number }> = [];
    setCrdtRemoteApplier((d, pageId, state) => {
      calls.push({ pageId, n: state.length });
      // 实现拿到的确实是我们传进去的那个库（同一个引用）
      expect(d).toBe(db);
    });
    applyRemoteCrdtState(db, "p1", new Uint8Array([7, 8]));
    expect(calls).toEqual([{ pageId: "p1", n: 2 }]);
  });

  it("③ 集成：注册**真实现**（`mergeRemotePageState`）⇒ 远端那一版真的落进本机", () => {
    const { db } = fakeDb();
    setCrdtRemoteApplier((d, pageId, state) => mergeRemotePageState(d, pageId, state, 1));

    const remote = openPageSession({ json: SAMPLE }).exportState();
    applyRemoteCrdtState(db, "p1", remote);

    // 本机原先没有 ⇒ **采用**它（逐字节相同），不是"从 JSON 重建"
    const stored = readPageCrdtState(db, "p1")!;
    expect(Array.from(stored)).toEqual(Array.from(remote));
  });
});
