// 渲染期错误的边界：**崩一个组件不能带走整个界面**。
//
// 这条测试来自 1.85.1 的真实事故：`CommandPalette` 一个 hooks 越界，因为根部没有边界，
// React 卸载了整棵树 → 用户看到纯白屏。所以这里钉两件事：
//   1. 边界内的组件抛错时，边界外的兄弟节点**继续渲染**（界面还能用）；
//   2. 错误**看得见**（就地提示文本），不是静默消失——静默吞掉只会让排查变猜谜。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { PanelBoundary } from "./PanelBoundary";

function Boom(): React.ReactElement {
  throw new Error("浮层炸了");
}

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // React 会把捕获到的渲染错误再打一遍到 console.error：测试里静音，输出才看得清断言
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  flushSync(() => root.render(node));
  return { root, host, restore: () => spy.mockRestore() };
}

describe("渲染期错误边界", () => {
  it("边界内的浮层崩溃时，边界外的界面照常渲染（不白屏）", () => {
    const { host, root, restore } = mount(
      React.createElement(
        "div",
        null,
        React.createElement("span", { id: "shell" }, "界面还在"),
        React.createElement(PanelBoundary, { name: "命令面板" }, React.createElement(Boom)),
      ),
    );

    expect(host.querySelector("#shell")?.textContent, "兄弟节点必须活下来").toBe("界面还在");
    const notice = host.querySelector(".panel-error");
    expect(notice, "崩溃要就地留下可见提示").not.toBeNull();
    expect(notice?.textContent).toContain("命令面板");
    expect(notice?.textContent, "提示里要带上原始错误文本").toContain("浮层炸了");
    expect(host.querySelector(".editor-error"), "编辑器那套兜底文案不该被借用").toBeNull();

    flushSync(() => root.unmount());
    restore();
  });

  it("没出错时边界是透明的（不改变子树结构，也不留提示）", () => {
    const { host, root, restore } = mount(
      React.createElement(PanelBoundary, { name: "命令面板" }, React.createElement("b", null, "正常内容")),
    );
    expect(host.textContent).toBe("正常内容");
    expect(host.querySelector(".panel-error")).toBeNull();
    flushSync(() => root.unmount());
    restore();
  });

  it("fallback 传函数时能拿到错误对象（整屏兜底靠它显示错在哪）", () => {
    const seen: string[] = [];
    const { root, restore } = mount(
      React.createElement(
        ErrorBoundary,
        {
          label: "应用",
          fallback: (error: Error | null) => {
            seen.push(String(error?.message ?? "无"));
            return React.createElement("div", null, "兜底屏");
          },
        },
        React.createElement(Boom),
      ),
    );
    // 关键性质：**第一次**调用就带着真实错误（否则用户可能先看到「未知错误」并照着它反馈）；
    // React 出错恢复时可能再渲染一次兜底，所以这里只要求"每次都是真实错误"、不数字数。
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["浮层炸了"]));
    flushSync(() => root.unmount());
    restore();
  });
});
