// 判据：mermaid 块的**代码编辑面**不许让 Backspace 冒泡到 Lexical（否则整块被删）。
//
// 来由（owner 2026-10-19 真机）：「笔记中 mermaid 块代码编辑时，退格就把整个块删掉了」。
// 真因：宿主 `createDOM` 的 `<span>` 与 `.editor-mermaid` 这一层都没有 `contentEditable={false}`，
// 而代码页的 `<textarea>` 是纯 DOM ⇒ 退格键冒泡到编辑器 root ⇒ Lexical 把 DecoratorNode 删掉。
//
// 判据（文本级，与仓内 `*.wiring.test` 同一手法）：
// ① `.editor-mermaid` 这一层必须 `contentEditable={false}`；
// ② 必须在 `onKeyDown` 里 `stopPropagation()`（⛔ 不 preventDefault，否则 textarea 自己不能用）；
// ③ 代码页仍是**受控草稿**（`editSrc`）—— 打字不直接写回节点（保存前不触发重渲染）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "MermaidNode.tsx"), "utf8");

/** 去掉注释再扫（注释里会引用这几个词，那不算实现）。 */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("mermaid 代码页：Backspace 不许把整块删掉", () => {
  it("① 外层不可编辑 ＋ 键事件不冒泡", () => {
    expect(code, "外层必须标成不可编辑").toContain("contentEditable={false}");
    expect(code, "键事件必须 stopPropagation（否则退格冒到 Lexical）").toMatch(
      /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/,
    );
    // ⛔ 不许顺手 preventDefault：那会让 textarea 自己的退格/删除失效
    expect(code, "⛔ 不许 preventDefault 掉 textarea 的按键").not.toMatch(
      /onKeyDown=\{\(e\) => \{\s*e\.preventDefault\(\)/,
    );
  });

  it("② 代码页仍是受控草稿（打字不直接写回节点）", () => {
    expect(code, "textarea 应当是受控的").toContain("value={editSrc}");
    expect(code, "改动只进草稿").toMatch(/onChange=\{\(e\) => setEditSrc\(e\.target\.value\)\}/);
    // 保存才写回（`commit` 里调 `setMermaid`）
    expect(code, "保存那一下才写回节点").toMatch(/const commit = [\s\S]{0,400}setMermaid\(/);
  });
});
