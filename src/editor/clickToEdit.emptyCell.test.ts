import { describe, expect, it, beforeEach } from "vitest";
import { isSafeMarqueeTarget } from "./plugins/ClickToEditPlugin";

/**
 * ⭐ **2026-10-28（owner：「表格的空单元格，鼠标不能点击聚焦输入？」）**：
 * 空单元格以前被判成"空白安全区" ⇒ `mousedown` 里 `preventDefault()` 抢掉了浏览器落光标 ⇒
 * 点了不聚焦、打不了字 ✗。判据就是下面这几条（单元格一律不是框选区）。
 */
function mountEditor() {
  document.body.innerHTML = `
    <div class="editor-shell">
      <div class="editor-content" contenteditable="true">
        <p id="blankP"></p>
        <table><tbody><tr>
          <td id="emptyCell"><p id="emptyCellP"><br></p></td>
          <td id="textCell"><p id="textCellP">有字</p></td>
        </tr></tbody></table>
      </div>
    </div>
    <div id="outside">外面</div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return { blankP: $("blankP"), emptyCell: $("emptyCell"), emptyCellP: $("emptyCellP"), textCellP: $("textCellP"), outside: $("outside") };
}

describe("ClickToEditPlugin：空单元格要能落光标（不是框选安全区）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("点空格子（td 本身 / 格内空段落）⇒ 不算框选安全区", () => {
    const { emptyCell, emptyCellP } = mountEditor();
    expect(isSafeMarqueeTarget(emptyCell), "空 td 本身").toBe(false);
    expect(isSafeMarqueeTarget(emptyCellP), "格内那个空 <p>").toBe(false);
  });

  it("有字的格子当然也不是（文字优先）", () => {
    const { textCellP } = mountEditor();
    expect(isSafeMarqueeTarget(textCellP)).toBe(false);
  });

  it("别处仍然能框选：空白段落 / 编辑器根 / 壳", () => {
    const { blankP } = mountEditor();
    expect(isSafeMarqueeTarget(blankP), "空白段落（原有行为 ✓）").toBe(true);
    expect(isSafeMarqueeTarget(document.querySelector(".editor-content")!)).toBe(true);
    expect(isSafeMarqueeTarget(document.querySelector(".editor-shell")!)).toBe(true);
  });

  it("编辑器外面永远不算", () => {
    const { outside } = mountEditor();
    expect(isSafeMarqueeTarget(outside)).toBe(false);
  });

  it("文本节点（真按在字上）⇒ 交给浏览器做文字选择", () => {
    const { textCellP } = mountEditor();
    const textNode = textCellP.firstChild!;
    expect(isSafeMarqueeTarget(textNode)).toBe(false);
  });
});
