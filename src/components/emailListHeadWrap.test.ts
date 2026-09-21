// 邮箱列表头在**窄面板**下的换行契约（2026-09-20 用户截图：标题被挤成竖排、批量按钮的文字叠在一起、
// 「共 N 封」被挤出面板）。
//
// 这类故障不会报错、不会警告，只在浏览器的 flex 布局里静默发生：面板能拖到 300px 出头，
// 而这一行原来有 6 个不收缩的元素 + 一个会缩的标题 ⇒ 标题缩成"邮\n件"、按钮互相压。
//
// 这里**读真正的 App.css**、用 happy-dom 的计算样式判"那三条规则在不在"：
//   ① `.email-list-head` 允许换行；
//   ② 右侧整组 `.email-list-head-right` 用 `wrap-reverse`（「共 N 封」留在上一行右端、按钮掉下一行）；
//   ③ 按钮 `flex: none`（宁可整组换行，也不许被压扁成文字溢出）。
// 末条是**变异读数**：把规则删掉后计算值确实会变 —— 证明这三条断言真能咬住那个 bug。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

// 测试环境把 import.meta.url 解析成 http://，拿不到 file: 路径，所以按 cwd 定位。
const APP_CSS = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

/** `flex: none` 的两种等价写法（happy-dom 会正规化成后者）。 */
const NOT_SHRINKING = ["none", "0 0 auto"];

/** 在隔离文档里注样式，返回某个 class 的某个计算属性。 */
function computed(css: string, className: string, prop: string, tag = "div"): string {
  const win = new Window();
  const style = win.document.createElement("style");
  style.textContent = css;
  win.document.head.appendChild(style);
  const el = win.document.createElement(tag);
  el.className = className;
  win.document.body.appendChild(el);
  return win.getComputedStyle(el).getPropertyValue(prop);
}

describe("邮箱列表头：窄面板下必须能整组换行", () => {
  it("① 头部允许换行（少了它，整行挤在一行里、标题被压成竖排）", () => {
    expect(computed(APP_CSS, "email-list-head", "flex-wrap")).toBe("wrap");
  });

  it("★ 右侧整组用 wrap-reverse：「共 N 封」留在上一行右端，批量按钮掉到下一行", () => {
    expect(computed(APP_CSS, "email-list-head-right", "flex-wrap")).toBe("wrap-reverse");
  });

  it("② 批量按钮不许被压缩（宁可换行，也不许文字溢出到邻居身上）", () => {
    // happy-dom 把 `flex: none` 正规化成 `0 0 auto`（= grow 0 / shrink 0 / basis auto），两种写法都收
    expect(NOT_SHRINKING).toContain(computed(APP_CSS, "email-list-head-delete", "flex", "button"));
    expect(NOT_SHRINKING).toContain(computed(APP_CSS, "email-list-head-op", "flex", "button"));
  });

  it("③ 计数按钮不换行、不参与收缩", () => {
    expect(computed(APP_CSS, "email-list-head-count", "white-space", "button")).toBe("nowrap");
    expect(NOT_SHRINKING).toContain(computed(APP_CSS, "email-list-head-count", "flex", "button"));
  });

  it("变异：把这三条规则删掉 ⇒ 计算值当场变回去（判据不是恒绿）", () => {
    const mutated = APP_CSS.replace(/\.email-list-head\s*\{[^}]*\}/, "")
      .replace(/\.email-list-head-right\s*\{[^}]*\}/, "")
      .replace(/\.email-list-head-delete\s*\{[^}]*\}/, "");
    expect(mutated).not.toBe(APP_CSS);
    expect(computed(mutated, "email-list-head", "flex-wrap")).not.toBe("wrap");
    expect(computed(mutated, "email-list-head-right", "flex-wrap")).not.toBe("wrap-reverse");
    expect(NOT_SHRINKING).not.toContain(computed(mutated, "email-list-head-delete", "flex", "button"));
  });
});
