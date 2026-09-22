// 把**内建**段落就地升级成「模型段落」（`shuyo-paragraph` + 声明的 `blockId`）。
//
// ## 为什么要这一步（第 3 步）
//
// 第 2 步只覆盖"**加载**已有的内容"：打开页面时 `toModelDoc` 把老段落换成模型类型、补上块 ID。
// 但会话里**新建**的块不是这么来的 —— 粘贴、markdown 导入、HTML 导入、空编辑器的第一个段落，
// 全都由 Lexical 的内建工厂（`$createParagraphNode`）造出来，是**老类型**、**没有声明字段**。
// 它们的块 ID 只能在保存时被注入 JSON（老行为），**要到下次加载才进模型** ⇒
// 在 CRDT 平面里这些块**没有稳定身份**（换 CRDT 后会重铸 ID、块引用会断）。第 3 步就是堵这个口。
//
// ## 为什么用「节点变换」而不是逐个改调用点
//
// 创建段落的调用点多且分散（粘贴、markdown、html、模板、插件…），逐个改**必漏**。
// 变换只有一处、且**对所有创建路径都生效**（含 Lexical 内部自己造的段落）。
//
// ## 为什么对「模型段落」不会反复触发
//
// 变换注册在内建 `ParagraphNode` 上（它以 `type = "paragraph"` 注册）；模型段的 `getType()`
// 是 `shuyo-paragraph` ⇒ **不在同一个 type 下**，不会被本变换再次命中。函数里再加一道
// `getType()` 守卫，读代码的人不用去猜 Lexical 的匹配规则。

import { ParagraphNode, type LexicalNode, type Klass } from "lexical";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode } from "@lexical/list";

import { newBlockId } from "../lib/blockIdentity";
import { $createBlockParagraphNode } from "./nodes/BlockParagraphNode";
import { $createBlockHeadingNode } from "./nodes/BlockHeadingNode";
import { $createBlockQuoteNode } from "./nodes/BlockQuoteNode";
import { $createBlockListNode } from "./nodes/BlockListNode";
import { $createBlockCodeNode } from "./nodes/BlockCodeNode";
import { SafeCodeNode } from "./nodes/SafeCodeNode";
import { $createBlockHorizontalRuleNode } from "./nodes/BlockHorizontalRuleNode";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $createBlockTableNode } from "./nodes/BlockTableNode";
import { TableNode } from "@lexical/table";
import { CalloutNode } from "./nodes/CalloutNode";
import { FormulaNode } from "./nodes/FormulaNode";
import { MermaidNode } from "./nodes/MermaidNode";
import { ImageRowNode } from "./nodes/ImageRowNode";
import { ImageNode } from "./nodes/ImageNode";
import { VideoNode } from "./nodes/VideoNode";
import { BlockEmbedNode } from "./nodes/BlockEmbedNode";
import { WebBookmarkNode } from "./nodes/WebBookmarkNode";
import { AttachmentRefNode } from "./nodes/AttachmentRefNode";
import { DrawingNode } from "./nodes/DrawingNode";
import { ColumnsBlockNode } from "./nodes/ColumnsBlockNode";

/**
 * 这个节点是不是**顶层块**（根的直接子节点）。
 *
 * 只有顶层块才有块身份（今天的 `serializeWithBlockIds` 也只遍历 `root.getChildren()`；
 * Rust 侧 `extract_block_ids` 同样只读顶层）。嵌套块（列表项/引用/分栏里的段落）升级**类型**
 * 但不给 ID —— 免得落盘形态里多出一片没用的 `blockId`。
 */
function isTopLevelBlock(
  node: ParagraphNode | HeadingNode | QuoteNode | ListNode | SafeCodeNode | HorizontalRuleNode | TableNode,
): boolean {
  const parent = node.getParent();
  return parent !== null && parent.getType() === "root";
}

/**
 * 内建段落 → 模型段落（**就地替换**，属性与子节点原样保留，新块拿到一个新的块 ID）。
 *
 * 已经是模型段的节点**不动**（它的 `blockId` 是已经稳定下来的身份，绝不能在编辑过程中重铸）。
 */
export function upgradeParagraphToBlockNode(node: ParagraphNode): void {
  if (node.getType() !== "paragraph") return; // 模型段（`shuyo-paragraph`）与其它子类都不碰
  const replacement = $createBlockParagraphNode(isTopLevelBlock(node) ? newBlockId() : "");
  // ⚠️ 0.50 的坑：`ElementNode.getFormat()` 返回的是**数字**（center = 2），
  //    而 `exportJSON().format` / `getFormatType()` 才是字符串 "center"。
  //    第一版抄了 `getFormat()` ⇒ 对齐样式在升级时**悄悄丢掉**（判据抓出来了）。
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  // 段落级的 textFormat/textStyle：**有子节点时** `ParagraphNode.exportJSON` 会按第一个文本子节点
  // 重新算（0.50 的兼容行为，见 Lexical #7971），所以这两个值只在**空段落**上才有意义 —— 仍要抄。
  replacement.setTextFormat(node.getTextFormat());
  replacement.setTextStyle(node.getTextStyle());
  // `true` = 连子节点一起搬过去（否则段落会变成空的，文字全丢）。
  node.replace(replacement, true);
}

/**
 * 内建**标题** → 模型标题（第 4 步的第一个类型）。
 *
 * 与段落同一个套路，但多一处注意：`HeadingNode` 的 tag（`h1`–`h6`）是**节点自己的状态**，
 * 必须原样带过去（否则 h2 会变成 h1）。
 */
export function upgradeHeadingToBlockNode(node: HeadingNode): void {
  if (node.getType() !== "heading") return; // 模型标题（`shuyo-heading`）不碰
  const replacement = $createBlockHeadingNode(node.getTag(), isTopLevelBlock(node) ? newBlockId() : "");
  // ⚠️ 对齐用 `getFormatType()`（字符串）；0.50 的 `getFormat()` 返回的是**数字**（踩过一次）。
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  replacement.setTextFormat(node.getTextFormat());
  replacement.setTextStyle(node.getTextStyle());
  node.replace(replacement, true);
}

/** 内建**引用** → 模型引用（第 4 步的第二个类型；`QuoteNode` 没有额外状态，所以最薄）。 */
export function upgradeQuoteToBlockNode(node: QuoteNode): void {
  if (node.getType() !== "quote") return; // 模型引用（`shuyo-quote`）不碰
  const replacement = $createBlockQuoteNode(isTopLevelBlock(node) ? newBlockId() : "");
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  node.replace(replacement, true);
}

/**
 * 内建**代码块** → 模型代码块（第 4 步第四个类型）。
 *
 * ⚠️ 变换注册在 `SafeCodeNode` 上（它的 type 是 `"code"`）；**语言**必须原样带过去
 * （`language` 决定高亮规则，抄漏了代码块会退回默认语言）。顺带说明：这一支正是
 * `SafeCodeNode` 那颗"同 type 子类"雷的解 —— 新内容从此走 `shuyo-code`，不再碰内建工厂。
 */
export function upgradeCodeToBlockNode(node: SafeCodeNode): void {
  if (node.getType() !== "code") return; // 模型代码块（`shuyo-code`）不碰
  const language = (node as unknown as { __language?: string }).__language ?? "javascript";
  const replacement = $createBlockCodeNode(language, isTopLevelBlock(node) ? newBlockId() : "");
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  node.replace(replacement, true);
}

/**
 * 内建**列表** → 模型列表（第 4 步第三个类型）。
 *
 * ⚠️ 三个状态一个都不能丢：`listType`（bullet/number/check）、`tag`（ul/ol）、`start`（编号起点）——
 * `$createBlockListNode` 会按 listType 推出 tag，`start` 要显式带过去，否则"从 5 开始编号"会变回 1。
 */
export function upgradeListToBlockNode(node: ListNode): void {
  if (node.getType() !== "list") return; // 模型列表（`shuyo-list`）不碰
  const replacement = $createBlockListNode(
    node.getListType() as "bullet" | "number" | "check",
    node.getStart(),
    isTopLevelBlock(node) ? newBlockId() : "",
  );
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  node.replace(replacement, true);
}

/** 内建**水平线** → 模型水平线（第 4 步第五个类型）。 */
export function upgradeHorizontalRuleToBlockNode(node: HorizontalRuleNode): void {
  if (node.getType() !== "horizontalrule") return; // 模型水平线不碰
  // ⚠️ 水平线是 **DecoratorNode**：既没有 format/indent/direction 可抄，
  // **也不能传 `includeChildren = true`** —— 那会抛
  // `includeChildren should only be true for ElementNodes`（诊断实测），整个 update 失败、root 变空。
  const replacement = $createBlockHorizontalRuleNode(isTopLevelBlock(node) ? newBlockId() : "");
  node.replace(replacement);
}

/**
 * 内建**表格** → 模型表格（第 4 步第六个类型）。
 *
 * ⚠️ **不要手抄表格状态**：`TableNode` 有 `rowStriping` / `frozenColumnCount` / `frozenRowCount` /
 * `colWidths`，而只有 `getRowStriping()` / `getColWidths()` 能读出来 —— 手抄必丢。
 * 正确做法：拿基类的 `exportJSON()` 让**基类的 `updateFromJSON`** 自己吃一遍（它就是为这件事存在的）。
 */
export function upgradeTableToBlockNode(node: TableNode): void {
  if (node.getType() !== "table") return; // 模型表格（`shuyo-table`）不碰
  const serialized = node.exportJSON();
  const replacement = $createBlockTableNode(isTopLevelBlock(node) ? newBlockId() : "");
  replacement.updateFromJSON(serialized as never);
  // 补一次通用字段（`updateFromJSON` 是否覆盖 format/indent/direction 取决于版本，双保险且幂等）。
  replacement.setFormat(node.getFormatType());
  replacement.setIndent(node.getIndent());
  replacement.setDirection(node.getDirection());
  node.replace(replacement, true);
}

/**
 * **自有节点**（应用自己写的类型）的块身份：**不需要新 type、也不需要映射** ——
 * 类就是类型，直接在类里加了声明字段即可；这里只负责给**新建的顶层块**补一个 ID。
 *
 * 为什么仍要一个变换：`$createXxxNode()` 造出来的节点 ID 是空的（不可能每个创建点都改），
 * 而"空 ID"意味着它在 CRDT 平面里没有稳定身份。挂一条变换、只认顶层块、且**只在空 ID 时**写
 * —— 幂等，不会把已有身份重铸。
 *
 * 形参收 `LexicalNode` + 鸭子类型：这样**任何一个**节点类都能直接注册进这条变换，
 * 而某个体忘了实现 `getBlockId`/`setBlockId` 时只是被跳过（不炸、不静默给错身份）。
 */
export function ensureBlockIdOnTopLevelNode(node: LexicalNode): void {
  const carrier = node as unknown as Partial<BlockIdCarrier>;
  if (typeof carrier.getBlockId !== "function" || typeof carrier.setBlockId !== "function") return;
  const parent = node.getParent();
  if (parent === null || parent.getType() !== "root") return; // 嵌套块不给身份
  if ((carrier.getBlockId as () => string)().length > 0) return; // 已有身份不重铸（也是出口条件）
  (carrier.setBlockId as (id: string) => void)(newBlockId());
}

/** 带块身份 API 的节点（自有节点在类里实现这三个即可）。 */
export interface BlockIdCarrier {
  getParent(): { getType(): string } | null;
  getBlockId(): string;
  setBlockId(id: string): void;
}

/**
 * **已接入块身份的自有节点**类型清单 —— 注册处（`BlockIdPlugin`）与判据都读它，
 * 避免"加了类忘了注册 / 忘了判据"。新增一类自有节点：类里加声明字段 → 这里加一行。
 */
export const SELF_OWNED_BLOCK_ID_NODE_TYPES: Array<Klass<LexicalNode>> = [
  CalloutNode,
  FormulaNode,
  MermaidNode,
  ImageRowNode,
  ImageNode,
  VideoNode,
  BlockEmbedNode,
  WebBookmarkNode,
  AttachmentRefNode,
  DrawingNode,
  ColumnsBlockNode,
];

