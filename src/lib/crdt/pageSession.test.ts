// 冲刺切片 **S2** 的判据：一页的 CRDT 状态能不能**载入—编辑—存回—合并**。
//
// 与 `mergeability.test.ts` 的分工：
//   · 那边证的是"**从 JSON 新建**的两份状态**不可合**"（红线，架构不许走那条路）；
//   · 这边证的是"**载入既有血统**"这条唯一可走的路真的能：① 两处编辑合并后**两处都在**、
//     ② 载入复用**不翻倍**、③ 反复存回/合并**收敛**。
//
// 样本一律用真编辑器搭（`$create*` ＋ `toJSON()`），不手写节点 schema。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import { openPageSession, yDocToContentJson } from "./yDocBridge";

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-page-session-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build(editor);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

const idsOf = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<{ blockId?: string }> } }).root.children.map(
    (c) => c.blockId ?? "-",
  );

/** 两段的基线页（块身份由"保存路径"那一步铸：这里用 `withIds` 代它）。 */
const BASE = withIds(
  buildJson(() => {
    const p1 = $createBlockParagraphNode("blk-1");
    p1.append($createTextNode("第一段"));
    const p2 = $createBlockParagraphNode("blk-2");
    p2.append($createTextNode("第二段"));
    $getRoot().append(p1, p2);
  }),
);

describe("冲刺 S2：一页的 CRDT 状态（载入—编辑—存回—合并）", () => {
  it("① ★ 承重：同血统两台设备各加一块 ⇒ 合并后**两处都在**、不重复、两侧收敛", () => {
    const a = openPageSession({ json: BASE }); // 设备 A：首次落盘 ⇒ 建血统
    const s0 = a.exportState();
    const b = openPageSession({ state: s0 }); // 设备 B：**载入同一条血统**

    a.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("A 加的"));
      $getRoot().append(p);
    });
    b.edit(() => {
      const p = $createBlockParagraphNode("blk-B");
      p.append($createTextNode("B 加的"));
      $getRoot().append(p);
    });

    // 互相收到对方那一笔（合并 = 交换状态）
    const aState = a.exportState();
    const bState = b.exportState();
    a.merge(bState);
    b.merge(aState);

    const ai = idsOf(a.exportJson());
    const bi = idsOf(b.exportJson());
    console.log(`【① 实测】A 侧 = ${JSON.stringify(ai)}　B 侧 = ${JSON.stringify(bi)}`);

    expect(new Set(ai).size).toBe(ai.length); // 没有重复块（S1 反例的症状）
    expect(new Set(bi).size).toBe(bi.length);
    expect([...ai].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]); // 两处都在，没丢块
    expect([...bi].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]);
    expect(ai).toEqual(bi); // ★ 两侧**顺序也收敛**（CRDT 的保证，不是"碰巧一样"）
  });

  it("② 载入复用**不翻倍**（对照：S1 的'从 JSON 各建一次'会翻倍）", () => {
    const s0 = openPageSession({ json: BASE }).exportState();
    const x = openPageSession({ state: s0 }).exportState();
    const y = openPageSession({ state: s0 }).exportState();

    const merged = new Y.Doc();
    Y.applyUpdate(merged, x);
    Y.applyUpdate(merged, y);
    const ids = idsOf(yDocToContentJson(Y.encodeStateAsUpdate(merged)));
    console.log(`【② 实测】两份"载入复用"状态合并后 = ${JSON.stringify(ids)}`);
    expect(ids).toEqual(["blk-1", "blk-2"]); // 不翻倍
  });

  it("③ 收敛：存回→载入⇒投影不变；合并自己⇒幂等（反复保存不改内容）", () => {
    const s = openPageSession({ json: BASE });
    const st1 = s.exportState();
    const j1 = s.exportJson();

    const s2 = openPageSession({ state: st1 });
    expect(s2.exportJson()).toBe(j1); // 载入回来 ⇒ 投影一模一样
    s2.merge(st1); // 把自己的状态合并进去
    expect(s2.exportJson()).toBe(j1); // 幂等
    expect(idsOf(s2.exportJson())).toEqual(["blk-1", "blk-2"]);
  });

  it("④ 会话与纯函数路径**同源**：`exportJson()` == `yDocToContentJson(exportState())`", () => {
    const s = openPageSession({ json: BASE });
    expect(s.exportJson()).toBe(yDocToContentJson(s.exportState()));
    s.edit(() => {
      const p = $createBlockParagraphNode("blk-3");
      p.append($createTextNode("第三段"));
      $getRoot().append(p);
    });
    expect(s.exportJson()).toBe(yDocToContentJson(s.exportState()));
    expect(idsOf(s.exportJson())).toEqual(["blk-1", "blk-2", "blk-3"]);
  });

  it("⑤ 口径沿用：没给 state/json ⇒ 抛；JSON 里有顶层块缺 `blockId` ⇒ 抛（本层不造身份）", () => {
    expect(() => openPageSession({})).toThrow(/必须给 state/);
    expect(() =>
      openPageSession({ json: '{"root":{"type":"root","version":1,"children":[{"type":"paragraph","children":[]}]}}' }),
    ).toThrow(/不造身份/);
  });

  // ---------------------------------------------------------------------------------------
  // S3：**活绑定**（本地编辑 → yjs 接成常驻监听；回声由 `COLLABORATION_TAG` 挡住）。
  // 这三条是"S3 真的接上了没有"的证据 —— 少了它们，"活绑定"只是一句注释。
  // ---------------------------------------------------------------------------------------

  it("⑥ ★ 回声安全：来回合并**三轮**不增殖（既没回声循环、也没重复块）", () => {
    const a = openPageSession({ json: BASE });
    const b = openPageSession({ state: a.exportState() });

    a.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("A"));
      $getRoot().append(p);
    });
    b.edit(() => {
      const p = $createBlockParagraphNode("blk-B");
      p.append($createTextNode("B"));
      $getRoot().append(p);
    });

    for (let round = 0; round < 3; round += 1) {
      a.merge(b.exportState());
      b.merge(a.exportState());
    }

    const ai = idsOf(a.exportJson());
    const bi = idsOf(b.exportJson());
    console.log(`【⑥ 实测】三轮互合后 = ${JSON.stringify(ai)}`);
    expect(new Set(ai).size).toBe(ai.length); // 没有回声造出来的重复块
    expect(ai).toEqual(bi); // 两侧仍然一致
    expect([...ai].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]);
  });

  it("⑦ ★ 活绑定真的写进了 doc：`edit()` 之后**另一个会话**从状态打开就能看到", () => {
    const s = openPageSession({ json: BASE });
    s.edit(() => {
      const p = $createBlockParagraphNode("blk-live");
      p.append($createTextNode("活绑定写的"));
      $getRoot().append(p);
    });

    // 没有手动同步调用 —— 全靠常驻监听把它推进 doc
    const other = openPageSession({ state: s.exportState() });
    expect(idsOf(other.exportJson())).toEqual(["blk-1", "blk-2", "blk-live"]);
    expect(other.exportJson()).toContain("活绑定写的");
  });

  it("⑧ `dispose()` 撤掉常驻监听之后，编辑**不再**进 doc（否则 dispose 是假的）", () => {
    const s = openPageSession({ json: BASE });
    const before = s.exportState();
    s.dispose();
    s.edit(() => {
      const p = $createBlockParagraphNode("blk-after-dispose");
      p.append($createTextNode("不该进 doc"));
      $getRoot().append(p);
    });

    // 状态没变（编辑没被推给 yjs）—— 用"另一个会话看不到它"来证
    const other = openPageSession({ state: s.exportState() });
    expect(idsOf(other.exportJson())).toEqual(["blk-1", "blk-2"]);
    expect(idsOf(yDocToContentJson(before))).toEqual(["blk-1", "blk-2"]);
  });
});
