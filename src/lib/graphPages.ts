// 「图里哪些节点算**内容页**」这条规则的**唯一出处**（关系图 ＋ 知识地图共用）。
//
// ## 为什么要有这个文件（2026-10-08）
// 这条规则最早是给**知识地图**写的（`lib/kbMap.ts`：目录不进地图）✓；随后 owner 又拍了
// 「**关系图一起滤掉**」✓ —— 若两个视图**各写一份** `p.kind !== "folder"`，那两份规则必然漂移
//（本仓最贵的一课：**一条判据被抄了 7 份**）⇒ 收敛到这一处，两个视图都调它 ✓。
//
// ## 三条口径（别改错）
// ① **只认 `folder`**：`database`（数据库页）是**内容页** ✓；**缺省 `kind`**（老载荷／更早的桌面端）
//    ⇒ **当页面**（宁可多画一个，也不许因为认不出就把用户的东西**藏起来** ✗）；
// ② **边跟着端点走**：目录被滤掉之后，指向它的边必须**一起丢**（⛔ 不留悬空线 ✗）；
// ③ 纯函数、不 import 平台/存储 ⇒ 判据可在 Node 里直接跑 ✓（`graphPages.test.ts`）。
//
// 判据：`src/lib/graphPages.test.ts`（含"两个视图都走这一处、⛔ 不许各写一份"的**源码形状**断言 ✓）。
import type { GraphEdge, GraphPage } from "../types";

/** 这一页算不算**内容页**（目录不算 ✓；其余都算 ✓）。 */
export function isContentPage(p: GraphPage): boolean {
  return (p.kind ?? "page") !== "folder";
}

/** 只留内容页（顺序不动 ✓）。 */
export function contentPages(pages: readonly GraphPage[]): GraphPage[] {
  return pages.filter(isContentPage);
}

/** 只留**两端都在给定 id 集合里**的边 ⇒ 目录滤掉后不会留下指向它的悬空线 ✓。 */
export function edgesWithin(edges: readonly GraphEdge[], ids: ReadonlySet<string>): GraphEdge[] {
  return edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}
