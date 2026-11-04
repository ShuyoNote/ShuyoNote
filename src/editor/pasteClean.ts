// 从富文档粘贴代码块时的**行号清理**（2026-11-04 owner 截图：代码块里出现两套行号）。
//
// 形态：飞书 / 语雀 / 网页文档把一个代码块渲染成“每行行号 + 代码”，复制时
// `text/html` 里 `<pre>` 的 `textContent` 会带上这些行号（`1 互联网…`、`2 | https…`），
// ShuyoNote 再按 `<pre>` 导入时就把行号当正文了 ⇒ 编辑器自己的行号栏 + 正文行号 = 两套。
//
// 这里只做一件事：**当且仅当每一行都以“连续序号 + 空白”开头**时剥掉序号。
// ⚠️ 不碰正常代码：至少 5 行、序号必须从 1 起严格递增，否则原样返回。
const LINE_NO = /^(\s*)(\d+)[ \t\u00a0]+(.*)$/;

export function stripPastedCodeLineNumbers(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  const parsed: Array<{ indent: string; text: string } | null> = [];
  const numbers: number[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      parsed.push(null);
      continue;
    }
    const m = LINE_NO.exec(line);
    if (!m) return text; // 只要有一行不是“序号 + 空白”，就不是行号列 ⇒ 不动
    numbers.push(Number(m[2]));
    parsed.push({ indent: m[1], text: m[3] });
  }
  if (numbers.length < 5) return text;
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) return text;
  }
  return parsed.map((p) => (p === null ? "" : `${p.indent}${p.text}`)).join("\n");
}

/**
 * 把 HTML 里所有“带行号的 `<pre>`”清成纯代码；**没有任何一处变化 ⇒ 返回 null**
 * （调用方据此决定是否接管这次粘贴，避免把普通富文本粘贴也重导一遍）。
 */
export function cleanPastedCodeHtml(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    const raw = pre.textContent ?? "";
    const cleaned = stripPastedCodeLineNumbers(raw);
    if (cleaned === raw) continue;
    // 直接替换 pre 的内容：data-language 等属性保留，Lexical 的 pre 导入仍然生效。
    pre.textContent = cleaned;
    changed = true;
  }
  return changed ? doc.body.innerHTML : null;
}
