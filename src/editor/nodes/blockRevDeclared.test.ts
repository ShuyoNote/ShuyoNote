// **声明式 `blockRev`** 的节点级判据（内建镜像 7 类 ＋ 自有节点样板 formula）。
//
// 钉住四件事（与 `src/lib/blockRev.test.ts` 那份**纯 JSON 层**的判据分工不同：这份要真节点）：
//   1. **有值才写**：`blockRev` 为 `null` ⇒ 落盘 JSON 里**不许出现这个字段**（缺字段 ≠ 0，
//      判定层据此区分"老客户端产物"与"有身份但没改过"）；
//   2. **往返**：`importJSON`/`exportJSON`（CRDT 绑定就靠这两个）把 rev 带过去；
//   3. **克隆路径**：`markDirty()` 会让 Lexical 克隆一次节点 —— 声明字段不能在那条路上丢
//      （块 ID 那边踩过同款：改个对齐就把身份丢了）；
//   4. **老形态兼容**：落盘 JSON 里**没有** `blockRev` ⇒ 读成"没有"（不是 0），再写出去仍然不写这个字段。
//
// ⚠️ **两条自己踩过的坑**（写在这里免得后人再花一遍时间）：
//   · 任何节点工厂都必须在 `editor.update()` 里调（在外面调抛 `Unable to find an active editor`）；
//   · **别指望"空根 + 装饰节点"**：把 formula 这类 DecoratorNode 单独 append 进空根，Lexical 的
//     根规范化会把它**包进一个段落**（`paragraph` 是内建类型，没有块身份）⇒ 直接读 `root.children[0]`
//     会读到那个包装段落，看上去像"rev 没写出去"。本文件因此**递归找**目标 type（并且第 1、4 条
//     干脆不挂根，直接读 `exportJSON()`）—— 与块身份那边记的"判据别用空根+装饰节点"同一条纪律。
//
// ⚠️ 下一片还要接**自有节点其余 10 类**（callout/mermaid/imageRow/image/video/blockembed/
// webbookmark/attachment-ref/drawing/columnsBlock）：表格 `MODEL_NODE_TABLE` 加行即可
// （与块身份那边"清单与判据共用一份"同一做法）。

import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { EDITOR_NODES } from "../config";
import { $createBlockParagraphNode, BLOCK_PARAGRAPH_TYPE } from "./BlockParagraphNode";
import { $createBlockHeadingNode, BLOCK_HEADING_TYPE } from "./BlockHeadingNode";
import { $createBlockQuoteNode, BLOCK_QUOTE_TYPE } from "./BlockQuoteNode";
import { $createBlockListNode, BLOCK_LIST_TYPE } from "./BlockListNode";
import { $createBlockCodeNode, BLOCK_CODE_TYPE } from "./BlockCodeNode";
import { $createBlockHorizontalRuleNode, BLOCK_HORIZONTAL_RULE_TYPE } from "./BlockHorizontalRuleNode";
import { $createBlockTableNode, BLOCK_TABLE_TYPE } from "./BlockTableNode";
import { $createFormulaNode } from "./FormulaNode";
import { $createCalloutNode } from "./CalloutNode";
import { $createMermaidNode } from "./MermaidNode";
import { $createImageRowNode } from "./ImageRowNode";
import { $createImageNode } from "./ImageNode";
import { $createVideoNode } from "./VideoNode";
import { $createBlockEmbedNode } from "./BlockEmbedNode";
import { $createWebBookmarkNode } from "./WebBookmarkNode";
import { $createAttachmentRefNode } from "./AttachmentRefNode";
import { $createDrawingNode } from "./DrawingNode";
import { $createColumnsBlockNode } from "./ColumnsBlockNode";

function newEditor(): LexicalEditor {
  return createEditor({ nodes: EDITOR_NODES, namespace: "block-rev-declared-test" });
}

type Json = Record<string, unknown>;
type RevCarrier = LexicalNode & { getBlockRev(): number | null; setBlockRev(rev: number | null): void };

/**
 * 已接入**声明式 `blockRev`** 的模型节点 —— **全部 18 类**（内建镜像 7 ＋ 自有 11）。
 *
 * 与块身份那边同一条纪律：**清单与判据共用一份** —— 新增一类只在这里加一行，漏接就当场红。
 */
const MODEL_NODE_TABLE: Array<{ label: string; type: string; make: () => LexicalNode }> = [
  // 内建镜像 7 类（新 type ＋ 两形态映射那条路）
  { label: "段落", type: BLOCK_PARAGRAPH_TYPE, make: () => $createBlockParagraphNode("blk-1") },
  { label: "标题", type: BLOCK_HEADING_TYPE, make: () => $createBlockHeadingNode("h2", "blk-1") },
  { label: "引用", type: BLOCK_QUOTE_TYPE, make: () => $createBlockQuoteNode("blk-1") },
  { label: "列表", type: BLOCK_LIST_TYPE, make: () => $createBlockListNode("bullet", 1, "blk-1") },
  { label: "代码块", type: BLOCK_CODE_TYPE, make: () => $createBlockCodeNode("javascript", "blk-1") },
  { label: "水平线", type: BLOCK_HORIZONTAL_RULE_TYPE, make: () => $createBlockHorizontalRuleNode("blk-1") },
  { label: "表格", type: BLOCK_TABLE_TYPE, make: () => $createBlockTableNode("blk-1") },
  // 自有节点 11 类（"类就是类型"那条轻路）
  { label: "callout", type: "callout", make: () => $createCalloutNode("blk-1") },
  { label: "公式", type: "formula", make: () => $createFormulaNode("x^2", "blk-1") },
  { label: "mermaid", type: "mermaid", make: () => $createMermaidNode("graph TD", "flowchart", "blk-1") },
  { label: "图片行", type: "imageRow", make: () => $createImageRowNode([{ src: "a.png", alt: "a" }], "blk-1") },
  { label: "图片", type: "image", make: () => $createImageNode("a.png", "a", false, null, null, null, null, "blk-1") },
  { label: "视频", type: "video", make: () => $createVideoNode("v.mp4", null, null, "blk-1") },
  { label: "块嵌入", type: "blockembed", make: () => $createBlockEmbedNode("target-1", "blk-1") },
  {
    label: "网页书签",
    type: "webbookmark",
    make: () => $createWebBookmarkNode("https://a.example", "t", "d", "s.example", "", "", "blk-1"),
  },
  {
    label: "附件引用",
    type: "attachment-ref",
    make: () => $createAttachmentRefNode("att-1", "f.pdf", 12, "application/pdf", "", "", "blk-1"),
  },
  {
    label: "绘图",
    type: "drawing",
    make: () => $createDrawingNode(null, null, null, null, "", null, null, null, null, null, "blk-1"),
  },
  { label: "分栏", type: "columnsBlock", make: () => $createColumnsBlockNode([], [], "blk-1") },
];

/** 在导出 JSON 里**递归**找某个 model type 的节点（根规范化可能把装饰节点包进段落）。 */
function findNode(root: Json | undefined, type: string): Json | undefined {
  if (!root) return undefined;
  if (root.type === type) return root;
  const children = root.children;
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    const hit = findNode(child as Json, type);
    if (hit) return hit;
  }
  return undefined;
}

const exportedOf = (editor: LexicalEditor): Json =>
  (editor.getEditorState().toJSON() as { root: Json }).root;

/** 在 `editor.update` 里造一个节点并读它的 `exportJSON()` —— **不挂根**（避开根规范化）。 */
function exportedNodeJson(make: () => LexicalNode, rev: number | null): Json {
  const editor = newEditor();
  let json: Json = {};
  editor.update(
    () => {
      const node = make();
      if (rev !== null) (node as RevCarrier).setBlockRev(rev);
      json = node.exportJSON() as Json;
    },
    { discrete: true },
  );
  return json;
}

/** 把一个块放进编辑器（`rev` = `null` 表示"不设"，即老形态）。 */
function seed(editor: LexicalEditor, make: () => LexicalNode, rev: number | null): void {
  editor.update(
    () => {
      // 先放一个**内建**段落打底（真编辑器里装饰节点从不与"空根"同时出现）。
      const filler = $createParagraphNode();
      filler.append($createTextNode("打底"));
      $getRoot().append(filler);

      const node = make();
      if (node.getType() === BLOCK_PARAGRAPH_TYPE) {
        (node as unknown as { append(child: LexicalNode): void }).append($createTextNode("内容"));
      }
      $getRoot().append(node);
      // ⚠️ rev 在**挂进编辑器之后**再写：新建（还没进编辑器状态）时 `getWritable()` 的克隆
      // 语义与挂进去之后不同，判据要在"真编辑器里"的那条路径上验。
      if (rev !== null) (node as RevCarrier).setBlockRev(rev);
    },
    { discrete: true },
  );
}

/** 在**活着的编辑器状态**里按 type 递归找节点（更新闭包内用）。 */
function findLive(node: LexicalNode, type: string): LexicalNode | null {
  if (node.getType() === type) return node;
  const kids = (node as unknown as { getChildren?: () => LexicalNode[] }).getChildren?.() ?? [];
  for (const kid of kids) {
    const hit = findLive(kid, type);
    if (hit) return hit;
  }
  return null;
}

const docWith = (child: Json): string =>
  JSON.stringify({
    root: { children: [child], direction: "ltr", format: "", indent: 0, type: "root", version: 1 },
  });

describe("声明式 blockRev（节点级）", () => {
  it("★ 有值才写：设了 rev ⇒ `exportJSON` 里有；没设（null）⇒ **不许出现这个字段**", () => {
    for (const entry of MODEL_NODE_TABLE) {
      expect(exportedNodeJson(entry.make, 7).blockRev, `${entry.label} 设了 rev 却没写出去`).toBe(7);
      expect(exportedNodeJson(entry.make, null), `${entry.label} 没有 rev 却写了字段（缺字段 ≠ 0）`).not.toHaveProperty(
        "blockRev",
      );
    }
  });

  it("★ 老形态兼容：落盘 JSON 里没有 `blockRev` ⇒ 读成「没有」（**不是 0**），再写出去仍不写字段", () => {
    for (const entry of MODEL_NODE_TABLE) {
      const legacy = exportedNodeJson(entry.make, null);
      expect(legacy, `${entry.label} 老形态里竟然有 blockRev`).not.toHaveProperty("blockRev");

      const editor = newEditor();
      editor.setEditorState(editor.parseEditorState(docWith(legacy)));
      const kid = findNode(exportedOf(editor), entry.type);
      expect(kid, `${entry.label} 解析后找不到节点`).toBeDefined();
      expect(kid, `${entry.label} 把"缺字段"读成了别的值`).not.toHaveProperty("blockRev");
    }
  });

  it("★ 往返：`exportJSON → importJSON` 把 rev 带过去（CRDT 绑定就靠这两个）", () => {
    for (const entry of MODEL_NODE_TABLE) {
      const once = exportedNodeJson(entry.make, 12);
      expect(once.blockRev, `${entry.label} 首次导出的 rev 不对`).toBe(12);

      const editor = newEditor();
      editor.setEditorState(editor.parseEditorState(docWith(once)));
      const kid = findNode(exportedOf(editor), entry.type);
      expect(kid?.blockRev, `${entry.label} 往返后 rev 丢了`).toBe(12);
    }
  });

  it("★ 克隆路径：`markDirty()`（Lexical 会克隆一次节点）之后，rev 不能丢", () => {
    for (const entry of MODEL_NODE_TABLE) {
      const editor = newEditor();
      seed(editor, entry.make, 5);
      editor.update(
        () => {
          // 精确标脏**被测那一个**节点（装饰节点可能被包在段落里，别只标根的直接子节点）
          findLive($getRoot(), entry.type)?.markDirty();
        },
        { discrete: true },
      );
      const kid = findNode(exportedOf(editor), entry.type);
      expect(kid?.blockRev, `${entry.label} 在克隆路径上把 rev 丢了`).toBe(5);
    }
  });

  it("声明字段进的是**节点模型**（`toJSON()` 与 `exportJSON()` 同一条路），不是 JSON 里的旁挂", () => {
    const editor = newEditor();
    seed(editor, () => $createBlockParagraphNode("blk-model"), 3);
    const kid = findNode(exportedOf(editor), BLOCK_PARAGRAPH_TYPE);
    expect(kid?.type).toBe(BLOCK_PARAGRAPH_TYPE);
    expect(kid?.blockId).toBe("blk-model");
    expect(kid?.blockRev).toBe(3);
  });
});
