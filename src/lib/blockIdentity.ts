// **块身份**这一层：编辑器内存模型（新 type ＋ 声明字段）⇄ 落盘/同步形态（今天的 `type: "paragraph"` ＋ `blockId` 字段）。
//
// ## 为什么必须有两形态
//
// · CRDT 绑定只同步**节点模型**（`exportJSON`）⇒ `blockId` 必须是**声明的节点属性**，段落得是**新 type**
//   （同 type 子类化内建节点在 Lexical 0.50 会抛错，实测见 `spike/crdt/a1-output.txt`）；
// · 但新 type **不能落到落盘/同步的 JSON** 上：旧版本客户端的 `lexicalValidate.sanitizeChildren(…, allowedTypes)`
//   会**丢掉所有未注册类型** ⇒ 混版本期间读到 `shuyo-paragraph` = **段落全丢**（比"块 ID 漂移"严重得多）。
//
// ⇒ 内存/CRDT 用新形态，**写出去之前**一律经 `toLegacyDoc()` 还原。
// 决定记录与分步计划：`docs/plans/2026-09-18-crdt-block-id-ownership.md`。
//
// ## 这一层是**纯函数**，所以能本机全量验证
//
// 不碰 DOM、不碰编辑器实例、不碰数据库：给 JSON 字符串、还 JSON 字符串。
// ⇒ 属性测试可以直接钉住"两形态互转是可逆的""补种是幂等的""老文档一个字节都不变"。

/** 老 type → 模型 type（只收**块级**类型；嵌套的行内节点不动）。 */
export const MODEL_TYPE_BY_LEGACY: Readonly<Record<string, string>> = {
  paragraph: "shuyo-paragraph",
};

/** 模型 type → 老 type（`toLegacyDoc` 用）。 */
export const LEGACY_TYPE_BY_MODEL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MODEL_TYPE_BY_LEGACY).map(([legacy, model]) => [model, legacy]),
);

/** 只需要"造一个块 ID"这一个能力（注入进来，便于测试确定化）。 */
export type MakeBlockId = () => string;

/**
 * 走一遍节点树，对**每个**遇到的对象节点做一件事。
 *
 * 只走 `children`（与 `lexicalValidate` 同一条纪律）：非节点数组（如 ImageRow 的 `items`）**不碰**，
 * 否则会把数据数组里的对象误当节点改写。
 */
function walkNodes(root: unknown, visit: (node: Record<string, unknown>, depth: number) => void, depth = 0): void {
  if (!root || typeof root !== "object") return;
  const node = root as Record<string, unknown>;
  if (typeof node.type === "string") visit(node, depth);
  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) walkNodes(child, visit, depth + 1);
  }
}

/** 解析成文档对象；解析不出来或没有 `root` 对象 ⇒ `null`（调用方原样返回输入，绝不抛）。 */
function parseDoc(contentJson: string): { root: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = (parsed as Record<string, unknown> | null)?.root;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    return { root: root as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * 落盘/同步形态 → **编辑器内存模型**。
 *
 * 1. 把 `MODEL_TYPE_BY_LEGACY` 里的老 type 逐层换成模型 type；
 * 2. **顶层块**（`root.children`）没有 `blockId` 或为空 ⇒ 用 `makeId()` 补一个（幂等：已有就不动）。
 *
 * ⚠️ 只给**顶层块**补 ID —— 与今天 `serializeWithBlockIds` 的语义一致（它只遍历 `root.getChildren()`）。
 * 嵌套块（列表项里的段落、引用里的段落）今天本来就没有块 ID，别在这一层偷偷新增身份。
 *
 * 解析失败 / 没有 root ⇒ **原样返回输入**（这层在加载路径上，不能因为一条脏数据把页面打开变成崩）。
 */
export function toModelDoc(contentJson: string, makeId: MakeBlockId): string {
  const doc = parseDoc(contentJson);
  if (!doc) return contentJson;

  walkNodes(doc.root, (node) => {
    const model = MODEL_TYPE_BY_LEGACY[node.type as string];
    if (model) node.type = model;
  });

  const topChildren = doc.root.children;
  if (Array.isArray(topChildren)) {
    for (const child of topChildren) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const node = child as Record<string, unknown>;
      if (typeof node.type !== "string") continue;
      if (typeof node.blockId !== "string" || node.blockId.length === 0) {
        node.blockId = makeId();
      }
    }
  }

  return JSON.stringify(doc);
}

/**
 * **编辑器内存模型 → 落盘/同步形态**。
 *
 * 1. 模型 type 换回老 type（其余节点的 type 不动）；
 * 2. `blockId` **保留**（今天的落盘形态本来就带这个字段 —— 它由 `serializeWithBlockIds` 注入）。
 *
 * ⚠️ 这一层**不生成** ID：模型层没补上的 ID，说明那块还没进过内存模型，
 * 由保存路径原有的补种逻辑兜底（步骤 3 的活）。这层只做形态转换，不偷偷造身份。
 */
export function toLegacyDoc(contentJson: string): string {
  const doc = parseDoc(contentJson);
  if (!doc) return contentJson;

  walkNodes(doc.root, (node) => {
    const legacy = LEGACY_TYPE_BY_MODEL[node.type as string];
    if (legacy) node.type = legacy;
  });

  return JSON.stringify(doc);
}

/** 读一个块对象的 `blockId`（没有/非字符串 ⇒ `""`）。 */
export function readBlockId(node: unknown): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const id = (node as Record<string, unknown>).blockId;
  return typeof id === "string" ? id : "";
}

/** 顶层块的块 ID（按顺序；空位用 `""` 占位）—— 与 `Editor.tsx::extractSeedIds` 同义。 */
export function topLevelBlockIds(contentJson: string): string[] {
  const doc = parseDoc(contentJson);
  const children = doc?.root.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => readBlockId(child));
}
