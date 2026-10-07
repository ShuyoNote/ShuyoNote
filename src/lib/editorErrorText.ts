// 编辑器报错的**一句话版本**（纯规则 ⇒ 可单测 ✓）。
//
// 来由（owner 2026-10-06 连发三次同一张截图 ✗）：
//   生产构建里 Lexical 会把错误正文换成编号 ✓，toast 里于是出现一长串
//     `Minified Lexical error #335; visit https://lexical.dev/docs/error?code=335&v=18972 for the full message or use the non-minified dev environment for full errors and …`
//   —— 它自己就**被 toast 截断**了 ✗ ⇒ 用户看到的信息既不全、也没法照做 ✓。
//   （`console.error(error)` 里那份**是完整的** ✓ —— 只是没人会去开控制台 ✗。）
//
// ⇒ 规矩：toast 只放"**这是什么 + 去哪看完整**" ✓；完整消息继续走控制台 ✓，一个字都不丢 ✓。

/** Lexical 压缩错误号：#335 / code=335 两种形态都认 ✓。 */
const MINIFIED = /Minified Lexical error #(\d+)|code=(\d+)/;

export function shortEditorError(message: unknown, maxLen = 90): string {
  const raw = String((message as Error)?.message ?? message ?? "").trim();
  if (!raw) return "未知错误（完整报错见控制台）";
  const m = MINIFIED.exec(raw);
  if (m) {
    const code = m[1] || m[2];
    return `Lexical #${code}（编辑器内部报错）—— 完整报错已打到控制台（开发者工具 → Console）`;
  }
  // 别的错误：压平空白、截到一行；超长也指明完整版在哪 ✓
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…（完整报错见控制台）` : flat;
}
