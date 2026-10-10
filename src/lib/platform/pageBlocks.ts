/**
 * 「顶层块」提取 —— `get_page_blocks` 的**唯一实现**（web 平台 ✓）。
 *
 * ⚠️ 为什么单独一个模块：这样它**能被单测钉住** ✓（`pageBlocks.test.ts` ✓）。
 * 在那之前这段逻辑埋在 `web.ts` 的平台执行器里 ⇒ 只能靠**起浏览器跑真流程**才验得到 ✗，
 * 而它恰恰是**04 阅读屏唯一的正文来源** ✓ —— 2026-10-10 就是这样漏掉了一个用户可见的错 ✗：
 * 它对**有正文的页**返回空数组，屏上于是显示「这一页还没有内容」✗。
 *
 * ## 契约（`PageBlock`，与 Rust `blocks.rs` 的 `PageBlock` 同形 ✓）
 * `{ block_id: string; text: string }`，**只列顶层块** ✓。
 *
 * ## ⭐ 2026-10-10 修的根因（逐字读数，不是推断）
 * 旧实现要求顶层块**必须有 `blockId` 字段**才收（`filter((c) => topBlockId(c))` ✗）。
 * 而**真实存下来的文档里，普通页面的顶层块根本没有 `blockId`** ✗ —— 实测一条刚建好的页：
 * ```
 * root.children.length = 1                                   ← 正文**在** ✓
 * root.children[0] 的键 = [children, direction, format, indent, type, version, textFormat, textStyle]
 *                                                            ← **没有 blockId** ✗
 * ```
 * ⇒ 过滤后 **`[]`** ✗（Rust 侧 `blocks.rs:256` 的 `child.get("blockId")` 是**同一个假设** ⇒ 同病 ✗）。
 * `blockId` 只在**被块引用/嵌入**时才存在（见 `src/lib/blockIdentity.ts`）⇒ 拿它当"有没有正文"的
 * 判据是**把可选字段当必填** ✗。
 *
 * ⇒ 现在：**有 `blockId` 就用它** ✓，没有就按**位置**给一个稳定回退 id ✓
 *   （`block-<下标>` —— 读屏只拿它当 React key；⛔ 它**不是**可引用的块 id ✗，别拿它去 `resolve_block` ✗）。
 */

function parseJson(text: string): any {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { root: { children: [] } };
  }
}

function rootChildren(v: any): any[] {
  return Array.isArray(v?.root?.children) ? v.root.children : [];
}

function nodeText(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(nodeText).join("");
  return "";
}

function topBlockId(node: any): string {
  return typeof node?.blockId === "string" ? node.blockId : "";
}

export interface PageBlockLike {
  block_id: string;
  text: string;
}

/** 把**序列化后的 Lexical 文档**取成顶层块列表 ✓（空文本的块不收 —— 只列"有内容的块" ✓）。 */
export function pageBlocksFromDoc(jsonText: string): PageBlockLike[] {
  const v = parseJson(jsonText);
  return rootChildren(v)
    .map((c, i) => ({
      // ⭐ 有 `blockId` 就用它（那是**可引用**的真 id ✓）；没有就按**位置**给回退 id ✓，
      //    ⛔ 绝不因为"没有 blockId"就把这一块**丢掉** ✗ —— 那正是修前那个用户可见的错 ✓。
      block_id: topBlockId(c) || `block-${i}`,
      text: nodeText(c).trim(),
    }))
    .filter((b) => b.text.length > 0);
}
