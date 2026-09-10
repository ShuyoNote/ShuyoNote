// 侧栏的收起完全依赖 `hidden` 属性（`PageTree.tsx`：`hidden={!sidebarOpen}`）。
// 但 App.css 里的 `.sidebar { display: flex }` 是**作者样式**，会压过浏览器
// 默认的 `[hidden] { display: none }`（普通作者声明优先于普通 UA 声明），
// 于是 `hidden` 形同虚设：侧栏永远可见——桌面端点活动图标收不起来，移动端
// 抽屉也关不掉（`hidden={false}` 与 `hidden=true` 长得一模一样）。
//
// 这类故障不会报错、不会警告，只在浏览器层叠里静默发生，所以用真实 App.css
// 跑一遍层叠把它钉死。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

// 测试环境把 import.meta.url 解析成 http://，拿不到 file: 路径，所以按 cwd 定位。
const APP_CSS = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

/** 在隔离的文档里注样式，返回带 hidden 的 .sidebar 的计算 display。 */
function displayWithHidden(css: string): string {
  const win = new Window();
  const style = win.document.createElement("style");
  style.textContent = css;
  win.document.head.appendChild(style);
  const el = win.document.createElement("div");
  el.className = "sidebar";
  el.setAttribute("hidden", "");
  win.document.body.appendChild(el);
  return win.getComputedStyle(el).display;
}

describe("侧栏 hidden 收起契约", () => {
  it("带 hidden 的 .sidebar 计算样式为 none（侧栏能真正收起）", () => {
    expect(displayWithHidden(APP_CSS)).toBe("none");
  });

  it("兜底规则不可被误删：少了 .sidebar[hidden] 就会退回 flex（收不起来）", () => {
    const withoutRule = APP_CSS.replace(/\.sidebar\[hidden\]\s*\{[^}]*\}/g, "");
    // 若这条兜底规则被人删掉，replace 不再是有效替换，下面两条会同时失败：
    // 前者说明规则已缺失，后者说明 bug 复现。
    expect(withoutRule).not.toBe(APP_CSS);
    expect(displayWithHidden(withoutRule)).not.toBe("none");
  });
});
