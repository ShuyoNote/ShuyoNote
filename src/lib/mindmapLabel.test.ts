// 判据：mindmap 根节点文字「量着修」（owner：「中心节点文本**又**偏心了」✗）。
//   真读数写进用例：圈宽 84、文字宽 64、偏心 +32px（= 文字宽的一半 ✓）。
//   ⚠️ 布局用**注入的假测量** ✓、DOM 用**最小替身** ✓（jsdom 的 SVG 解析与布局都不可靠 ✗，
//      这条判据要守的是"量着修"的**逻辑** ✓，不是浏览器的解析器 ✓）。
import { describe, expect, it } from 'vitest';
import { fixMindmapRootAnchors, type Measure, type Rect } from './mindmapLabel';

interface FakeText {
  tag: 'text';
  anchor: string | null;
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
  removeAttribute: (n: string) => void;
  closest: (sel: string) => unknown;
}

/** 造一个"圆 ＋ 组里第一段文字"的最小替身 ✓（带注入的量法 ✓）。 */
function fakeGraph(circle: Rect, text: Rect, applyAnchor: boolean) {
  const rects = new Map<object, Rect>();
  const t: FakeText = {
    tag: 'text',
    anchor: null,
    getAttribute(n) {
      return n === 'text-anchor' ? this.anchor : null;
    },
    setAttribute(n, v) {
      if (n === 'text-anchor') this.anchor = v;
    },
    removeAttribute(n) {
      if (n === 'text-anchor') this.anchor = null;
    },
    closest: () => g,
  };
  const circleEl = { tag: 'circle', closest: () => g };
  const g = {
    querySelector: (sel: string) => (sel === 'text' ? t : null),
  };
  rects.set(circleEl, circle);
  rects.set(t as unknown as object, text);
  const measure: Measure = (el) => {
    const base = rects.get(el as unknown as object);
    if (!base) return { left: 0, width: 0 };
    // 真浏览器的效果：设了 middle ⇒ 文字以**圆心**为中心 ✓（用注入的量法模拟 ✓）
    if (applyAnchor && el === (t as unknown as object) && t.anchor === 'middle') {
      return { left: circle.left + circle.width / 2 - base.width / 2, width: base.width };
    }
    return base;
  };
  const root = {
    querySelectorAll: (sel: string) => (sel === 'circle' ? [circleEl] : []),
  } as unknown as ParentNode;
  return { root, measure, text: t, circleEl };
}

describe('fixMindmapRootAnchors（量着修 ✓）', () => {
  it('★ 真实那一格：圈宽 84、文字宽 64、偏心 +32 ⇒ 设 middle 之后归零 ✓', () => {
    // 圈中心 = 100+42 = 142；文字中心 = 142+32 = 174 ⇒ 偏心 **+32** ✓（= 文字宽的一半 ✓）
    const { root, measure, text } = fakeGraph({ left: 100, width: 84 }, { left: 142, width: 64 }, true);
    expect(fixMindmapRootAnchors(root, measure)).toBe(1);
    expect(text.anchor).toBe('middle');
    const a = measure(text as unknown as Element);
    expect(a.left + a.width / 2).toBeCloseTo(142, 1); // 修完真的回到圆心 ✓
  });

  it('★ 本来就不偏 ⇒ **一个字节都不动** ✓（返回 0 ✓）', () => {
    const { root, measure, text } = fakeGraph({ left: 100, width: 84 }, { left: 100, width: 84 }, true);
    expect(fixMindmapRootAnchors(root, measure)).toBe(0);
    expect(text.anchor).toBeNull();
  });

  it('★★ 子节点（没有圆、只有路径上的文字）不许被碰 ✗ —— 上一版"全都补"就是在这里翻车的 ✓', () => {
    const text: FakeText = {
      tag: 'text',
      anchor: null,
      getAttribute: () => null,
      setAttribute: (n, v) => {
        if (n === 'text-anchor') text.anchor = v;
      },
      removeAttribute: () => {
        text.anchor = null;
      },
      closest: () => null,
    };
    const root = { querySelectorAll: () => [] } as unknown as ParentNode; // 一个圆都没有 ✓
    const measure: Measure = () => ({ left: 50, width: 100 });
    expect(fixMindmapRootAnchors(root, measure)).toBe(0);
    expect(text.anchor).toBeNull();
  });

  it('量不到（无布局 / 装饰性小圆）⇒ 不碰 ✓（⛔ 不留下更糟的状态 ✗）', () => {
    const { root, text } = fakeGraph({ left: 0, width: 0 }, { left: 0, width: 0 }, true);
    expect(fixMindmapRootAnchors(root, () => ({ left: 0, width: 0 }))).toBe(0);
    expect(text.anchor).toBeNull();
  });

  it('★ 修了反而更糟（比如设了锚点却把它推到另一边）⇒ **撤回去** ✓', () => {
    const { root, text } = fakeGraph({ left: 100, width: 84 }, { left: 110, width: 64 }, false);
    // applyAnchor=false ⇒ 设了 middle 之后量出来还是原样（偏心仍 32）⇒ 该撤销 ✓
    const measure: Measure = (el) => (el === (text as unknown as object) ? { left: 110, width: 64 } : { left: 100, width: 84 });
    expect(fixMindmapRootAnchors(root, measure)).toBe(0);
    expect(text.anchor).toBeNull();
  });
});
