// 表格"超宽"这件事的**纯规则** —— 与 DOM 分开 ⇒ 可单测 ✓。
//
// 来由（owner 2026-10-07：「表格超宽了」✗）：
//   真读数（本机库里那张表的节点）：`"colWidths":[127.1171875, 304.8984375, 621.984375]`
//   ⇒ **合计 1054px** ✓；那是**在更宽的窗口里量出来的绝对像素** ✓，
//   而 Lexical 会把它写成 `<col style="width:622px">` ✗ ⇒ 内容区窄一点就装不下 ✗
//   ⇒ 表格溢出、底下多一条横向滚动条 ✓（实测：684px 的容器里塞了 1055px 的表 ✓，溢出 371px）。
//
// 规矩：**只在"合计确实超过可用宽度"时**，把绝对像素换算成**按比例的百分比** ✓
//   ⇒ 表装得下 ✓、列的相对比例一点不丢（127/305/622 ⇒ 12.06% / 28.93% / 59.01% ✓）。
//   ⛔ 不动文档 ✓（调用方只改 DOM ✓）；装得下时**返回 null** ⇒ 一个字节都不碰 ✓。
export function fitColWidths(pxWidths: readonly number[], avail: number): string[] | null {
  const px = pxWidths.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = px.reduce((a, b) => a + b, 0);
  if (sum <= 0 || !(avail > 0) || sum <= avail) return null;
  return px.map((w) => ((w / sum) * 100).toFixed(4) + "%");
}

/** 从 DOM 上读到的 `style.width` 里挑出"还是 px"的那些（百分比 / auto ⇒ 0 ✓，绝不重复处理 ✓）。 */
export function pxWidthsOf(styles: readonly string[]): number[] {
  return styles.map((s) => {
    const t = String(s ?? "").trim();
    return t.endsWith("px") ? parseFloat(t) || 0 : 0;
  });
}

/** 一个字符的"视觉宽度"：CJK 算 2、其它算 1 ✓（表格里中英混排很常见 ✓）。 */
export function visualLen(s: string): number {
  let n = 0;
  for (const ch of String(s ?? "")) n += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

/**
 * ⭐ 2026-10-07（owner：「导入笔记时，表格列可否**自动适配列宽**，或跳到一个视觉合理的宽度」✗）：
 * 按各列**内容长度**给一组"视觉上合理"的**相对**列宽 ✓（总和 = `total` ✓，单位 px ✓）。
 *
 * 为什么需要它：md 导入走 `$createTableNode()` **一个宽度都不设** ✗ ⇒ 配合我们的
 * `.editor-table { table-layout: fixed; width: 100% }`（`App.css` ✓）⇒ **各列等宽** ✓，
 * 于是"示例""目的"这种文字多的列很挤、要折两行 ✗（owner 截图里那张表就是 ✓）。
 *
 * 规矩：
 *   · 每列权重取该列**最长单元格**的 `sqrt` ✓ —— 压一下长文本列，免得一个很长的例子把别的列挤成一条 ✗；
 *   · 每列都有下限（默认 80px ✓，与 CSS 的 `min-width: 60px` 同源但更宽一点 ✓）；
 *   · 总宽小于"下限×列数"时**退化成等宽** ✓（不硬造负数 ✓）。
 *   ⚠️ 这里只表达**相对关系** ✓ —— 真正落到页面上的宽度由 `fitColWidths` 再按可用宽度归一化 ✓。
 */
export function suggestColWidths(rows: readonly (readonly string[])[], total = 1000, minPx = 80): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  if (total <= minPx * cols) return Array.from({ length: cols }, () => Math.round(total / cols));
  const weights: number[] = [];
  for (let c = 0; c < cols; c++) {
    let maxLen = 0;
    for (const r of rows) maxLen = Math.max(maxLen, visualLen(String(r[c] ?? "")));
    weights.push(Math.max(2, Math.sqrt(maxLen)));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * total);
  // 低于下限的先抬起来，抬出来的额度从"高于下限的列"里按比例扣（两轮足够收敛 ✓）
  for (let pass = 0; pass < 2; pass++) {
    const low = widths.map((w, i) => (w < minPx ? i : -1)).filter((i) => i >= 0);
    if (!low.length) break;
    let need = 0;
    for (const i of low) {
      need += minPx - widths[i];
      widths[i] = minPx;
    }
    const high = widths.map((_w, i) => (low.includes(i) ? -1 : i)).filter((i) => i >= 0);
    const highSum = high.reduce((a, i) => a + widths[i], 0);
    if (highSum <= 0) break;
    for (const i of high) widths[i] = Math.max(minPx, widths[i] - (widths[i] / highSum) * need);
  }
  const s2 = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => Math.round((w / s2) * total));
}
