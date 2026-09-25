// 拖动页面树时跟着光标走的那个小拖影。
//
// ★ 为什么单独一个组件（而不是写在 `PageTree` 里）——这是一个**每帧重渲染**的组件：
//   `useTreeDrag.cursor()` 在 `mousemove` 里写 `x`/`y`，而订阅这两个字段的组件每次移动
//   鼠标都会重渲染。原先它就写在 `PageTree` 内部 ⇒ **拖一次树 = 整个侧栏（1180 行）以
//   60fps 重渲染**：里面还有空间列表、同步面板触发器、整棵页面树的 JSX。
//   拆出来之后，每帧重渲染的只有这个 20 行的组件，`PageTree` 本身一次都不动。
//
// ⚠️ `check-store-subscriptions` 门禁**看不到**这种"订阅关系正确、但订阅者太大"的情况：
//   下面四个都是字段级选择器，在门禁眼里是绿的（它只管"有没有整店订阅"，不管"谁在订阅"）。
//   所以这条只能靠注释与评审守住 —— **往这个组件里加东西之前，先想清楚它会以 60fps 重渲染**。
import { useTreeDrag } from "../store/treeDrag";
import { DatabaseIcon, FolderIcon, PageIcon } from "./icons";

export function TreeDragGhost() {
  const label = useTreeDrag((s) => s.label);
  const x = useTreeDrag((s) => s.x);
  const y = useTreeDrag((s) => s.y);
  const kind = useTreeDrag((s) => s.kind);

  // 没有正在拖的节点 ⇒ 什么都不渲染。
  // （四个 hook 都在这个 early return **之前**，hook 顺序稳定；`check-hook-order` 管这条。）
  if (!label) return null;

  return (
    <div className="tree-drag-ghost" style={{ left: x + 12, top: y + 8 }}>
      <span className="tree-ghost-icon">
        {kind === "folder" ? <FolderIcon width={15} height={15} /> :
         kind === "database" ? <DatabaseIcon width={15} height={15} /> :
         <PageIcon width={15} height={15} />}
      </span>
      <span className="tree-ghost-title">{label}</span>
    </div>
  );
}
