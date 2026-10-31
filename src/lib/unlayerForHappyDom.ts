// 仅供**测试**使用的 CSS 扁平化：把 `@layer legacy { … }` / `@layer utilities { … }` 拆掉包装、
// 只留里面的规则。
//
// 为什么需要：`sidebarVisibility.test.ts` / `emailListHeadWrap.test.ts` 会把**真正的 App.css**
// 注入 happy-dom 再用 `getComputedStyle` 判层叠。happy-dom **不支持 CSS Cascade Layers**
// （2026-10-31 实测：规则在 `@layer` 里时计算值是空/`block`，S2 落地当天这两个测试红）。
// ⇒ 测试侧先扁平成"无层"文本，判的还是**同一批规则**；真正的层叠语义由
//   `src/lib/cssLayers.test.ts`（结构）＋ 真浏览器视觉基线（`scripts/css-visual-baseline.mjs`）钉住。
//
// ⚠️ 只给测试用，别在应用代码里 import（它会把层语义抹掉 —— 那正好是 S2 要建立的东西）。
export function unlayerForHappyDom(css: string): string {
  // ① 去掉层序声明（`@layer legacy, utilities;`）
  let out = css.replace(/@layer\s+[\w-]+(\s*,\s*[\w-]+)*\s*;/g, "");
  // ② 反复拆 `@layer <name> { … }`，保留内部内容（内部可能还嵌 @media / @keyframes）
  for (;;) {
    const m = out.match(/@layer\s+[\w-]+\s*\{/);
    if (!m || m.index === undefined) break;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break; // 花括号不平衡 ⇒ 原样返回，让断言自己红
    out = out.slice(0, m.index) + out.slice(open + 1, end) + out.slice(end + 1);
  }
  return out;
}
