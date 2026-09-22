// 临时探针（AMD，跑完即删）v2：验**应用自己的** `SHUYONOTE_TRANSFORMERS` 导出，在「块 ID 字段丢了」之后
// 会不会受影响 —— Windows 在 `crdt-spike-q2-second-slice` §四 标为「未测，必须在 Web/桌面侧做」的那一格。
//
// v1 的三个观测错误（留痕，免得下一个人重踩）：
//   ① 我把 `BlockEmbedNode` 塞进段落里 ⇒ `BLOCK_EMBED` 是 **ElementTransformer**，只认顶层元素 ⇒ 永远导不出；
//   ② 我假设"抹掉 `blockId` 字段 ⇒ 引用消失" —— 对 `BlockRefNode` **不成立**（它的 id 在文本里）；
//   ③ `toLegacyDoc` 那次我用内建 `$createParagraphNode` 建段落，而这个编辑器**没注册块 ID 变换**
//      ⇒ 段落从来没有 id，legacy 里当然是空的。
import { $convertToMarkdownString } from "@lexical/markdown";
import { $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vitest";

import { newBlockId, toLegacyDoc } from "../lib/blockIdentity";
import { EDITOR_NODES } from "./config";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { $createBlockEmbedNode } from "./nodes/BlockEmbedNode";
import { $createBlockParagraphNode } from "./nodes/BlockParagraphNode";
import { $createBlockRefNode } from "./nodes/BlockRefNode";

const REF = "11111111-1111-4111-8111-111111111111";
const EMB = "22222222-2222-4222-8222-222222222222";

const makeEditor = () =>
  createEditor({
    nodes: EDITOR_NODES,
    namespace: "amd-md-export-probe2",
    onError: (e) => {
      throw e;
    },
  });

/** 顶层：模型段落（含块引用）＋ 顶层块嵌入。 */
function buildDoc(editor: ReturnType<typeof makeEditor>, paraId: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createBlockParagraphNode(paraId);
      p.append($createTextNode("见 "));
      p.append($createBlockRefNode(REF));
      p.append($createTextNode(" 与下面的嵌入"));
      root.append(p);
      root.append($createBlockEmbedNode(EMB));
    },
    { discrete: true },
  );
}

const mdOf = (json: string) => {
  const editor = makeEditor();
  editor.setEditorState(editor.parseEditorState(json));
  return editor.getEditorState().read(() => $convertToMarkdownString(SHUYONOTE_TRANSFORMERS));
};

describe("SHUYONOTE_TRANSFORMERS：块引用/嵌入导出（blockId 丢失的影响面）", () => {
  it("(A) 基线：blockId 在 ⇒ 导出里有块引用与块嵌入", () => {
    const editor = makeEditor();
    buildDoc(editor, newBlockId());
    const md = editor.getEditorState().read(() => $convertToMarkdownString(SHUYONOTE_TRANSFORMERS));
    console.log("MD(A):", JSON.stringify(md));
    expect(md).toContain(`((${REF}))`);
    expect(md).toContain(`{{${EMB}`);
  });

  it("★ (B) 抹掉节点的 `blockId` 字段（= 绑定丢声明字段）后，导出还看不看得出差别", () => {
    const editor = makeEditor();
    buildDoc(editor, newBlockId());
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const stripped = JSON.stringify(JSON.parse(json, (k, v) => (k === "blockId" ? undefined : v)));
    const mdA = mdOf(json);
    const mdB = mdOf(stripped);
    console.log("MD(A):", JSON.stringify(mdA));
    console.log("MD(B):", JSON.stringify(mdB));
    console.log("差异:", mdA === mdB ? "无（导出看不出）" : "有");
    expect(mdB).toContain(`((${REF}))`);
    expect(mdB).toContain(`{{${EMB}`);
    expect(stripped).not.toContain('"blockId"');
  });

  it("★ 上游：模型段落 w/ id → `toLegacyDoc` 之后 id 仍在（Rust 块表/FTS 的输入不受影响）", () => {
    const id = newBlockId();
    const editor = makeEditor();
    buildDoc(editor, id);
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const legacy = toLegacyDoc(json);
    const parsed = JSON.parse(legacy) as { root: { children: Array<Record<string, unknown>> } };
    const ids: string[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      const node = n as { blockId?: unknown; children?: unknown[] };
      if (typeof node.blockId === "string") ids.push(node.blockId);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    parsed.root.children.forEach(walk);
    console.log("MODEL id = [" + id + "]  LEGACY ids:", JSON.stringify(ids));
    expect(ids).toContain(id);
    expect(JSON.stringify(parsed)).not.toContain("shuyo-paragraph");
  });
});
