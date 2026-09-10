// 「Ctrl/⌘+B 开合侧栏」的守卫。
//
// 为什么值得单测：编辑器里 Ctrl/⌘+B 是**加粗**（Lexical RichTextPlugin 自带），
// 一旦守卫漏掉「编辑中」这一条，用户想加粗就会把侧栏收起来——而侧栏收起、
// 加粗失效这两件事都可能被当成「偶发」而长期没人报。这类回归靠肉眼几乎发现不了。
import { describe, expect, it } from "vitest";
import { isSidebarToggleKey } from "./useGlobalShortcuts";

describe("侧栏快捷键 Ctrl/⌘+B 守卫", () => {
  it("Ctrl+B（非编辑态）开合侧栏", () => {
    expect(isSidebarToggleKey({ key: "b", ctrlKey: true })).toBe(true);
  });

  it("⌘+B（非编辑态）开合侧栏", () => {
    expect(isSidebarToggleKey({ key: "b", metaKey: true })).toBe(true);
  });

  it("大写 B（按住 Shift 的另一条路径）也按小写识别", () => {
    expect(isSidebarToggleKey({ key: "B", ctrlKey: true })).toBe(true);
  });

  it("编辑器内不拦截——把加粗留给编辑器", () => {
    expect(isSidebarToggleKey({ key: "b", ctrlKey: true, inEditable: true })).toBe(false);
    expect(isSidebarToggleKey({ key: "b", metaKey: true, inEditable: true })).toBe(false);
  });

  it("带 Shift 的组合不抢（Ctrl+Shift+B 另有用途）", () => {
    expect(isSidebarToggleKey({ key: "B", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("无修饰键、或其它按键都不触发", () => {
    expect(isSidebarToggleKey({ key: "b" })).toBe(false);
    expect(isSidebarToggleKey({ key: "n", ctrlKey: true })).toBe(false);
    expect(isSidebarToggleKey({ key: "", ctrlKey: true })).toBe(false);
  });
});
