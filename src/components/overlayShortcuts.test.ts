// **文档里「浮层」的两条键，真的能用吗？** —— 真按一次 Ctrl+K / Esc。
//
// `Ctrl+K`（命令面板）和 `Esc`（关闭浮层）在 shortcuts.ts 里各自算一条，但实现分散在
// 组件里：Ctrl+K 由命令面板自己 `document.addEventListener` 接管，Esc 是每个浮层各自监听的
// 约定。清单和实现分离，正是"文档写了、按下去没反应"最容易发生的地方。
//
// 面板一挂载就会拉插件列表（副作用），这里给 api 一个空实现：本测试只关心按键。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { CommandPalette } from "./CommandPalette";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { usePalette } from "../store/palette";
import { useEditorStore } from "../store/editor";
import { SHORTCUTS } from "../lib/shortcuts";

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return root;
}

/** 文档里这条快捷键（读 shortcuts.ts，不在这里抄一遍）。 */
function doc(key: string) {
  const s = SHORTCUTS.find((x) => x.key === key);
  if (!s) throw new Error(`shortcuts.ts 里没有 ${key}`);
  return s;
}

/** 按一次组合键（默认派发到 document，等同用户焦点在页面里）。 */
function press(init: KeyboardEventInit, target: EventTarget = document) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe("命令面板：Ctrl+K", () => {
  it("按 Ctrl+K 真的打开/关闭命令面板", () => {
    const s = doc("command-palette");
    expect(s.keys.join("+")).toBe("Ctrl+K");

    usePalette.setState({ open: false, query: "" });
    useEditorStore.setState({ shortcutsOpen: false });
    const root = mount(React.createElement(CommandPalette));
    expect(document.querySelector(".palette"), "默认是关着的").toBeNull();

    // flushSync 包住按键：Ctrl+K 是同步 setState，这样 DOM 断言才看得到渲染结果。
    const open = flushSync(() => press({ key: "k", ctrlKey: true }));
    expect(usePalette.getState().open, "Ctrl+K 应当打开面板").toBe(true);
    expect(document.querySelector(".palette"), "面板 DOM 应当出现").not.toBeNull();
    expect(open.defaultPrevented, "拦下浏览器默认行为").toBe(true);

    flushSync(() => press({ key: "k", ctrlKey: true }));
    expect(usePalette.getState().open, "再按一次应当关上").toBe(false);

    flushSync(() => root.unmount());
  });
});

describe("浮层：Esc 关闭", () => {
  it("快捷键面板开着时按 Esc 真的关掉", () => {
    const s = doc("close");
    expect(s.keys).toEqual(["Esc"]);

    useEditorStore.setState({ shortcutsOpen: true });
    const root = mount(React.createElement(ShortcutsPanel));
    expect(document.querySelector(".shortcuts-panel, .shortcuts"), "面板应当渲染出来").not.toBeNull();

    press({ key: "Escape" }, window);
    expect(useEditorStore.getState().shortcutsOpen, "Esc 应当关闭浮层").toBe(false);

    flushSync(() => root.unmount());
  });
});
