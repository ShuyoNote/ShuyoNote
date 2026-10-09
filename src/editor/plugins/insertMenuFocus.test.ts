import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ⭐ **R162 判据**：插入块菜单执行项之前必须**先**把焦点还给编辑器 ✓。
//   现场（owner 2026-10-08 Console 逐字）：
//     Error: updateEditor: selection has been lost because the previously selected nodes have been removed…
//       at runAtBlock — BlockInsertPlugin.tsx:163 ← at select — :360
//   真因：`option.run(editor)` 先跑、`editor.focus()` 排在**后面** ✗ ⇒ 多数项的 run 直接 editor.update()
//   落在**丢了选区的旧状态**上 ⇒ 抛这句 ✓（代码块／分隔线／Mermaid 图块都中 ✓，一直如此 ✓）。
describe("R162：插入块菜单执行前先 focus", () => {
  it("★ 源码里 `editor.focus()` 必须出现在 `option.run(editor)` **之前** ✓", () => {
    const src = readFileSync(join(__dirname, "BlockInsertPlugin.tsx"), "utf8");
    const iRun = src.indexOf("option.run(editor);");
    expect(iRun, "找不到 option.run(editor) ✗（改名了就同步改本判据 ✓）").toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, iRun - 400), iRun);
    expect(
      before.includes("editor.focus()"),
      "`option.run` 之前必须有 `editor.focus()` ✓（⛔ 只有事后那句 ⇒ 会抛 selection has been lost ✗）",
    ).toBe(true);
  });
});
