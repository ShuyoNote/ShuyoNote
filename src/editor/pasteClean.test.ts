// 判据：粘贴代码块时的**行号清理**（2026-11-04 事故 + 2026-11-26 短代码块事故）。
//
// 真机来由：
//   · 2026-11-04：飞书/语雀把代码块渲染成"行号 + 代码"，复制时行号进了正文 ⇒ 两套行号。
//   · 2026-11-26：owner 从浏览器复制一个 **3 行**代码块（行号栏一起被选中）⇒ 旧口径要求 ≥5 行
//     ⇒ 没剥 ⇒ 编辑器里又出现两套行号（截图：外层 1/2/3 + 正文 1/2/3）。
import { describe, expect, it } from "vitest";
import { cleanPastedCodeHtml, stripPastedCodeLineNumbers } from "./pasteClean";

describe("stripPastedCodeLineNumbers", () => {
  it("⑤ 3 行 + 序号后两个空格（行号栏对齐）⇒ **剥掉**（2026-11-26 那条）", () => {
    const src = "1  验证第一行\n2  验证第二行\n3  验证第三行";
    expect(stripPastedCodeLineNumbers(src)).toBe("验证第一行\n验证第二行\n验证第三行");
  });

  it("3 行 + 缩进一致时保留缩进", () => {
    const src = "  1  验证第一行\n  2  验证第二行\n  3  验证第三行";
    expect(stripPastedCodeLineNumbers(src)).toBe("  验证第一行\n  验证第二行\n  验证第三行");
  });

  it("正常代码不能被误剥：3 行、序号后只有**一个**空格 ⇒ 原样返回", () => {
    const src = "1 + 2 = 3\n2 + 3 = 5\n3 + 4 = 7";
    expect(stripPastedCodeLineNumbers(src)).toBe(src);
  });

  it("旧口径仍然成立：5 行 + 单空格（飞书/语雀形态）⇒ 剥掉", () => {
    const src = "1 互联网\n2 | https://example.com\n3 第三行\n4 第四行\n5 第五行";
    expect(stripPastedCodeLineNumbers(src)).toBe("互联网\n| https://example.com\n第三行\n第四行\n第五行");
  });

  it("序号不连续 ⇒ 不动（不是行号列）", () => {
    const src = "1  甲\n3  乙\n4  丙";
    expect(stripPastedCodeLineNumbers(src)).toBe(src);
  });

  it("有一行不是序号开头 ⇒ 整段不动", () => {
    const src = "1  甲\n这一行没有编号\n3  丙";
    expect(stripPastedCodeLineNumbers(src)).toBe(src);
  });
});

describe("cleanPastedCodeHtml", () => {
  it("没有一处变化 ⇒ null（调用方据此不接管这次粘贴）", () => {
    const html = "<pre><code>普通代码\n没有行号</code></pre>";
    expect(cleanPastedCodeHtml(html)).toBeNull();
  });

  it("3 行带行号的 <pre> ⇒ 返回清理后的 HTML（保留 pre 结构）", () => {
    const html = "<pre><code>1  验证第一行\n2  验证第二行\n3  验证第三行</code></pre>";
    const out = cleanPastedCodeHtml(html);
    expect(out).not.toBeNull();
    expect(out!).toContain("<pre");
    expect(out!).toContain("验证第一行");
    expect(out!).not.toContain("1  验证第一行");
  });
});
