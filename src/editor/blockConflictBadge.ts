// 阶段 1 · **冲突块角标**：把"这一块有未决冲突"画到编辑器里。
//
// 怎么找到那一块：编辑器给每个顶层块的 DOM 打了 `data-block-id`（`Editor.tsx::tagBlockDoms`），
// 与"跳转到块引用"用的是同一套标记 ⇒ 这里只按 id 打/摘一个类名，**不碰编辑器状态**。
//
// 为什么做成这样一个纯函数：它是"提示条（数据）→ 用户看得见（DOM）"之间唯一需要证明的一段；
// 塞在 `Editor.tsx` 的 effect 里就没法单独验（那一片要真挂 Lexical）。判据见 `blockConflictBadge.test.ts`。
//
// ⚠️ 只能匹配**已经被打过标记**的元素：没打标记的块（还没进过 `tagBlockDoms`）这次漏掉，
// 下一次 editor update 会补上 —— 与"跳转"那条路径的已知行为一致。

/** 给这些块加 `block-conflict`（其余块**摘掉**；传空数组 = 全清）。 */
export function applyConflictBadges(blockIds: readonly string[], root: ParentNode = document): void {
  const wanted = new Set(blockIds);
  const elements = root.querySelectorAll<HTMLElement>("[data-block-id]");
  for (const el of Array.from(elements)) {
    const id = el.dataset.blockId ?? "";
    el.classList.toggle("block-conflict", id.length > 0 && wanted.has(id));
  }
}
