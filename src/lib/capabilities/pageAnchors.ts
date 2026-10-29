// `pages.get` 读面（P1，2026-10-29）的**块锚点**与 **rev** —— 纯函数，跨语言同口径。
//
// 桌面侧的同名实现是 `src-tauri/src/plugins.rs`（`block_end_offsets` / `annotated_window` /
// `page_rev`）。两侧**必须逐字一致**：外部 agent 读到的锚点与令牌不该因为"这次走 Web 还是桌面"
// 而不同；而这类漂移**没有任何编译期信号**。所以两侧共用同一份夹具
// `tests/pages-get-anchors-parity.json`，各自在自己的测试里跑
// （`pageAnchors.test.ts` / `plugins.rs` 的 `#[cfg(test)]`）——改一边而另一边没跟，夹具先红。
//
// 三条口径（与 Rust 侧一字不差）：
// 1. 位置一律按 **Unicode 码点**计数（与分页同一条口径，不是 UTF-16 码元）⇒ emoji 不会被算成 2；
// 2. 块边界取"该块**最后一个文本叶子**的结束"——块内非行内子节点之间是 `\n\n`（列表项之间就是），
//    所以**整串匹配必然落空**，只能按叶子顺序往后对齐（判据里的列表用例钉的就是这条）；
// 3. 锚点**只插在本次窗口里**，且**不改正文任何字符**（关掉开关时正文逐字节不变）。
import { sha256Hex } from "../dictionary/download";

/** 一个顶层块的结束位置（按 Unicode 码点计数）。 */
export interface BlockEnd {
  id: string;
  /** 块的结束位置（码点下标；= 最后一个文本叶子之后）。 */
  end: number;
}

/** 收一个节点下的**文本叶子**（与 Rust `collect_text_leaves` 同一规则）。 */
function collectTextLeaves(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: unknown; text?: unknown; children?: unknown };
  if (n.type === "text") {
    if (typeof n.text === "string" && n.text !== "") out.push(n.text);
    return;
  }
  if (n.type === "linebreak") {
    out.push("\n");
    return;
  }
  if (n.type === "tab") {
    out.push("\t");
    return;
  }
  if (Array.isArray(n.children)) for (const child of n.children) collectTextLeaves(child, out);
}

/**
 * 每个**有块 id 的顶层块**的结束位置（码点计）。
 *
 * 定位方式：把该块的文本叶子按文档顺序在正文里**逐片往后对齐**（从上一块的结束处开始找）；
 * 某片找不到就**跳过**（正文文本列可能还没重建，与 JSON 不是同一代）—— ⛔ 不猜位置：
 * 猜出来的锚点会指到别的块上，比没有更糟。没有块 id 的块给不了锚点，但照样推进游标。
 */
export function blockEndOffsets(docJson: string, text: string): BlockEnd[] {
  if (!docJson) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(docJson);
  } catch {
    return [];
  }
  const root = (doc as { root?: { children?: unknown } } | null)?.root;
  const children: unknown[] = root && Array.isArray(root.children) ? root.children : [];
  const out: BlockEnd[] = [];
  // 两个游标：`u16` 是正文里的 **UTF-16 码元**位置（`indexOf` 的口径），`chr` 是同一位置的码点位置。
  let u16 = 0;
  let chr = 0;
  for (const block of children) {
    const id =
      block && typeof block === "object" && typeof (block as { blockId?: unknown }).blockId === "string"
        ? ((block as { blockId: string }).blockId as string)
        : "";
    const leaves: string[] = [];
    collectTextLeaves(block, leaves);
    for (const leaf of leaves) {
      const at = text.indexOf(leaf, u16);
      if (at < 0) continue;
      chr += Array.from(text.slice(u16, at)).length + Array.from(leaf).length;
      u16 = at + leaf.length;
    }
    if (id !== "") out.push({ id, end: chr });
  }
  return out;
}

/**
 * 把块锚点**只插进本次窗口**（块尾落在窗口内的块才标注 —— 分页截断时⛔ 不给没返回的块加锚点）。
 *
 * 每个锚点一整行 HTML 注释 `<!-- b:<块 id> -->`，前面补一个空行；正文一个字不改。
 * 「上一窗刚好读到块尾」那一块（`end === start` 且不是第一窗）**不重复标注**。
 */
export function annotatedWindow(text: string, ends: readonly BlockEnd[], offset: number, limit: number): string {
  const cps = Array.from(text);
  const total = cps.length;
  const start = Math.min(offset, total);
  const end = Math.min(offset + limit, total);
  let out = "";
  let pos = start;
  for (const { id, end: at } of ends) {
    if (at < start || at > end) continue;
    if (at === start && start > 0) continue;
    if (at < pos) continue; // 防御：对齐算法保证单调，真乱序就跳过而不是乱插
    out += cps.slice(pos, at).join("");
    out += `\n\n<!-- b:${id} -->`;
    pos = at;
  }
  out += cps.slice(pos, end).join("");
  return out;
}

/**
 * `rev`：`<updated_at 毫秒>:<正文 JSON 的 sha256 前 8 位小写>` —— **乐观并发令牌**，
 * 不是时间戳语义（与 Rust `page_rev` 同一形状、同一算法）。
 *
 * 算不出（拿不到正文原文 / 拿不到更新时间）⇒ `null`：调用方**如实不带这个键**，⛔ 不编一个。
 * ⚠️ 空的正文原文**是能算的**（空串也有指纹）—— 只有"拿不到"才是算不出。
 */
export async function pageRev(updatedAt: unknown, docJson: unknown): Promise<string | null> {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  if (typeof docJson !== "string") return null;
  const hex = await sha256Hex(new TextEncoder().encode(docJson));
  return `${Math.trunc(updatedAt)}:${hex.slice(0, 8)}`;
}
