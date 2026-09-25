// 页面树拖影（`TreeDragGhost`）的判据。
//
// 为什么单独测这个 20 行组件（2026-09-25）：它原先写在 `PageTree` 内部，而它订阅的 x/y 是
// **每帧都在变**的（`treeDrag.cursor()` 在 mousemove 里调）⇒ 拖一次树，整个侧栏（1180 行，
// 含空间列表、整棵页面树 JSX）就跟着 60fps 重渲染。拆成独立组件之后，每帧重渲染的只剩它。
//
// 这里钉住的是**拆分本身的行为风险**（拆完拖影还对不对）：
//   · 没在拖 ⇒ 什么都不渲染；在拖 ⇒ 标题 + 跟随光标的位置（x+12 / y+8）；
//   · 光标移动时位置真的跟着变（订阅没被拆断）；
//   · 三种 kind 渲染出的图标互不相同（icon 三元没写错）。
// 至于"每帧只重渲染这一个小东西"这条性能性质，**测试测不到**（需要渲染计数），只能靠
// `TreeDragGhost.tsx` 头部的注释与评审守住——门禁也看不到它（订阅关系是"正确"的选择器）。
//
// 本仓的组件测试惯例：不用 @testing-library，直接用 `react-dom/client` + `flushSync`
// （见 `DatetimeValueEditor.test.tsx`）。
import { beforeEach, describe, expect, it } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import { TreeDragGhost } from "./TreeDragGhost";
import { useTreeDrag } from "../store/treeDrag";

function mount(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(ui));
  return {
    host,
    ghost: () => host.querySelector(".tree-drag-ghost") as HTMLElement | null,
    title: () => host.querySelector(".tree-ghost-title")?.textContent ?? null,
    iconHtml: () => host.querySelector(".tree-ghost-icon")?.innerHTML ?? "",
    unmount: () => {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

/** 从 store 侧驱动（模拟 mousemove 里那次 `cursor()`），并同步 flush 到 React。 */
const drag = {
  start: (label: string, kind?: string) => flushSync(() => useTreeDrag.getState().start("node-1", label, kind)),
  cursor: (x: number, y: number) => flushSync(() => useTreeDrag.getState().cursor(x, y)),
  end: () => flushSync(() => useTreeDrag.getState().end()),
};

describe("TreeDragGhost · 页面树拖影", () => {
  beforeEach(() => {
    // ⚠️ `end()` 只清 draggingId/label/kind/overId/zone/expandId，**不重置 x/y**
    //    （见 `store/treeDrag.ts`）⇒ 用例之间要自己归零，否则坐标会从上一条漏过来。
    useTreeDrag.getState().end();
    useTreeDrag.setState({ x: 0, y: 0 });
  });

  it("没有正在拖的节点时什么都不渲染", () => {
    const m = mount(<TreeDragGhost />);
    expect(m.ghost()).toBeNull();
    m.unmount();
  });

  it("在拖时渲染标题，并跟随光标（偏移 +12 / +8）", () => {
    useTreeDrag.setState({ draggingId: "node-1", label: "我的笔记", kind: "page", x: 100, y: 50 });
    const m = mount(<TreeDragGhost />);

    expect(m.ghost()).not.toBeNull();
    expect(m.title()).toBe("我的笔记");
    expect(m.ghost()!.style.left).toBe("112px");
    expect(m.ghost()!.style.top).toBe("58px");

    m.unmount();
  });

  it("光标移动（cursor）时位置跟着更新 —— 订阅没被拆断", () => {
    drag.start("我的笔记");
    const m = mount(<TreeDragGhost />);
    expect(m.ghost()!.style.left).toBe("12px");

    drag.cursor(300, 200);

    expect(m.ghost()!.style.left).toBe("312px");
    expect(m.ghost()!.style.top).toBe("208px");
    m.unmount();
  });

  it("拖拽结束（end）后拖影消失", () => {
    drag.start("我的笔记");
    const m = mount(<TreeDragGhost />);
    expect(m.ghost()).not.toBeNull();

    drag.end();

    expect(m.ghost()).toBeNull();
    m.unmount();
  });

  it("三种 kind 渲染出的图标互不相同（folder / database / page）", () => {
    const seen = new Set<string>();
    for (const kind of ["page", "folder", "database"]) {
      useTreeDrag.setState({ draggingId: "n", label: "节点", kind, x: 0, y: 0 });
      const m = mount(<TreeDragGhost />);
      seen.add(m.iconHtml());
      m.unmount();
    }
    expect(seen.size, "三种 kind 应当渲染出三种不同的图标").toBe(3);
  });
});
