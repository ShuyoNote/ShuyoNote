import type React from "react";

/**
 * 把**带高亮标记**的检索片段渲染出来（`[[命中]]` → `<mark>` ✓）。
 *
 * ⚠️ 出处：原来是 `src/components/SearchPanel.tsx` 里的**局部组件** ✓。2026-10-10 做
 * **03 搜索屏**（效果图 `03-search.svg`：命中片段要**两档底色**）时出现了**第二处** ⇒
 * 抽到这里 ✓ —— 标记格式是**索引层**（Rust `search.rs`）产出的，两处各写一份解析器
 * 必然漂（一处认得 `[[]]`、另一处不认 ⇒ 同一份数据在两张屏上显示不同 ✗）。
 *
 * ⚠️ 契约：`snippet` 里 `[[` 开、`]]` 关，**成对出现**；`split` 之后**偶数下标在标记外、
 * 奇数下标在标记内** ✓（这是分隔符正则的直接推论，不是约定俗成 —— 别改成"数一下"✗）。
 *
 * ⚠️ 两档底色（规格 §4.3 逐字：「**当前命中与其他命中两档底色**
 * （`--highlight-active-bg` vs `--highlight-bg`）」）由 **CSS** 决定：
 * 调用方给自己那一层加 `is-active`，CSS 里 `.is-active mark` 吃 `--highlight-active-bg` ✓。
 * 本组件只负责**产出 `<mark>`**，不决定配色 ✓（桌面那份用了 `--highlight-bg` ✓）。
 */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  // markers come in pairs: [[ starts highlight, ]] ends it.
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part === "") return;
    // The split leaves even indexes outside markers, odd inside.
    if (i % 2 === 1) {
      nodes.push(<mark key={i}>{part}</mark>);
    } else {
      nodes.push(<span key={i}>{part}</span>);
    }
  });
  return <>{nodes}</>;
}
