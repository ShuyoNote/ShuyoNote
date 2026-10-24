// ⭐ 2026-10-24：**0 字节的 `page_crdt` 状态 ＝ 没有状态**（真机 bug 的判据）。
//
// 现场（逐字）：编辑器弹 `CRDT 绑定失败：Unexpected end of array`。
// 真因：`adoptRemote()`（「采用对端那一版」）会写 `savePageState(pageId, new Uint8Array())` ——
//   那就是一行**0 字节**的状态；读回来时被当成"一份空状态"交给 lib0 ⇒ 解码器当场抛
//   `Unexpected end of array`（用户只看到一句看不懂的 toast）。
// 口径：0 字节（或空串）⇒ `null` ⇒ 调用方按"没有状态 ⇒ 从 JSON 播种"处理 ✓。
import { describe, expect, it } from "vitest";

import { readPageCrdtState, type ContentSql } from "../docContent";

/** 只认 `SELECT state FROM page_crdt` 的极简库（⛔ 不写任何东西）。 */
function dbWith(state: unknown): ContentSql {
  return {
    run() {
      throw new Error("这一格不该写库（readPageCrdtState 是纯读）");
    },
    query(sql: string) {
      if (/SELECT state FROM page_crdt/.test(sql)) return [{ state }];
      return [];
    },
  } as unknown as ContentSql;
}

describe("CRDT 状态：0 字节 ＝ 没有状态", () => {
  it("0 字节的 Uint8Array ⇒ null（⛔ 不交给解码器）", () => {
    expect(readPageCrdtState(dbWith(new Uint8Array(0)), "p1")).toBeNull();
  });

  it("空字符串（驱动按二进制串回来那种）⇒ 同样 null", () => {
    expect(readPageCrdtState(dbWith(""), "p1")).toBeNull();
  });

  it("非空状态 ⇒ 原样返回（这一格不能被这条修复改坏）", () => {
    const s = new Uint8Array([1, 2, 3]);
    expect(readPageCrdtState(dbWith(s), "p1")).toBe(s);
  });
});
