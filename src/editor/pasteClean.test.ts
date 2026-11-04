import { describe, expect, it } from "vitest";

import { cleanPastedCodeHtml, stripPastedCodeLineNumbers } from "./pasteClean";

describe("富文档粘贴 · 代码块行号清理", () => {
  it("① 每行都是连续序号 + 空白 ⇒ 剥掉序号（owner 截图那 17 行）", () => {
    const lines = Array.from({ length: 17 }, (_, i) => `${i + 1} 互联网接入层第 ${i + 1} 行`);
    expect(stripPastedCodeLineNumbers(lines.join("\n"))).toBe(
      Array.from({ length: 17 }, (_, i) => `互联网接入层第 ${i + 1} 行`).join("\n"),
    );
  });

  it("② 正常代码（不是每行“序号 + 空白”）⇒ 一个字都不改", () => {
    const code = ["const a = 1;", "const b = 2;", "console.log(a + b);"].join("\n");
    expect(stripPastedCodeLineNumbers(code)).toBe(code);
  });

  it("③ 序号不从 1 开始 / 不连续 ⇒ 不是行号列，不动", () => {
    const code = ["2 a", "3 b", "4 c", "5 d", "6 e"].join("\n");
    expect(stripPastedCodeLineNumbers(code)).toBe(code);
    expect(stripPastedCodeLineNumbers(["1 a", "2 b", "4 c", "5 d", "6 e"].join("\n"))).toBe(
      ["1 a", "2 b", "4 c", "5 d", "6 e"].join("\n"),
    );
  });

  it("④ 少于 5 行不剥（避免把正常的编号说明误判成行号栏）", () => {
    const code = ["1 a", "2 b", "3 c", "4 d"].join("\n");
    expect(stripPastedCodeLineNumbers(code)).toBe(code);
  });

  it("⑤ 只处理 pre，且没有变化时返回 null（不接管普通粘贴）", () => {
    expect(cleanPastedCodeHtml("<p>普通段落</p>")).toBeNull();
    const html = `<p>说明</p><pre data-language="javascript"><code>1 a\n2 b\n3 c\n4 d\n5 e\n6 f</code></pre>`;
    const out = cleanPastedCodeHtml(html)!;
    expect(out).toContain('<pre data-language="javascript">a\nb\nc\nd\ne\nf</pre>');
    expect(out).toContain("<p>说明</p>");
  });

  it("⑥ 空白行允许存在，序号仍按非空行连续", () => {
    const text = ["1 a", "", "2 b", "3 c", "4 d", "5 e"].join("\n");
    expect(stripPastedCodeLineNumbers(text)).toBe(["a", "", "b", "c", "d", "e"].join("\n"));
  });
});
