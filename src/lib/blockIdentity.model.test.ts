// 「块身份」这一层与**真编辑器**的接口判据（不是纯函数测，走 `EDITOR_NODES` + 真 Lexical）。
//
// 纯函数那一份判据在 `blockIdentity.test.ts`；这一份钉的是**接线是否真的成立**：
//   · 内存模型里段落确实是 `shuyo-paragraph`（= 节点类注册对了、`importJSON` 读到了声明字段）；
//   · **写出去**的产物里一个模型 type 都不许有（否则旧版本客户端会把整块丢掉 = 段落全丢）；
//   · 老形态与新形态**同一个编辑器里共存**（迁移可以分批，不用一次性全换）。
//
// 为什么不用 DOM：`createEditor` 在 Node 下就能 parse/toJSON（仓库里 `markdownCjkImport.test.ts` 同套路）。

import { describe, expect, it } from "vitest";
import { createEditor } from "lexical";

import { EDITOR_NODES } from "../editor/config";
import { topLevelBlockIds, toLegacyDoc, toModelDoc } from "./blockIdentity";

const text = (t: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: t, type: "text", version: 1 });
const paragraph = (t: string, blockId?: string) => ({
  ...(blockId === undefined ? {} : { blockId }),
  children: [text(t)],
  direction: "ltr",
  format: "",
  indent: 0,
  type: "paragraph",
  version: 1,
});
const doc = (children: unknown[]) =>
  JSON.stringify({ root: { children, direction: "ltr", format: "", indent: 0, type: "root", version: 1 } });

/** 与 `markdownCjkImport.test.ts` 同一套路：真编辑器、真节点集。 */
function parseWithEditor(json: string) {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "block-id-model-test" });
  editor.setEditorState(editor.parseEditorState(json));
  return editor.getEditorState().toJSON() as { root: { children: Array<Record<string, unknown>> } };
}

let seq = 0;
const deterministicId = () => `blk-${++seq}`;

describe("内存模型（真编辑器 + 真节点集）", () => {
  it("节点集里注册了模型类型，且老类型仍可用（两类共存）", () => {
    const types = EDITOR_NODES.map((n) => n.getType());
    expect(types).toContain("shuyo-paragraph");
    // 老段落是 Lexical 默认注册的，不该被我们顶掉 —— 否则老文档直接打不开
    const legacyOut = parseWithEditor(doc([paragraph("老段落", "old-1")]));
    expect(legacyOut.root.children[0].type).toBe("paragraph");
  });

  it("★ 模型形态：段落是 `shuyo-paragraph`，且**带着声明字段 `blockId`**", () => {
    const model = toModelDoc(doc([paragraph("甲", "blk-keep")]), deterministicId);
    const out = parseWithEditor(model);
    expect(out.root.children[0].type).toBe("shuyo-paragraph");
    expect(out.root.children[0].blockId).toBe("blk-keep"); // 已有 ID 不被换掉
  });

  it("★ 写出去必须是老形态：产物里**一个模型 type 都没有**", () => {
    const model = toModelDoc(doc([paragraph("甲", "blk-keep")]), deterministicId);
    const inMemory = JSON.stringify(parseWithEditor(model));
    expect(inMemory).toContain("shuyo-paragraph"); // 内存里确实是模型形态

    const wire = toLegacyDoc(inMemory);
    expect(wire).not.toContain("shuyo-paragraph");
    const wireOut = JSON.parse(wire);
    expect(wireOut.root.children[0].type).toBe("paragraph"); // 还原成老类型
    expect(wireOut.root.children[0].blockId).toBe("blk-keep"); // 块 ID 还在（今天的落盘形态本来就带它）
    expect(wireOut.root.children[0].children[0].text).toBe("甲"); // 文字没动
  });

  it("没有块 ID 的老文档：进模型时逐个补种（顶层才补，顺序对应）", () => {
    const model = toModelDoc(doc([paragraph("一"), paragraph("二")]), deterministicId);
    expect(topLevelBlockIds(model)).toEqual(["blk-1", "blk-2"]);
    const out = parseWithEditor(model);
    expect(out.root.children.map((c) => c.blockId)).toEqual(["blk-1", "blk-2"]);
  });
});
