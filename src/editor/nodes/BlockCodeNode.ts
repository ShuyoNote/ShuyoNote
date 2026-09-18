// 块级「代码块」节点：**新 type**（`shuyo-code`）＋ **声明的** `blockId`。
//
// ## 为什么继承 `SafeCodeNode` 而不是 `CodeNode`
//
// `SafeCodeNode` 是应用为修 `@lexical/code@0.49` 的 `insertNewAfter` 崩溃而写的补丁类
// （回车跳出代码块）。继承它 = 那个修复继续生效。
//
// ## ⚠️ 顺带解掉 `SafeCodeNode` 埋着的一颗雷
//
// `SafeCodeNode` 用的是**同 type**（仍是 `"code"`）子类 —— 它今天能用，**只因为** `src/` 里
// 没有任何地方调 `$createCodeNode()`（我 grep 过：零处）。而同 type 子类 + 内建工厂在 Lexical 0.50
// 会抛 `Type code in node CodeNode does not match registered node SafeCodeNode`（spike 实测过同一现象）。
// ⇒ 给代码块加块身份时**正好走"新 type"这条正路**：`BlockCodeNode` 是 `shuyo-code`，
// 老的 `SafeCodeNode`（`code`）继续注册着以读老内容；新内容一律是 `shuyo-code`。
//
// 纪律同前：**本类只活在编辑器里**，写出去先过 `toLegacyDoc()`（还原成 `code`）。

import type { NodeKey } from "lexical";
import { type SerializedCodeNode } from "@lexical/code";

import { SafeCodeNode } from "./SafeCodeNode";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"code"`）。 */
export const BLOCK_CODE_TYPE = "shuyo-code";

export interface SerializedBlockCodeNode extends SerializedCodeNode {
  blockId?: string;
}

export class BlockCodeNode extends SafeCodeNode {
  __blockId: string;

  static getType(): string {
    return BLOCK_CODE_TYPE;
  }

  static clone(node: BlockCodeNode): BlockCodeNode {
    const language = (node as unknown as { __language?: string }).__language;
    return new BlockCodeNode(language, node.__blockId, node.__key);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockCodeNode {
    const s = serializedNode as unknown as SerializedBlockCodeNode;
    const node = $createBlockCodeNode((s.language as string | undefined) ?? "javascript", s.blockId ?? "");
    node.setFormat(s.format);
    node.setIndent(s.indent);
    node.setDirection(s.direction);
    return node;
  }

  constructor(language?: string, blockId?: string, key?: NodeKey) {
    super(language ?? "javascript", key);
    this.__blockId = blockId ?? "";
  }

  /** 0.50 的克隆路径之一；声明字段不能丢（段落那边立过同款判据）。 */
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as BlockCodeNode).__blockId;
  }

  exportJSON(): SerializedBlockCodeNode {
    const json = super.exportJSON() as SerializedBlockCodeNode;
    // 空 ID 不写字段（嵌套代码块不给身份，别给落盘形态添噪音）。
    return this.__blockId ? { ...json, blockId: this.__blockId } : json;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }
}

export function $createBlockCodeNode(language?: string, blockId?: string, key?: NodeKey): BlockCodeNode {
  return new BlockCodeNode(language, blockId, key);
}

export function $isBlockCodeNode(node: unknown): node is BlockCodeNode {
  return node instanceof BlockCodeNode;
}
