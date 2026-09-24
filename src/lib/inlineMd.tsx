// 行内 `**强调**` → 真正的 <b>。**唯一一处**转换，toast 与面板共用。
//
// ## 为什么需要它
// 内核（Rust）写给用户看的话是**按 Markdown 行内写法**写的（`**打不开**`、`**明文**`、
// `**没有采纳，本机一个字节都没改**`…）。它们被原样塞进 toast／面板文本 ⇒ 前端若只写
// `{msg}`，用户看到的就是一串 `**`（2026-09-24 owner 截图当场指出的那种）。
// 与其去改几百条 Rust 文案（那是全仓风格，且判据都断在那些字符串上），不如在**显示的最后一跳**
// 把标记渲染掉 —— 而且只做这一处，两处长得一样。
//
// ## 规则（刻意保守：宁可少渲染，也绝不吞字）
// · **只认成对的** `**…**`；落单的星号**原样保留**（绝不把半句话加粗、更不丢字符）；
// · 组内不含 `*`（避免把 `**a** 与 **b**` 那种一串星号读成一段）；
// · 不做其它 Markdown（链接 / 代码 / 换行）：那是调用方的事，这里只解决"星号露在界面上"。
import type { ReactNode } from "react";

/** 把 `**x**` 渲染成 `<b>x</b>`；没有成对标记时**原样返回**（返回类型因此是 `ReactNode`）。 */
export function inlineMd(text: string): ReactNode {
  if (!text.includes("**")) return text;
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<b key={m.index}>{m[1]}</b>);
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text; // 一个成对的都没有 ⇒ 原样（不吞星号）
  if (last < text.length) out.push(text.slice(last));
  return out;
}
