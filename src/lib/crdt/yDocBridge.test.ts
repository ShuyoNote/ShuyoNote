// 阶段 2 · Slice A 的判据：`content_json` ⇄ `ydoc` 的往返保真与边界。
//
// 样本一律**用真编辑器搭**（`$create*` ＋ `getEditorState().toJSON()`）——手写节点 schema 会写出
// "看起来像、其实非法"的 JSON，那样判据证明不了任何事（尖刺就是这么做的）。
// 判据全在 Node 侧 ⇒ Windows 也能自验（尖刺施工单 §末的那条取舍）。
import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { MODEL_TYPE_BY_LEGACY, toLegacyDoc, toModelDoc } from "../blockIdentity";
import { contentJsonToYDoc, roundTripContentJson, yDocToContentJson } from "./yDocBridge";

/** 用真编辑器搭一份**合法**的 Lexical JSON（模型形态：块级节点是 `shuyo-*` 新 type）。 */
function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-json-ydoc-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build(editor);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

/**
 * 落盘形态 ＋ **给每个顶层块一个确定性 id** —— 生产里这一步由保存路径的 `serializeWithBlockIds` 做，
 * 本层**不造身份**（缺 id 就报错，见 `yDocBridge.ts::modelJsonOf`）。
 */
function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) => (typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` }));
  return JSON.stringify(d);
}

const childTypes = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<Record<string, unknown>> } }).root.children.map((c) => c.type as string);
const childBlockIds = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<Record<string, unknown>> } }).root.children.map(
    (c) => (c.blockId ?? null) as string | null,
  );

describe("content_json ⇄ ydoc（阶段 2 Slice A 的唯一实现）", () => {
  it("① 往返保真：段落＋行内格式 / 标题 / 嵌套列表 / 代码块", () => {
    const json = withIds(
      buildJson(() => {
        const p = $createParagraphNode();
        const b = $createTextNode("粗体");
        b.toggleFormat("bold");
        p.append($createTextNode("普通 "), b);
        const h = $createHeadingNode("h1");
        h.append($createTextNode("一级标题"));
        const outer = $createListNode("bullet");
        const li1 = $createListItemNode();
        li1.append($createTextNode("第一项"));
        const inner = $createListNode("number");
        const li2 = $createListItemNode();
        li2.append($createTextNode("嵌套一"));
        inner.append(li2);
        li1.append(inner);
        outer.append(li1);
        const code = $createCodeNode();
        code.append($createTextNode("const x = 1;"));
        $getRoot().append(p, h, outer, code);
      }),
    );

    const out = roundTripContentJson(json);
    expect(childTypes(out)).toEqual(childTypes(json));
    for (const want of ["普通 ", "粗体", "一级标题", "第一项", "嵌套一", "const x = 1;"]) {
      expect(out).toContain(want);
    }
  });

  it("② 边界：`{}` / 无 root ⇒ **一个空段落**的规范空页（不是空 root）；不可解析 ⇒ **抛**（不静默）", () => {
    const empty = roundTripContentJson("{}");
    expect(JSON.parse(empty).root.type).toBe("root");
    // ★ 空页的规范形态是"一个空段落"：空 root 会被 `setEditorState` 当场拒绝（尖刺 §1.4① 实测）
    const kids = JSON.parse(empty).root.children as Array<{ type: string }>;
    expect(kids.length).toBe(1);
    expect(kids[0].type).toBe("paragraph");
    const noRoot = JSON.parse(roundTripContentJson('{"foo":1}')).root.children as unknown[];
    expect(noRoot.length).toBe(1);
    expect(() => roundTripContentJson("这不是 json")).toThrow(/不是可解析/);
  });

  it("③ 幂等：往返两次 = 往返一次（否则每次存取都在改内容）", () => {
    const json = withIds(
      buildJson(() => {
        const b1 = $createBlockParagraphNode("blk-a");
        b1.append($createTextNode("一"));
        const b2 = $createBlockParagraphNode("blk-b");
        b2.append($createTextNode("二"));
        $getRoot().append(b1, b2);
      }),
    );
    const once = roundTripContentJson(json);
    expect(roundTripContentJson(once)).toBe(once);
  });

  it("④ ★ `blockId` 穿过往返（尖刺 §1.2 的那条阻碍：块引用/反链会断）", () => {
    const json = withIds(
      buildJson(() => {
        const b1 = $createBlockParagraphNode("blk-1");
        b1.append($createTextNode("第一段"));
        const b2 = $createBlockParagraphNode("blk-2");
        b2.append($createTextNode("第二段"));
        $getRoot().append(b1, b2);
      }),
    );
    expect(childBlockIds(json)).toEqual(["blk-1", "blk-2"]);
    expect(childBlockIds(roundTripContentJson(json))).toEqual(["blk-1", "blk-2"]);
  });

  it("⑤ 两个函数能分开调（生产路径将来要按需分开走），且与壳同源", () => {
    const json = withIds(
      buildJson(() => {
        const p = $createParagraphNode();
        p.append($createTextNode("分开调"));
        $getRoot().append(p);
      }),
    );
    const { update } = contentJsonToYDoc(json);
    expect(update.length).toBeGreaterThan(0);
    expect(yDocToContentJson(update)).toBe(roundTripContentJson(json));
  });

  it("⑥ ★ 缺 `blockId` ⇒ **当场报错**，不偷偷铸身份（两设备各铸一套 ⇒ 同一块会被当成两块）", () => {
    const noIds = buildJson(() => {
      const p = $createParagraphNode();
      p.append($createTextNode("没身份"));
      $getRoot().append(p);
    });
    expect(() => roundTripContentJson(noIds)).toThrow(/不造身份/);
  });

  it("⑦ ★ `blockRev` 穿过往返（声明字段那一层 18 类接入的端到端读数）", () => {
    const json = withIds(
      buildJson(() => {
        const b = $createBlockParagraphNode("blk-r");
        b.append($createTextNode("带版本"));
        $getRoot().append(b);
      }),
    );
    // 把 rev 打进**落盘形态**（生产里由保存路径 `assignBlockRevs` 打；本层只搬运它）
    const withRev = JSON.stringify({
      root: {
        ...(JSON.parse(json) as { root: Record<string, unknown> }).root,
        children: (JSON.parse(json) as { root: { children: Array<Record<string, unknown>> } }).root.children.map((c) => ({
          ...c,
          blockRev: 7,
        })),
      },
    });
    const out = roundTripContentJson(withRev);
    expect(
      (JSON.parse(out) as { root: { children: Array<Record<string, unknown>> } }).root.children.map((c) => c.blockRev),
    ).toEqual([7]);
  });

  // ★ ⑧ 形态映射。这一条**第一版是我自己写错的**，记在这里免得再犯：`MODEL_TYPE_BY_LEGACY` 的
  //   键是 legacy、值是模型 type，我却把解构写成 `[model, legacy]` ⇒ 造出 `type: "shuyo-paragraph"`
  //   的"老形态"再要求它变回 `paragraph`，当然红。逐对打印过（7 对全对、反向表 7 个键齐全、
  //   `blockId` 全保住）之后按正确方向重写；写层 §5 说的"18 类"是**节点类**层面的声明字段覆盖，
  //   判据在 `src/editor/nodes/blockRevDeclared.test.ts`，两件事别混。
  it("⑧ 形态映射：7 对 legacy ⇄ 模型 type 都能来回，且已有身份时**不铸 id**", () => {
    const pairs = Object.entries(MODEL_TYPE_BY_LEGACY);
    expect(pairs.length).toBe(7);
    for (const [legacy, model] of pairs) {
      const one = JSON.stringify({
        root: { type: "root", version: 1, children: [{ type: legacy, version: 1, blockId: "x" }] },
      });
      const modeled = JSON.parse(toModelDoc(one, () => "MINTED")) as {
        root: { children: Array<{ type: string; blockId?: string }> };
      };
      expect(modeled.root.children[0].type).toBe(model);
      // 已有身份 ⇒ `makeId` **不该被调用**（「本层不造身份」那条纪律的正面判据）
      expect(modeled.root.children[0].blockId).toBe("x");
      const back = JSON.parse(toLegacyDoc(toModelDoc(one, () => "MINTED"))) as {
        root: { children: Array<{ type: string }> };
      };
      expect(back.root.children[0].type).toBe(legacy);
    }
  });
});
