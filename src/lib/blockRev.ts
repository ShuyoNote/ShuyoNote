// 「块版本」这一层：`blockRev`（每块的 **Lamport 计数器**）的**读 / 定 / 写** —— 纯函数，JSON → JSON。
//
// 裁定（2026-09-20，所有者）与判定表：`docs/plans/2026-09-19-stage1-block-lww-readiness.md` §6/§7。
// 三条定死的：**(a)** 声明式 `blockRev`（Lamport、随落盘/同步的那份 JSON 走）；**(iii)** 缺 `rev` 或
// `rev` 相等而内容不同 ⇒ **冲突、不静默选边**；**rev 不参与同步**（不新开协议字段、不加数据库列、
// 不做全局定序）。
//
// ## 这一层在整条链上的位置
//
// ```
//   编辑器（内存模型） ──序列化──▶ nextJson ──assignBlockRevs(prevJson, nextJson)──▶ 带 rev 的落盘 JSON
//                                        ▲
//                          上一版（"加载时/上次保存时"的那份）就是 baseline
// ```
//
// 判定（块级合并那一层）只读**落盘/远端**的 JSON，不经过编辑器 ⇒ 这一层是"rev 从哪来"的唯一出处。
//
// ## ★ 三条必须写下来的口径（都是判据抓出来的/会踩的）
//
// 1. **只认顶层块**（与今天的落盘形态、Rust 的 `extract_block_ids` 一致：只有顶层块有身份）；
// 2. **没有 `blockId` 的块不写 `rev`** —— 身份还没补种 ⇒ 不猜、不造（空身份块在 CRDT 平面里本来
//    也没有稳定身份，给它一个 rev 只会让下一次比较对不上人）；
// 3. **比较"内容变没变"时，`blockRev` 这个字段本身要排除，且**键序无关**（见 `canonicalContent`）：
//    - 不排除 ⇒ 还没带声明字段的节点类在每次保存时都被判成"改过了" ⇒ rev 无脑上涨；
//    - 不管键序 ⇒ 编辑器重排一次键序也被判成"改过" ⇒ **本地那份旧内容会被当成"更新的"赢过远端
//      真实的新编辑**（静默丢更新，正是本冲刺要消灭的东西）。
//
// ## ★ 一条裁定没写、但**阶段 1 的承诺要求**它成立的口径：未改的块也要有 rev
//
// 裁定只说了"编辑一块 ⇒ `rev = max(整页见过的 rev) + 1`"，没说**没改过**的块怎么办。两种做法：
//
// | 做法 | 后果 |
// |---|---|
// | 未改的块**不写** rev | 两台设备各改**不同块**后：A 的块 X=1、B 的 X 没有 rev ⇒ 合并时 X 落进"缺 rev ⇒ 冲突" ⇒ **每一页都弹提示**（正是阶段 1 要消灭的场景） |
// | 未改的块**写上已知的 rev**；**从没见过 rev 的老块写 `0`**（采用） | A 的 X=1 vs B 的 X=0 ⇒ 取 A（对）；B 的 Y=1 vs A 的 Y=0 ⇒ 取 B（对）⇒ **两边的编辑都保留、且不弹提示** |
//
// ⇒ 采用第二种：**有身份 ⇒ 一定有 rev**。于是"缺 `rev`"这一行在合并表里**只剩"老客户端产物"**
// 这一种真实含义（它保存时会把字段剥掉），与裁定 (iii) 的本意一致。
// 代价（如实写）：老块被盖上 `0` = 声明"它老到不能再老" ⇒ 对方只要**真的**改过那一块，就取对方那一版。
// 那不是"静默丢更新"（对方确实改过、本地确实没改），但**这条要 owner/两边点头**（已写进协同信）。
//
// ## 本片**没做**（下一步接线）
//
// `assignBlockRevs` 今天**没有调用方** —— 接线要动保存路径（`Editor.tsx::serializeWithBlockIds`
// ± baseline 跟踪）与分栏子编辑器，属单独一片。理由同块级合并那一层：**判定层还没接线**，
// 先让"rev 从哪来"这件事本身可测、可复核。

/** 一个顶层块的 `(blockId, rev)` —— 读出来只给这一层用。 */
export interface TopLevelBlockRev {
  blockId: string;
  /** 落盘 JSON 里那个 `blockRev`；缺失/不是有限数 ⇒ `null`（= **老客户端产物**）。 */
  rev: number | null;
}

function parseDoc(docJson: string): { doc: Record<string, unknown>; root: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(docJson) as Record<string, unknown> | null;
    const root = parsed?.root;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    return { doc: parsed, root: root as Record<string, unknown> };
  } catch {
    return null;
  }
}

function parseRoot(docJson: string): Record<string, unknown> | null {
  return parseDoc(docJson)?.root ?? null;
}

function topChildren(root: Record<string, unknown> | null): Record<string, unknown>[] {
  const children = root?.children;
  if (!Array.isArray(children)) return [];
  return children.filter(
    (child): child is Record<string, unknown> => !!child && typeof child === "object" && !Array.isArray(child),
  );
}

/** 读一个块对象的 `blockId`（非空字符串才算有身份）。 */
function blockIdOf(node: Record<string, unknown>): string {
  return typeof node.blockId === "string" ? node.blockId : "";
}

/** 读一个块对象的 `blockRev`（只认**非负整数**；其余一律 `null` —— 与 Rust 侧的 `block_rev_of` 同一口径）。 */
export function blockRevOf(node: unknown): number | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const rev = (node as Record<string, unknown>).blockRev;
  return typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? rev : null;
}

/**
 * **规范化内容**：把 `blockRev` 字段（任意层级）去掉，并把对象的键**排序**后序列化。
 *
 * 只给"这一块变没变"的比较用，**不是**落盘形态（落盘仍是 `JSON.stringify` 的原始键序）。
 * 两条理由写在文件头口径 3：rev 不是内容；键序不是内容。
 */
export function canonicalContent(node: unknown): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (key === "blockRev") continue;
        out[key] = strip((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(node));
}

/** 顶层块的 `(blockId, rev)`（按顺序；**没有身份的块也在里面**，`blockId` 为空串）。 */
export function readTopLevelBlockRevs(docJson: string): TopLevelBlockRev[] {
  return topChildren(parseRoot(docJson)).map((child) => ({
    blockId: blockIdOf(child),
    rev: blockRevOf(child),
  }));
}

/**
 * 这一页**见过的**最大 `rev`（读不出来 ⇒ `0`）。
 *
 * ⚠️ 它是"整页"的量，不是"这一块"的量 —— 与裁定 §7 的 `max(整页见过的 rev) + 1` 同一口径。
 * 到 C 阶段它被 Yjs 的 clock 取代（本层那时候整层删掉）。
 */
export function maxBlockRev(docJson: string): number {
  let max = 0;
  for (const { rev } of readTopLevelBlockRevs(docJson)) {
    if (rev !== null && rev > max) max = rev;
  }
  return max;
}

/**
 * ★ **rev 的写入口**：拿"上一版"（baseline）与"这一版"（编辑器刚序列化出来的）比一遍，
 * 给 `nextJson` 的**每个有身份的顶层块**写上一个 `blockRev`。
 *
 * | 情形 | 写什么 |
 * |---|---|
 * | `next` 里的块**有身份**、且与 baseline 里同 id 的块**内容相同** | baseline 那一版已有的 rev；baseline 里**没见过** rev（老块）⇒ `0` |
 * | `next` 里的块**有身份**、但内容变了 / baseline 里没有这个 id（新块） | `maxSeen + 1`（`maxSeen` = 两侧见过的最大 rev，至少 0） |
 * | `next` 里的块**没有身份**（`blockId` 空/缺失） | **不写**（口径 2：不猜身份） |
 *
 * ⚠️ **删除不在这里**：baseline 有、`next` 没有的块 ⇒ 它就不在产物里了（本层不写墓碑 —— 与
 * 阶段 1 的"不做块级删除"同一处边界，见块级合并那一层的文件头）。
 *
 * ⚠️ 解析不出来（非 JSON / 没有 `root` / 脏 `children`）⇒ **原样返回 `nextJson`**：这一层在保存
 * 路径上，不能因为一条脏数据把"保存"变成"写回一份空文档"。
 */
export function assignBlockRevs(prevJson: string, nextJson: string): string {
  const parsed = parseDoc(nextJson);
  if (!parsed) return nextJson;
  const { doc, root } = parsed;

  const prevById = new Map<string, Record<string, unknown>>();
  for (const child of topChildren(parseRoot(prevJson))) {
    const id = blockIdOf(child);
    if (id) prevById.set(id, child);
  }

  const maxSeen = Math.max(maxBlockRev(prevJson), maxBlockRev(nextJson));

  for (const node of topChildren(root)) {
    const id = blockIdOf(node);
    if (!id) continue; // 口径 2：没身份就不写
    const prev = prevById.get(id);
    if (prev && canonicalContent(prev) === canonicalContent(node)) {
      const known = blockRevOf(prev) ?? blockRevOf(node);
      node.blockRev = known ?? 0; // 未改：保持已知 rev；从没见过（老块）⇒ 0
    } else {
      node.blockRev = maxSeen + 1; // 改了 / 新块
    }
  }

  return JSON.stringify(doc);
}
