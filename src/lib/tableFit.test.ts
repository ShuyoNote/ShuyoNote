// 判据：表格"超宽"的换算规则（owner：「表格超宽了」✗）。
//   实测形状就写在这里：684px 的容器、1054px 的列宽合计 ⇒ 溢出 371px ✓。
import { describe, expect, it } from 'vitest';
import { fitColWidths, pxWidthsOf } from './tableFit';

describe('表格列宽：只把"装不下"的绝对像素换成按比例的百分比', () => {
  it('★ 真实那张表：127/305/622（合计 1054）在 684px 容器里 ⇒ 换成 %（比例逐字保留 ✓）', () => {
    const out = fitColWidths([127.1171875, 304.8984375, 621.984375], 684);
    expect(out).not.toBeNull();
    // ⚠️ 断言"比例"而不是"小数点后第四位"：`toFixed(4)` 的最后一位受浮点影响 ✓（第一版就栽在这 ✗）
    expect(parseFloat(out![0])).toBeCloseTo(12.06, 1);
    expect(parseFloat(out![1])).toBeCloseTo(28.93, 1);
    expect(parseFloat(out![2])).toBeCloseTo(59.01, 1);
    const sum = out!.reduce((a, s) => a + parseFloat(s), 0);
    expect(sum).toBeCloseTo(100, 2); // 加起来必须是 100% ✓（否则表会溢出或留白 ✗）
  });

  it('装得下 ⇒ 返回 null（⛔ 一个字节都不碰 ✓）', () => {
    expect(fitColWidths([100, 100, 100], 684)).toBeNull();
    expect(fitColWidths([684], 684)).toBeNull();
  });

  it('数据不可信 ⇒ 返回 null（0 / 非数 / 可用宽度为 0 ✓）', () => {
    expect(fitColWidths([0, 0], 684)).toBeNull();
    expect(fitColWidths([Number.NaN, 100], 684)).toBeNull();
    expect(fitColWidths([500, 500], 0)).toBeNull();
  });

  it('★ 只认"还是 px"的值 —— 已经换成 % 的不会再被处理（不会来回抖 ✓）', () => {
    expect(pxWidthsOf(['127.117px', '28.9%', 'auto', ''])).toEqual([127.117, 0, 0, 0]);
    expect(fitColWidths(pxWidthsOf(['12.0604%', '28.9277%', '59.0118%']), 684)).toBeNull();
  });
});
