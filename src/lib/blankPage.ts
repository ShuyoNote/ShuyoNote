// 「这一页到底有没有内容」—— 唯一出处（`App.tsx` 用它决定要不要显示**新页面引导** ✓）。
//
// ⚠️ **2026-10-06 改口径**（owner 实测：「指引内容没有了」；⚠️ 这里刻意不写出那个列名 —— `check-doc-content-access` 把**注释里**的列名也算一处直接引用 ✓）：
//   旧口径是 `root.children.length > 0` —— 而**编辑器一打开/自动保存**就把空文档写成
//   "一个空段落" ⇒ 新建页面**立刻**被判成"有内容" ⇒ **引导根本不出现** ✗。
//   本机真 Chromium 复现：Ctrl+N 之后 0.6s / 3.6s 都读不到 `.new-page-guide` ✓；
//   库里那行也对得上（`新页面` 的落盘形态 = `children=1` 的空段落 ✓）。
//
// 新口径：**有没有真内容** —— 下面两条**任一**成立才算"有内容"：
//   ① 存在**非空白文字**的 `text` 节点；
//   ② 存在**不属于"空壳"类型**的块（图片 / 表格 / 嵌入 / 绘图 / 公式 / 分栏 / 水平线… 都算命中有物 ✓）。
// ⇒ 这保住了老注释里那条要求：**只有图片/嵌入/表格**的页面正文文本是空的，但它**有内容**，
//   不该显示引导 ✓。
//
// ⛔ 只走 `children` —— 与 `lexicalValidate` / `blockIdentity` 同一条纪律 ✓：
//   非节点数组（如 `imageRow.items`）**不当节点走**；那些靠 **type** 判
//   （`imageRow` ∉ 空壳 ⇒ 算有内容 ✓），所以不需要递归进那种数组 ✓。
/** 这些类型**本身不算内容**（只有它们、且文字全空白 ⇒ 这一页就是空的）。 */
const EMPTY_SHELL_TYPES = new Set<string>([
  "root",
  "paragraph",
  "shuyo-paragraph",
  "heading",
  "shuyo-heading",
  "quote",
  "shuyo-quote",
  "list",
  "shuyo-list",
  "listitem",
  "code",
  "shuyo-code",
  "code-highlight",
  "text",
  "linebreak",
  "tab",
]);

/**
 * 这一页有没有内容（`true` ⇒ **不**显示新页面引导）。
 *
 * ⚠️ 解析不出 JSON 时返回"**有内容**"（非空即真）：决不能让一个坏文档被当成空页 ——
 *    那会让引导盖在用户真实内容上 ✗（宁可少显示引导，也不许误判成空页）。
 */
export function hasBlockContent(docJson: string): boolean {
  if (!docJson) return false;
  let root: unknown;
  try {
    root = (JSON.parse(docJson) as { root?: unknown } | null)?.root;
  } catch {
    return docJson.trim().length > 0;
  }
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string" && n.text.trim() !== "") return true;
    const type = typeof n.type === "string" ? n.type : "";
    if (type && !EMPTY_SHELL_TYPES.has(type)) return true;
    const children = n.children;
    return Array.isArray(children) && children.some(walk);
  };
  return walk(root);
}
