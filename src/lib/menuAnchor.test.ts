// 判据：「⋯ 更多」菜单的锚点（owner：「更多弹窗弹出位置不对」✗）。
//   ⚠️ 只用单引号字符串、中文引用用「」。
import { describe, expect, it } from 'vitest';
import { menuAnchor } from './menuAnchor';

const btn = (top: number, bottom: number, right: number) => ({ top, bottom, right });

describe('菜单锚点：跟按钮右对齐、贴在按钮下方，并且夹在视口内', () => {
  it('★ 常见情形：右边缘与按钮右对齐 ＋ 下方 6px（⛔ 不再是写死的视口右上角 ✗）', () => {
    // 按钮在 x≈530..558、y≈70..98（owner 那张截图的量级 ✓）
    expect(menuAnchor(btn(70, 98, 558), 1149, 753)).toEqual({ top: 104, right: 591 });
  });

  it('★ 按钮靠窗口右缘 ⇒ 菜单也不会跑出右边（夹到 4px 边距 ✓）', () => {
    expect(menuAnchor(btn(70, 98, 1145), 1149, 753).right).toBe(4);
  });

  it('按钮贴近窗口左上 / 下缘 ⇒ 不出现负数坐标，也不越过底边 ✓', () => {
    const a = menuAnchor(btn(0, 2, 1150), 1200, 600);
    expect(a.top).toBeGreaterThanOrEqual(4);
    expect(a.right).toBeGreaterThanOrEqual(4);
    expect(menuAnchor(btn(690, 750, 1100), 1200, 753).top).toBeLessThanOrEqual(745);
  });

  it('知道菜单宽度时：右对齐之后**整条菜单**也得留在视口里 ✓', () => {
    const a = menuAnchor(btn(70, 98, 1145), 1149, 753, 260);
    expect(a.right).toBe(4);
    expect(1149 - a.right - 260).toBeGreaterThanOrEqual(0); // 左边还留得住 ✓
  });
});
