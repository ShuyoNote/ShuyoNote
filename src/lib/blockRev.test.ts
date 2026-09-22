// 「块版本」这一层的**行为级判据**（纯函数，不需要编辑器/DOM/数据库）。
//
// 钉住四件事：
//   1. `assignBlockRevs` 的逐块判定（未改保持 / 改了 maxSeen+1 / 新块 maxSeen+1 / 没身份不写）；
//   2. ★ 两条"**不是内容**"：`blockRev` 字段本身、以及对象的**键序** —— 它们判错会让本地旧内容
//      被当成"更新的"赢过远端真实的新编辑（静默丢更新）；
//   3. ★ **有身份 ⇒ 一定有 rev**（老块盖 0）—— 这条是阶段 1 的承诺（"两端改不同块 ⇒ 都保留、
//      不弹提示"）在本层成立的前提，第 11 条判据把它整个走一遍；
//   4. 脏输入不抛（这一层在保存路径上）。

import { describe, expect, it } from "vitest";

import { toLegacyDoc } from "./blockIdentity";
import { assignBlockRevs, canonicalContent, maxBlockRev, readTopLevelBlockRevs } from "./blockRev";

/** 一份文档（顶层就是这几个块）。 */
const doc = (...blocks: unknown[]) => JSON.stringify({ root: { children: blocks } });

/** 一个段落块（可带/不带 rev —— `undefined` = 字段不存在，`null` = 显式 null）。 */
const para = (blockId: string, text: string, rev?: number | null) => ({
  type: "paragraph",
  blockId,
  ...(rev === undefined ? {} : { blockRev: rev }),
  children: [{ type: "text", text }],
});

/** 读成 `{ blockId: rev }`（好断言）。 */
const revsOf = (json: string) =>
  Object.fromEntries(readTopLevelBlockRevs(json).map((b) => [b.blockId, b.rev]));

describe("blockRev.assignBlockRevs（rev 的写入口）", () => {
  it("未改的块：保持 baseline 上那个 rev（不是重新发一个）", () => {
    const prev = doc(para("b1", "没动", 5));
    const next = doc(para("b1", "没动"));
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b1: 5 });
  });

  it("★ 老块（baseline 也没见过 rev）⇒ 盖 0（「有身份 ⇒ 一定有 rev」）", () => {
    const prev = doc(para("b1", "老内容")); // 老客户端产物：没有 blockRev 字段
    const next = doc(para("b1", "老内容"));
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b1: 0 });
  });

  it("改了的那一块 ⇒ maxSeen + 1，其余不动", () => {
    const prev = doc(para("b1", "旧", 7), para("b2", "没动", 3));
    const next = doc(para("b1", "新"), para("b2", "没动"));
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b1: 8, b2: 3 });
  });

  it("新块 ⇒ maxSeen + 1；删掉的块不出现在产物里（本层不写墓碑）", () => {
    const prev = doc(para("b1", "留着", 2), para("b-gone", "被删了", 2));
    const next = doc(para("b1", "留着"), para("b-new", "新来的"));
    const out = revsOf(assignBlockRevs(prev, next));
    expect(out).toEqual({ b1: 2, "b-new": 3 });
    expect(out).not.toHaveProperty("b-gone");
  });

  it("没有身份（blockId 空/缺失）的块 ⇒ **不写** rev（不猜身份）", () => {
    const prev = doc(para("b1", "有身份", 1));
    const next = JSON.stringify({
      root: {
        children: [
          para("b1", "有身份"),
          { type: "paragraph", children: [{ type: "text", text: "还没补种身份" }] },
        ],
      },
    });
    const out = JSON.parse(assignBlockRevs(prev, next));
    expect(out.root.children[1]).not.toHaveProperty("blockRev");
  });

  it("★ rev 字段本身**不是内容**：next 缺 rev 但内容相同 ⇒ 判「未改」（否则每次保存 rev 都无脑涨）", () => {
    const prev = doc(para("b1", "一样", 4));
    const next = doc(para("b1", "一样")); // 例：还没带声明字段的节点类，序列化时会把这个字段丢掉
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b1: 4 });
  });

  it("★ 键序**不是内容**：键被打乱但内容相同 ⇒ 仍判「未改」（否则本地旧内容会被当成更新的）", () => {
    const prev = doc(para("b1", "一样", 4));
    const next = JSON.stringify({
      root: {
        children: [
          {
            children: [{ text: "一样", type: "text" }],
            blockId: "b1",
            type: "paragraph",
          },
        ],
      },
    });
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b1: 4 });
    // 规范化只给比较用：产物仍是原始键序（落盘形态不变）
    expect(assignBlockRevs(prev, next)).toContain('"blockId":"b1"');
  });

  it("maxSeen 取**两侧**的更大值：baseline 有 9 ⇒ 新块拿 10", () => {
    const prev = doc(para("b1", "旧", 9));
    const next = doc(para("b2", "全新的"));
    expect(revsOf(assignBlockRevs(prev, next))).toEqual({ b2: 10 });
  });

  it("幂等：把产物再喂一遍（baseline 与 next 都是产物）⇒ 一个字节都不变", () => {
    const prev = doc(para("b1", "旧", 2), para("b2", "没动", 2));
    const next = doc(para("b1", "新"), para("b2", "没动"));
    const once = assignBlockRevs(prev, next);
    expect(assignBlockRevs(once, once)).toBe(once);
  });

  it("脏输入不抛：非 JSON / 没有 root / children 不是数组 ⇒ 原样返回 next", () => {
    const prev = doc(para("b1", "x", 1));
    for (const bad of ["not json", "{}", '{"root":null}', '{"root":{"children":"nope"}}']) {
      expect(assignBlockRevs(prev, bad)).toBe(bad);
    }
    expect(assignBlockRevs("not json", doc(para("b1", "x")))).toContain("blockRev");
  });

  it("★ 阶段 1 的承诺在本层成立：两台设备各改**不同块** ⇒ 两边每个块都有 rev，各改的那块更大", () => {
    // 基线：一页两个块，都是老形态（没有 rev）
    const base = doc(para("b1", "原始一"), para("b2", "原始二"));

    // 设备 A：只改 b1
    const a = assignBlockRevs(base, doc(para("b1", "A 改的"), para("b2", "原始二")));
    // 设备 B：只改 b2
    const b = assignBlockRevs(base, doc(para("b1", "原始一"), para("b2", "B 改的")));

    expect(revsOf(a)).toEqual({ b1: 1, b2: 0 });
    expect(revsOf(b)).toEqual({ b1: 0, b2: 1 });

    // 合并表要的两件事（判定层在另一份实现里，这里只钉"输入长什么样"）：
    //   · 每个块**两侧都有 rev** ⇒ 不会落进"缺 rev ⇒ 冲突"（阶段 1 的核心场景不弹提示）；
    //   · 谁真改过，谁的 rev 更大 ⇒ 那一块取谁。
    const ar = revsOf(a);
    const br = revsOf(b);
    for (const id of ["b1", "b2"]) {
      expect(ar[id], `${id} 在 A 侧必须有 rev`).not.toBeNull();
      expect(br[id], `${id} 在 B 侧必须有 rev`).not.toBeNull();
    }
    expect(ar.b1!).toBeGreaterThan(br.b1!); // A 改过 b1
    expect(br.b2!).toBeGreaterThan(ar.b2!); // B 改过 b2
  });
});

describe("blockRev 的读与规范化", () => {
  it("blockRevOf 只认**非负整数**：字符串/对象/null/NaN/小数/负数 ⇒ null", () => {
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: "3" }))[0].rev).toBeNull();
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: null }))[0].rev).toBeNull();
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: Number.NaN }))[0].rev).toBeNull();
    // 与 Rust 侧 `block_rev_of` 同一口径：3.5 / -1 都按"缺失"处理（写进来的永远是非负整数）
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: 3.5 }))[0].rev).toBeNull();
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: -1 }))[0].rev).toBeNull();
    expect(readTopLevelBlockRevs(doc({ blockId: "b1", blockRev: 0 }))[0].rev).toBe(0);
  });

  it("maxBlockRev：读不出来 ⇒ 0；有 rev ⇒ 取最大", () => {
    expect(maxBlockRev("not json")).toBe(0);
    expect(maxBlockRev(doc(para("b1", "x")))).toBe(0);
    expect(maxBlockRev(doc(para("b1", "x", 3), para("b2", "y", 9)))).toBe(9);
  });

  it("canonicalContent：去 rev（任意层级）＋ 键排序", () => {
    expect(canonicalContent({ b: 1, a: { blockRev: 9, x: 1 } })).toBe(canonicalContent({ a: { x: 1 }, b: 1 }));
  });

  it("与两形态转换配合：`toLegacyDoc` 之后 rev 还在（那一层不吞未知字段）", () => {
    const model = JSON.stringify({
      root: { children: [{ type: "shuyo-paragraph", blockId: "b1", blockRev: 6, children: [] }] },
    });
    const legacy = toLegacyDoc(model);
    expect(legacy).toContain('"type":"paragraph"');
    expect(revsOf(legacy)).toEqual({ b1: 6 });
  });
});
