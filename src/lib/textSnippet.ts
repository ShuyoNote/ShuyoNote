// 生成**给人看/AI 看**的短片段时的唯一截断口径。
//
// ## 为什么需要它（2026-09-17 实测到的一类小事故）
// 直觉写法是 `s.slice(0, n) + "…"`。但 JS 的 `slice` 按 **UTF-16 码元**切，
// 而 emoji / 部分生僻字是**一对代理**（surrogate pair）：
//
//     "a😀b".slice(0, 2)  ===  "a\uD83D"      // 末尾是**孤立的高位代理**
//     JSON.stringify(...) ===  "\"a\\ud83d\""  // 解码方通常把它换成 U+FFFD ⇒ 用户看到 "a�…"
//
// 这类"看起来只是少了一个字符"的问题，**不会有任何异常**：检索照样命中、片段照样返回，
// 只是偶尔多一个乱码方块。所以它只能靠判据守（`textSnippet.test.ts`）。
//
// ## 口径
// · 按**码点**（`Array.from`）而不是码元切 ⇒ 永不切出孤立代理；
// · 只在真的截断时追加省略号（没截断就不加，调用方据此判断"是不是完整的"）；
// · 负数/0 长度按 0 处理（返回 ""，不抛）。

/** 按码点截断到 `max` 个字符（超出时追加 `…`）。 */
export function truncateByCodePoints(s: string, max: number): string {
  const text = String(s ?? "");
  const limit = Math.max(0, Math.floor(max) || 0);
  if (limit === 0) return "";
  const cps = Array.from(text); // Array.from 按码点切，代理对不会被拆开
  return cps.length > limit ? `${cps.slice(0, limit).join("")}…` : text;
}

/**
 * 按码点取**窗口** `[offset, offset+limit)`（与 Rust 侧的 `chars().skip().take()` 同口径）。
 *
 * 为什么必须是"同一个口径"而不是"各自差不多"：同一个页面在 **web 路径（本函数）** 与
 * **桌面路径（Rust `cap_pages_get`）** 上都会被分窗口读取，两边只要差一个字符，
 * 调用方连续两次 `pages.get` 就会**漏字或重字**（emoji/生僻字处最明显）。
 *
 * 越界不是错误：`offset` 超过总长返回 `""`（调用方靠 `chars_total` 判断"翻过头了"）。
 */
export function sliceByCodePoints(s: string, offset: number, limit: number): string {
  const cps = Array.from(String(s ?? ""));
  const off = Math.max(0, Math.floor(offset) || 0);
  const lim = Math.max(0, Math.floor(limit) || 0);
  if (lim === 0) return "";
  return cps.slice(off, off + lim).join("");
}

/** 码点长度（`String.length` 数的是 UTF-16 码元，emoji 会被算成 2）。 */
export function codePointLength(s: string): number {
  return Array.from(String(s ?? "")).length;
}
