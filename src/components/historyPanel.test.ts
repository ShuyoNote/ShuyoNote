// 版本历史弹层的**返回栈登记 + Esc** 回归测试。
//
// 为什么值得钉：真机复验（2026-09-15）抓到这一层**根本没登记进浮层栈**——
// 只开着版本历史时 `window.__SHUYONOTE_BACK__.depth()` 是 **0**，于是 Android 返回键
// 直接退出应用，而弹层还开着（与「19 层浮层全部登记」的说法不符）。
// 这一条不是"少关一层"那么轻：`depth=0` ⇒ `handle()` 返回 false ⇒ 壳层放行返回键 ⇒ **退出应用**。
//
// 静态门禁（`scripts/check-overlay-registry.mjs`）只能看出"这个组件有没有调用
// `useOverlayLayer`"；**真的登记进去了没有**（open 的时候在栈里、close 之后出栈、
// Esc 真的关得掉）只有把组件挂起来点一遍才知道——所以两条一起钉。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 弹层一打开就去拉版本列表（副作用）。本测试只关心浮层栈与键盘，给个空实现。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { HistoryPanel } from "./HistoryPanel";
import { closeTopOverlay, overlayDepth, overlayIds, resetOverlayStackForTest } from "../lib/overlayStack";

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(HistoryPanel, { pageId: "p1" })));
  return root;
}

/** 工具条上那个时钟按钮（弹层的唯一触发器）。 */
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="版本历史"]');
const popover = () => document.querySelector(".history-popover");

beforeEach(() => {
  // 栈是模块级全局状态：不清干净，上一条用例留下的层会把 depth 断言污染掉。
  resetOverlayStackForTest();
  document.body.innerHTML = "";
});

afterEach(() => {
  resetOverlayStackForTest();
  document.body.innerHTML = "";
});

describe("版本历史弹层 · Android 返回键", () => {
  it("打开后登记进浮层栈（depth=1、id=history），关掉后出栈", () => {
    const root = mount();
    expect(overlayDepth(), "没打开时不该占着栈").toBe(0);

    flushSync(() => trigger()!.click());
    expect(popover(), "弹层应当渲染出来").not.toBeNull();
    expect(overlayDepth(), "打开后必须在栈里——depth=0 就是返回键退出应用那个 bug").toBe(1);
    expect(overlayIds()).toContain("history");

    flushSync(() => trigger()!.click());
    expect(popover()).toBeNull();
    expect(overlayDepth(), "关掉后要出栈").toBe(0);

    flushSync(() => root.unmount());
  });

  it("返回键这一路真的关得掉它（closeTopOverlay ⇒ 弹层消失）", () => {
    const root = mount();
    flushSync(() => trigger()!.click());
    expect(overlayDepth()).toBe(1);

    // 壳层 Kotlin 侧走的就是这条：`__SHUYONOTE_BACK__.handle()` ⇒ closeTopOverlay()。
    let handled = false;
    flushSync(() => {
      handled = closeTopOverlay();
    });
    expect(handled, "栈非空时 handle() 必须是 true（否则壳层会放行返回键去退出应用）").toBe(true);
    expect(popover(), "关的必须是这一层，不是只把栈弹空").toBeNull();
    expect(overlayDepth(), "关完栈就空了").toBe(0);
    expect(closeTopOverlay(), "栈空时 handle() 返回 false —— 这时才轮到返回键退出应用").toBe(false);

    flushSync(() => root.unmount());
  });

  it("Esc 关得掉（与其它浮层同一条既有做法：window keydown）", () => {
    const root = mount();
    flushSync(() => trigger()!.click());
    expect(popover()).not.toBeNull();

    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover(), "Esc 应当关闭弹层").toBeNull();
    expect(overlayDepth(), "Esc 关掉之后也要出栈").toBe(0);

    flushSync(() => root.unmount());
  });

  it("没打开时按 Esc 不产生任何副作用（不许凭空登记/注销一层）", () => {
    const root = mount();
    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(overlayDepth()).toBe(0);
    flushSync(() => root.unmount());
  });
});
