// 块级「段落」节点：**新 type**（`shuyo-paragraph`）＋ **声明的** `blockId`。
//
// ## 为什么要有这个类（而不是继续在保存时往 JSON 里塞 blockId）
//
// 今天块 ID 由 `Editor.tsx::serializeWithBlockIds` 在**序列化时**注入 JSON（`rootChildren[i].blockId = id`）。
// 换 CRDT 后，`@lexical/yjs` 只同步**节点模型**（走 `exportJSON`）⇒ 注入的字段**不进模型就会丢**：
// 实测往返后顶层块的 `blockId` 两处全丢（`spike/crdt/README.md` §1.2），
// 而块引用 `((blockId))`、嵌入 `{{blockId}}`、反链、AI 的块级编辑全靠它。
//
// ## 为什么是「新 type」而不是「同名子类」
//
// Lexical 0.50 下，子类化内建 `ParagraphNode` 并**沿用 type `"paragraph"`** 会让内建工厂炸：
// `Create node: Type paragraph in node ParagraphNode does not match registered node … with the same type`
// （`$createParagraphNode`、粘贴、markdown 转换器都在用内建工厂，绕不开）。
// 实测新 type 可行：`blockId` **穿过 CRDT 往返**，且与内建 `ParagraphNode` **可共存**（迁移可分批）。
// 证据：`spike/crdt/a1-blockid-declared-prop.mjs` / `a1-output.txt`。
//
// ## ⚠️ 这个 type **不许落到落盘/同步的 JSON 上**
//
// 旧版本客户端的 `lexicalValidate.sanitizeChildren(…, allowedTypes)` 会**丢掉所有未注册类型**
// ⇒ 混版本期间读到带 `shuyo-paragraph` 的文档 = **段落全丢**（比"块 ID 漂移"严重得多）。
// ⇒ 两形态严格分工（见 `docs/plans/2026-09-18-crdt-block-id-ownership.md` §3）：
//   · **内存模型 / CRDT 平面**：本类的 `shuyo-paragraph`；
//   · **落盘 / 同步 wire / 导出**：`toLegacyDoc()` 还原成 `type: "paragraph"` ＋ `blockId` 字段。
//
// 换句话说：**本类只活在编辑器里**。任何要写出去的地方，先过 `blockIdentity.toLegacyDoc()`。

import { newBlockId } from "../../lib/blockIdentity";
import { blockRevOf, withBlockRev } from "./blockIdHelpers";
import {
  $applyNodeReplacement,
  ParagraphNode,
  type NodeKey,
  type RangeSelection,
  type SerializedLexicalNode,
  type SerializedParagraphNode,
} from "lexical";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"paragraph"`）。 */
export const BLOCK_PARAGRAPH_TYPE = "shuyo-paragraph";

export interface SerializedBlockParagraphNode extends SerializedParagraphNode {
  /** 块 ID。空串表示"还没被补种"（加载时由 `toModelDoc` 补，见 `blockIdentity`）。 */
  blockId?: string;
  /** 块版本（Lamport 计数器）；**缺字段 = 老客户端产物**（它保存时会把这个字段剥掉）。 */
  blockRev?: number;
}

export class BlockParagraphNode extends ParagraphNode {
  __blockId: string;
  /**
   * **声明的**块版本 —— 与 `blockId` 同一条路（见 `docs/plans/2026-09-22-block-rev-write-layer.md`）：
   * 不做成声明字段，CRDT 绑定就会在往返时把它丢掉；`null` = 没有/不认识这个字段。
   */
  __blockRev: number | null;

  static getType(): string {
    return BLOCK_PARAGRAPH_TYPE;
  }

  static clone(node: BlockParagraphNode): BlockParagraphNode {
    return new BlockParagraphNode(node.__blockId, node.__key, node.__blockRev);
  }

  static importJSON(serializedNode: SerializedLexicalNode & Record<string, unknown>): BlockParagraphNode {
    // ⚠️ 形参类型必须与基类**同宽**（`SerializedLexicalNode & Record<string, unknown>`），
    // 否则 TS 报 TS2417（静态侧不兼容）。所以这里收宽类型、内部再收窄。
    const s = serializedNode as unknown as SerializedBlockParagraphNode;
    const node = $createBlockParagraphNode(s.blockId ?? "");
    node.setFormat(s.format);
    node.setIndent(s.indent);
    node.setDirection(s.direction);
    node.setTextFormat(s.textFormat ?? 0);
    node.setTextStyle(s.textStyle ?? "");
    node.setBlockRev(blockRevOf(s)); // 缺字段 ⇒ null（**不**当成 0）
    return node;
  }

  constructor(blockId?: string, key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__blockId = blockId ?? "";
    this.__blockRev = blockRev;
  }

  exportJSON(): SerializedBlockParagraphNode {
    const json = super.exportJSON() as SerializedBlockParagraphNode;
    // ⚠️ **空 ID 时不写这个字段**：今天的落盘形态里，只有**顶层块**才有 `blockId`
    //（`serializeWithBlockIds` 只遍历 `root.getChildren()`）。嵌套段落（列表项/引用/分栏里的）
    // 被变换升级成模型类型后会带一个空 ID —— 若照样写出去，落盘 JSON 就会多出一片
    // `"blockId": ""`，破坏"写出去的形态与今天一致"这条承诺（也让 diff/体积无谓变大）。
    // `blockRev` 同理：**没有值就不写**（缺失 ≠ 0，见 `withBlockRev`）。
    return withBlockRev(this.__blockId ? { ...json, blockId: this.__blockId } : json, this.__blockRev);
  }

  /** 读块 ID（外部一律经这里，别直接摸 `__blockId`）。 */
  getBlockId(): string {
    return this.__blockId;
  }

  /** 写块 ID。空串表示"请重新补种"。 */
  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  /** 读块版本（`null` = 没有/不认识这个字段）。 */
  getBlockRev(): number | null {
    return this.__blockRev;
  }

  /** 写块版本。 */
  setBlockRev(blockRev: number | null): void {
    const writable = this.getWritable();
    writable.__blockRev = blockRev;
  }

  /**
   * 回车分行产生的新块**也用本类**（否则新块又变回内建 `paragraph`，它的 ID 只能在保存时注入 ⇒ CRDT 下会漂）。
   *
   * 基类 `ParagraphNode.insertNewAfter` 返回的是**内建**段落类，所以这里**不让基类创建**，
   * 只复刻它的最小行为：新块插在当前块之后，必要时把光标放到新块开头。
   * （不采用"先调基类、再把结果替换成本类"——那会多一次结构变更，也多一步 undo。）
   */
  insertNewAfter(_selection: RangeSelection, restoreSelection = true): BlockParagraphNode {
    // ⚠️ **当场铸一个块 ID**（不是留空等保存时注入）：判据抓过这个洞 —— 留空的话，
    // 回车新建的块在 CRDT 平面里就没有稳定身份，只能等保存时补、下次加载才进模型。
    const newBlock = $createBlockParagraphNode(newBlockId());
    this.insertAfter(newBlock);
    if (restoreSelection) newBlock.selectStart();
    return newBlock;
  }
}

/** 工厂。**所有**新建段落都应经它（别用内建的 `$createParagraphNode`，那会产出老 type）。 */
export function $createBlockParagraphNode(blockId?: string, key?: NodeKey): BlockParagraphNode {
  return $applyNodeReplacement(new BlockParagraphNode(blockId, key));
}

/** 判断一个节点是不是本类（类型收窄用）。 */
export function $isBlockParagraphNode(node: unknown): node is BlockParagraphNode {
  return node instanceof BlockParagraphNode;
}
