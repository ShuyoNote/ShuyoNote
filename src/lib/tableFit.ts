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
