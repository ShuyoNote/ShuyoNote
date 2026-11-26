// 从富文档粘贴代码块时的**行号清理**（2026-11-04 owner 截图：代码块里出现两套行号）。
//
// 形态：飞书 / 语雀 / 网页文档把一个代码块渲染成“每行行号 + 代码”，复制时
// `text/html` 里 `<pre>` 的 `textContent` 会带上这些行号（`1 互联网…`、`2 | https…`），
// ShuyoNote 再按 `<pre>` 导入时就把行号当正文了 ⇒ 编辑器自己的行号栏 + 正文行号 = 两套。
//
// 这里只做一件事：**当且仅当每一行都以“连续序号 + 空白”开头**时剥掉序号。
// ⚠️ 不碰正常代码。
//
// ⭐ **2026-11-26（owner 截图：3 行代码块复制后变成"两套行号"）**：旧口径要求 **≥5 行**，
// 于是一个只有 3 行的代码块（行号栏被一起选中）就**剥不掉** ⇒ 编辑器自己的行号栏 + 正文里的号 = 两套。
// 放宽成两条口径（同时满足才动手）：
//   ① **强口径**（≥3 行）：序号后必须是**两个以上空白**（行号栏对齐留下的），且缩进一致；
//      —— 这条能把 "1 + 2 = 3" 这类**正常代码**排除掉（它只有一个空格）。
//   ② **旧口径**（≥5 行）：序号后一个空白也行（飞书/语雀那种形态），保持原样不动。
// 判据：`pasteClean.test.ts`（3 行两空格 ⇒ 剥；3 行单空格 ⇒ 不动；5 行单空格 ⇒ 剥）。
const LINE_NO = /^(\s*)(\d+)[ \t\u00a0]+(.*)$/;
/** 强口径：序号与正文之间**至少两个**空白字符（\u00a0 记 1 个）。 */
const LINE_NO_WIDE = /^(\s*)(\d+)(?:[ \t\u00a0]{2,})(.*)$/;

export function stripPastedCodeLineNumbers(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  const parsed: Array<{ indent: string; text: string } | null> = [];
  const numbers: number[] = [];
  const indents: string[] = [];
  let wideAll = true;
  for (const line of lines) {
    if (line.trim() === "") {
      parsed.push(null);
      continue;
    }
    const m = LINE_NO.exec(line);
    if (!m) return text; // 只要有一行不是“序号 + 空白”，就不是行号列 ⇒ 不动
    numbers.push(Number(m[2]));
    indents.push(m[1]);
    parsed.push({ indent: m[1], text: m[3] });
    if (!LINE_NO_WIDE.test(line)) wideAll = false;
  }
  const sameIndent = indents.every((x) => x === indents[0]);
  const strong = wideAll && sameIndent && numbers.length >= 3;
  const legacy = numbers.length >= 5;
  if (!strong && !legacy) return text;
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
