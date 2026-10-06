// 「块手势排除清单」的判据 —— 它挡的是**两次同形事故**：
//   2026-10-01 与 2026-10-06，owner 两次实测「拖表格列宽 ⇒ 弹出『已选 1 块 ｜ 多选模式 ｜ 复制 ｜ 删除 ｜ 清空』」。
//   第一次只补了 `BlockSelectionPlugin` 那份手抄清单 ⇒ 第二次换 `ClickToEditPlugin` 的框选复现 ✗。
// ⇒ 现在两组手势（点块选 / 空白框选）共用 `blockGestures.ts` 这一份 ✓，本测试钉住"手柄必须被排除"✓
//   以及"别把正文/表格单元格本身也排除掉"✗（那会让正常块选手势整个失灵 ✓）。
import { describe, expect, it } from "vitest";
import { BLOCK_GESTURE_EXCLUDED_SELECTOR, isBlockGestureExcluded } from "./blockGestures";

const el = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
};

describe("isBlockGestureExcluded：块手势该放行哪些浮层/手柄", () => {
  it("★ 表格列宽手柄**必须**被排除（两次事故的主角）", () => {
    expect(isBlockGestureExcluded(el(`<div class="table-resize-handle"></div>`))).toBe(true);
  });

  it("★ 手柄里的子元素/文字也要算（closest 往上找祖先，不能只比 target 自己）", () => {
    const handle = el(`<div class="table-resize-handle"><span class="hit"></span></div>`);
    expect(isBlockGestureExcluded(handle.querySelector(".hit"))).toBe(true);
    // 文字节点：先取 parentElement 再 closest ✓
    const textEl = handle.querySelector(".hit") as HTMLElement;
    textEl.appendChild(document.createTextNode("x"));
    expect(isBlockGestureExcluded(textEl.firstChild)).toBe(true);
  });

  it("块手柄 / 块选工具条 / 文字工具条 / 斜杠菜单 同样排除", () => {
    for (const cls of [
      "block-handle",
      "block-grip-menu",
      "block-selection-bar",
      "block-select-mode-btn",
      "selection-toolbar",
      "tag-picker",
      "slash-menu",
    ]) {
      expect(isBlockGestureExcluded(el(`<div class="${cls}"></div>`)), cls).toBe(true);
    }
  });

  it("⛔ 正文段落、表格单元格、编辑器本身**不许**被排除（否则正常块选/框选全失灵）", () => {
    for (const html of [
      `<p class="editor-paragraph">正文</p>`,
      `<td class="table-cell">单元格</td>`,
      `<div class="editor-content"></div>`,
      `<div class="editor-shell"></div>`,
    ]) {
      expect(isBlockGestureExcluded(el(html)), html).toBe(false);
    }
  });

  it("target 取不到元素（null / 纯文本节点无父元素）⇒ 不算排除，交回原逻辑", () => {
    expect(isBlockGestureExcluded(null)).toBe(false);
    expect(isBlockGestureExcluded(document.createTextNode("裸文本"))).toBe(false);
  });

  it("选择器本身把 8 个类都写进去了（防止有人删元素时漏掉一项 ✓）", () => {
    for (const cls of [
      ".block-handle",
      ".block-grip-menu",
      ".block-selection-bar",
      ".block-select-mode-btn",
      ".selection-toolbar",
      ".tag-picker",
      ".slash-menu",
      ".table-resize-handle",
    ]) {
      expect(BLOCK_GESTURE_EXCLUDED_SELECTOR).toContain(cls);
    }
  });
});
