// Rust 文本的"哪里算生产代码"——给 `scripts/check-doc-content-access.mjs`（文档内容访问门禁）用。
//
// 为什么单独一个模块：这条规则原来是**行内**的，判据是"`#[cfg(test)] mod tests` 落在文件后半段
// ⇒ 从它切到文件尾"。那是代理不是证明，失效方向也最坏 —— **测试模块之后若还有生产代码，
// 那段会被一起切掉**，在它里面新增直接访问不会报红（假绿）。换成配对判定之后，
// 这条性质必须有**自己的回归判据**（见 `rust-scan.test.mjs`），所以抽成可测的纯函数。
//
// 方向性约定（整个模块只有这一条约定）：**宁可不切（多算 ⇒ 假红，看得见、改起来便宜），
// 绝不漏切（少算 ⇒ 假绿，看不见）**。因此任何不确定的输入都返回"不切"。

/**
 * 给 Rust 文本打区域掩码：`0` 代码 / `1` 行注释 / `2` 块注释 / `3` 字符串 / `4` 字符字面量。
 * 只为一件事服务：**配对与计数时别把注释、字符串里的花括号与 `#[cfg(test)]` 算进来**。
 */
export function rustRegions(text) {
  const n = text.length;
  const M = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const j = text.indexOf("\n", i);
      const e = j === -1 ? n : j;
      M.fill(1, i, e);
      i = e;
      continue;
    }
    if (c === "/" && d === "*") {
      // Rust 的块注释可嵌套
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (text[k] === "/" && text[k + 1] === "*") { depth++; k += 2; }
        else if (text[k] === "*" && text[k + 1] === "/") { depth--; k += 2; }
        else k++;
      }
      M.fill(2, i, k);
      i = k;
      continue;
    }
    // 原始字符串：r"…" / r#"…"# / br#"…"#（两端 `#` 个数必须一致）
    if (c === "r" || (c === "b" && d === "r")) {
      const raw = /^(?:br|rb|r)(#*)"/.exec(text.slice(i, i + 16));
      if (raw) {
        const close = '"' + raw[1];
        const open = i + raw[0].length;
        const j = text.indexOf(close, open);
        const e = j === -1 ? n : j + close.length;
        M.fill(3, i, e);
        i = e;
        continue;
      }
    }
    if (c === '"' || (c === "b" && d === '"')) {
      let k = c === "b" ? i + 2 : i + 1;
      while (k < n) {
        if (text[k] === "\\") { k += 2; continue; }
        if (text[k] === '"') { k++; break; }
        k++;
      }
      M.fill(3, i, k);
      i = k;
      continue;
    }
    if (c === "'") {
      // 字符字面量（`'{'` / `'\n'` / `'\u{1F600}'`）要盖住；生命周期（`'a` / `'outer:`）不是字面量。
      const lit =
        /^'(?:\\.|[^\\'])'/.exec(text.slice(i, i + 16)) ??
        /^'(?:\\x[0-9a-fA-F]{2}|\\u\{[0-9a-fA-F_]+\})'/.exec(text.slice(i, i + 20));
      if (lit) {
        M.fill(4, i, i + lit[0].length);
        i += lit[0].length;
        continue;
      }
      const life = /^'[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 64));
      i += life ? life[0].length : 1;
      continue;
    }
    i++;
  }
  return M;
}

/** 从 `pos` 起跳过注释/字符串做花括号配对，返回该 item 的结束位置；配不上返回 `null`。 */
export function rustItemEnd(text, M, pos) {
  let depth = 0;
  let seenBrace = false;
  for (let i = pos; i < text.length; i++) {
    if (M[i] !== 0) continue; // 注释/字符串/字符里的花括号不算
    const ch = text[i];
    if (ch === "{") { depth++; seenBrace = true; continue; }
    if (ch === "}") {
      depth--;
      if (seenBrace && depth === 0) return i + 1;
      continue;
    }
    if (ch === ";" && !seenBrace && depth === 0) return i + 1; // 无花括号的 item，如 `#[cfg(test)] use x;`
  }
  return null;
}

/** `from` 之后是否只剩空白与注释。 */
export function onlyTriviaAfter(text, M, from) {
  for (let i = from; i < text.length; i++) {
    if (M[i] === 1 || M[i] === 2) continue;
    if (!/\s/.test(text[i])) return false;
  }
  return true;
}

/**
 * 找出**真正位于文件尾部**的 `#[cfg(test)]` item 的起点；找不到返回 `null`。
 * 不要求模块叫 `mod tests`，也不看位置比例 —— 只看"配对之后是不是就到了文件尾"。
 */
export function rustTestTailStart(text, M = rustRegions(text)) {
  const re = /#\[cfg\(test\)\]/g;
  for (let m; (m = re.exec(text)); ) {
    if (M[m.index] !== 0) continue; // 注释或字符串里的假属性
    const end = rustItemEnd(text, M, m.index);
    if (end === null || !onlyTriviaAfter(text, M, end)) continue;
    return m.index;
  }
  return null;
}

/** TS/TSX 的测试文件判据（这些文件整份不算生产替换面）。 */
export const isTestFile = (rel) => /\.test\.(ts|tsx|mjs|js)$/.test(rel);

/**
 * 取"算作生产替换面"的那部分文本。返回 `null` 表示该文件不参与计数（测试文件）。
 * 排除测试**不是**放松：生产侧一处的余量都没有。
 */
export function productionText(rel, text) {
  if (isTestFile(rel)) return null;
  if (!rel.endsWith(".rs")) return text;
  const M = rustRegions(text);
  const cut = rustTestTailStart(text, M);
  return cut === null ? text : text.slice(0, cut);
}
