// mindmap 根节点文字居中 —— **在 DOM 上量着修**（纯字符串规则不可靠 ✗，实测栽过两次 ✓）。
//
// 真读数（**真实窗口里量的** ✓，owner 2026-10-07：「中心节点文本**又**偏心了」✗）：
//   `「优化原则」 圈宽 84 ｜ text-anchor = null ✗ ｜ 文字中心 − 圈中心 = **+32px** ✗`
//   —— **恰好是文字宽（64）的一半** ✓：mermaid 把 x 放在**圆心**却不写锚点 ⇒ SVG 默认左对齐 ✓。
//   ⚠️ 我上一版用"字符串里找 `section-root`"来认根 ✗ —— 实测**有些图认得到、有些认不到** ✓
//   （同一个窗口里就有两张带 `text-anchor="middle"`、另一张没有 ✓）⇒ 那条规则不牢靠 ✗。
//
// ⇒ 改成**量着修** ✓：拿到已经插进 DOM 的 SVG ✓，对**每一个圆**，找它所在组里的那个 `<text>` ✓，
//   量"文字中心 vs 圆心"✓ —— 不一致就把 `<text>` 设成 `text-anchor="middle"` ✓（再量一次确认 ✓）。
//   量法可注入 ✓（判据里喂假测量 ✓，真跑时用 `getBoundingClientRect` ✓）。
//
// ⛔ 只碰"圆心与文字对不上"的那一个 `<text>` ✓ —— 其它一个字节都不动 ✗（上一版"全都补"把
//    子节点推歪过 ✓，那条教训还在 ✓）。

export interface Rect {
  left: number;
  width: number;
}

export type Measure = (el: Element) => Rect;

const defaultMeasure: Measure = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, width: r.width };
};

/**
 * 修根节点文字：返回改了几个 `<text>` ✓（0 = 本来就不偏 ✓）。
 * ⚠️ 只处理"圆里那个第一段文字" ✓，且只处理**真的量得出宽度**的元素 ✓（避免在无布局环境里乱改 ✗）。
 */
export function fixMindmapRootAnchors(root: ParentNode, measure: Measure = defaultMeasure): number {
  let fixed = 0;
  const circles = root.querySelectorAll('circle');
  circles.forEach((circle) => {
    const g = circle.closest('g');
    const text = g?.querySelector('text');
    if (!text) return;
    const c = measure(circle);
    if (!(c.width > 4)) return; // 装饰性小圆 / 量不到 ⇒ 不碰 ✓
    const before = measure(text);
    if (!(before.width > 0)) return;
    const textCenter = before.left + before.width / 2;
    const circleCenter = c.left + c.width / 2;
    if (Math.abs(textCenter - circleCenter) <= 0.5) return; // 本来就不偏 ✓（一个字节都不动 ✓）
    text.setAttribute('text-anchor', 'middle');
    // 设完再量一次：确认真的对上了（对不上就把锚点撤回去，⛔ 不留下更糟的状态 ✗）
    const after = measure(text);
    if (after.width > 0) {
      const afterCenter = after.left + after.width / 2;
      if (Math.abs(afterCenter - circleCenter) > Math.abs(textCenter - circleCenter)) {
        text.removeAttribute('text-anchor');
        return;
      }
    }
    fixed += 1;
  });
  return fixed;
}
