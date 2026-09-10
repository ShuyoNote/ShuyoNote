// **文档里写的全局快捷键，真的能用吗？** —— 用真键盘事件走一遍。
//
// 为什么值得单独一套：`src/lib/shortcuts.ts` 是快捷键清单的单一来源（快捷键面板、文档、
// tooltip 都读它），而"清单"和"handler"在两个文件里——docs/free-site-export-guide.md 里
// 记着一次真实事故：「曾出『快捷键清单不准』双源漂移」。清单写错或 handler 被改掉，
// 界面上几乎不会有人发现（按下去没反应，用户只会以为自己按错了）。
//
// 这里不测静态文本，而是**派发真的 keydown**，看 store/回调有没有动——测的是行为。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { useActivity } from "../store/activity";
import { SHORTCUTS } from "../lib/shortcuts";

/** 挂一个只跑快捷键 hook 的宿主组件。 */
function mountHarness(onToggleView: () => void) {
  function Harness() {
    useGlobalShortcuts(onToggleView);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Harness)));
  return root;
}

/** 派发一次按键（默认目标是 document.body，即"非编辑态"）。 */
function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** 文档里这条快捷键的修饰键 → KeyboardEventInit（读 shortcuts.ts，避免在这里抄一遍）。 */
function comboOf(key: string): KeyboardEventInit {
  const s = SHORTCUTS.find((x) => x.key === key);
  if (!s) throw new Error(`shortcuts.ts 里没有 ${key}`);
  const init: KeyboardEventInit = { key: "", ctrlKey: false, altKey: false, shiftKey: false };
  for (const k of s.keys) {
    if (k === "Ctrl") init.ctrlKey = true;
    else if (k === "Alt") init.altKey = true;
    else if (k === "Shift") init.shiftKey = true;
    else init.key = k === "Space" ? " " : k;
  }
  return init;
}

describe("全局快捷键（照文档逐条按键）", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  const realCreatePage = useNotes.getState().createPage;
  let createPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createPage = vi.fn(async () => "new-id");
    // 观测 createPage 而不碰真实 api：zustand 允许局部替换 store 里的函数。
    useNotes.setState({ createPage: createPage as never });
    useEditorStore.setState({ shortcutsOpen: false });
    useActivity.setState({ sidebarOpen: true });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    useNotes.setState({ createPage: realCreatePage });
    document.body.innerHTML = "";
  });

  it("Ctrl+N（新建页面）：文档说全局 → 真的建页", () => {
    root = mountHarness(() => {});
    const e = press(comboOf("new-page"));
    expect(createPage).toHaveBeenCalledWith(null);
    expect(e.defaultPrevented, "拦下默认行为（否则浏览器会开新窗口）").toBe(true);
  });

  it("Ctrl+N 在输入框/编辑器里不抢（否则会和输入冲突）", () => {
    root = mountHarness(() => {});
    const input = document.createElement("input");
    document.body.appendChild(input);
    const e = press(comboOf("new-page"), input);
    expect(createPage).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Ctrl+E（循环视图）：文档说调 onToggleView", () => {
    const onToggle = vi.fn();
    root = mountHarness(onToggle);
    press(comboOf("cycle-view"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+B（开合侧栏）：非编辑态收起/展开", () => {
    root = mountHarness(() => {});
    press(comboOf("toggle-sidebar"));
    expect(useActivity.getState().sidebarOpen).toBe(false);
    press(comboOf("toggle-sidebar"));
    expect(useActivity.getState().sidebarOpen).toBe(true);
  });

  it("Ctrl+B 在编辑器里让给「加粗」——这正是这条守卫存在的理由", () => {
    root = mountHarness(() => {});
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);
    const e = press(comboOf("toggle-sidebar"), editable);
    expect(useActivity.getState().sidebarOpen, "不抢编辑器里的加粗").toBe(true);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Ctrl+/ 与 ?（快捷键面板）：全局都能开，但 ? 不在输入态抢", () => {
    root = mountHarness(() => {});
    press(comboOf("shortcuts"));
    expect(useEditorStore.getState().shortcutsOpen).toBe(true);

    useEditorStore.setState({ shortcutsOpen: false });
    press({ key: "?", shiftKey: true });
    expect(useEditorStore.getState().shortcutsOpen).toBe(true);

    // 编辑器里打 "?" 是正常输入，不能被抢
    useEditorStore.setState({ shortcutsOpen: false });
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);
    press({ key: "?", shiftKey: true }, editable);
    expect(useEditorStore.getState().shortcutsOpen).toBe(false);
  });

  it("Ctrl+Shift+F（聚焦搜索）：把焦点交给搜索框", () => {
    root = mountHarness(() => {});
    const input = document.createElement("input");
    input.id = "global-search-input";
    document.body.appendChild(input);
    press(comboOf("focus-search"));
    expect(document.activeElement).toBe(input);
  });
});
