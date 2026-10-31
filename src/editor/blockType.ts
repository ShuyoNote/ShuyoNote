// 块类型（正文 / 标题 1–3）转换：给「选中文字 → 浮动工具条」的下拉控件用。
//
// 为什么需要它：工具条原来只有 B/I/U/S/`<>` 这些**行内**格式，用户选了整段想变标题只能
// 去斜杠菜单（要另起一行、且会换块 ID）。这里把「标题 ↔ 正文」做成对**选区涉及的块**操作：
//   · 保留块 ID（`((blockId))` 引用、CRDT 身份都不会断）；
//   · 保留块内文字与行内格式（只换外层节点类型）；
//   · 支持跨多个块（选区覆盖几块就转几块）。
//
// ⚠️ 只转「段落 / 标题」两类块；其它块（列表、代码、引用、分栏、表格…）不碰 ——
// 那类转换有各自的结构语义，不能用"换外层"糊弄过去。
import {
  $createPoint,
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import type { HeadingTagType } from "@lexical/rich-text";

import { $getInsertTargetBlock } from "./blockUtils";
import { $createBlockHeadingNode, $isBlockHeadingNode } from "./nodes/BlockHeadingNode";
import { $createBlockParagraphNode, $isBlockParagraphNode } from "./nodes/BlockParagraphNode";

export type BlockType = "p" | "h1" | "h2" | "h3";

/** 下拉选项（顺序即展示顺序；与斜杠菜单的「正文 / 标题 1–3」同名同序）。 */
export const BLOCK_TYPE_OPTIONS: Array<{ value: BlockType; label: string }> = [
  { value: "p", label: "正文" },
  { value: "h1", label: "标题 1" },
  { value: "h2", label: "标题 2" },
  { value: "h3", label: "标题 3" },
];

/** 只认这两类块：模型段落 / 模型标题（历史遗留的 `paragraph` / `heading` 也收，加载期会被升级）。 */
const CONVERTIBLE_TYPES = new Set(["shuyo-paragraph", "shuyo-heading", "paragraph", "heading"]);

function isConvertible(node: LexicalNode | null | undefined): node is ElementNode {
  if (!node || !$isElementNode(node)) return false;
  return CONVERTIBLE_TYPES.has(node.getType());
}

function blockIdOf(block: ElementNode): string {
  if ($isBlockParagraphNode(block) || $isBlockHeadingNode(block)) return block.getBlockId();
  return "";
}

/** 选中涉及的**可转换块**（按选区顺序去重；每块经 `$getInsertTargetBlock` ⇒ 分栏里的段落也能落到正确块）。 */
export function $selectedBlocksForType(selection: RangeSelection): ElementNode[] {
  const seen = new Set<string>();
  const out: ElementNode[] = [];
  const candidates: LexicalNode[] = [selection.anchor.getNode(), selection.focus.getNode(), ...selection.getNodes()];
  for (const node of candidates) {
    const block = $getInsertTargetBlock(node);
    if (!isConvertible(block) || seen.has(block.getKey())) continue;
    seen.add(block.getKey());
    out.push(block);
  }
  return out;
}

/** 当前块类型（选区锚点所在块）；标题 4–6 若出现，按 `h3` 显示（下拉只有 1–3）。 */
export function $blockTypeOf(node: LexicalNode | null | undefined): BlockType {
  const block = node ? $getInsertTargetBlock(node) : null;
  if (block && $isBlockHeadingNode(block)) {
    const tag = block.getTag();
    return tag === "h1" || tag === "h2" || tag === "h3" ? tag : "h3";
  }
  return "p";
}

/**
 * 把选区涉及的块转成 `target`。返回**实际改动了几块**（0 = 没有可转换的块/已是目标类型）。
 * ⚠️ 必须在 `editor.update(() => …)` 里调用；转换后**重新选中这些块的全部内容**（光标不会跑到别处）。
 */
export function $convertSelectedBlocksTo(selection: RangeSelection, target: BlockType): number {
  const blocks = $selectedBlocksForType(selection);
  if (blocks.length === 0) return 0;
  const converted: ElementNode[] = [];
  let changed = 0;
  for (const block of blocks) {
    if ($blockTypeOf(block) === target) {
      converted.push(block);
      continue;
    }
    const blockId = blockIdOf(block);
    const next =
      target === "p"
        ? $createBlockParagraphNode(blockId)
        : $createBlockHeadingNode(target as HeadingTagType, blockId);
    next.setFormat(block.getFormatType());
    next.setIndent(block.getIndent());
    next.setDirection(block.getDirection());
    for (const child of block.getChildren()) next.append(child);
    block.replace(next);
    converted.push(next);
    changed += 1;
  }
  if (changed > 0) {
    const first = converted[0];
    const last = converted[converted.length - 1];
    const range = $createRangeSelection();
    range.anchor = $createPoint(first.getKey(), 0, "element");
    range.focus = $createPoint(last.getKey(), last.getChildrenSize(), "element");
    $setSelection(range);
  }
  return changed;
}

/** 供判据用：根下所有可转换块（测试里不经过 DOM，直接读模型）。 */
export function $allConvertibleBlocks(): ElementNode[] {
  return $getRoot().getChildren().filter((n) => isConvertible(n));
}
