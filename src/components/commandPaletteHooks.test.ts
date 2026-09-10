// 命令面板的 **hooks 顺序**回归测试。
//
// 为什么值得单开一条：这类故障不会报错、不会警告，只会让**按 Ctrl+K 直接抛错**
// （React：「Rendered more hooks than during the previous render」）。M11.8 加参数表单
// 时把三个 `useState` 放在了 `if (!open) return null` 之后：面板关闭时少调 3 个 hooks、
// 打开时又多调 3 个，于是打开动作本身就把组件渲染炸掉——而当时的验证全是
// vitest/tsc/cargo test 这类**不看 DOM 的**检查，一个都没拦住。
//
// 所以这里真的把组件挂起来、开一次、关一次：只有渲染能发现「hooks 有条件调用」。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 面板一挂载就会拉插件列表（副作用）。这里给一个空实现：本测试只关心渲染是否成立，
// 不想把 web 平台驱动（sql.js / fetch）拖进来。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { CommandPalette } from "./CommandPalette";
import { usePalette } from "../store/palette";
import { usePlugins } from "../store/plugins";

/** 挂一个空容器并返回同步 render / unmount 的句柄（flushSync：渲染立刻发生，错误才抛得出来）。 */
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    root,
    render: (next: React.ReactElement) => flushSync(() => root.render(next)),
    host,
  };
}

describe("命令面板打开 / 关闭不违反 hooks 规则", () => {
  it("关闭态挂载 → 打开 → 关闭，全程不抛错", () => {
    usePalette.setState({ open: false, query: "" });
    const { render, root } = mount();

    // 关闭态：面板返回 null，但 hooks 必须照样跑完
    expect(() => render(React.createElement(CommandPalette))).not.toThrow();

    // 打开：hook 数量若因条件调用而与上一轮不同，这里就会抛
    expect(() => flushSync(() => usePalette.getState().setOpen(true))).not.toThrow();
    expect(document.querySelector(".palette")).not.toBeNull();

    // 关闭：少调 hooks 同样会抛（React 两个方向都拦）
    expect(() => flushSync(() => usePalette.getState().setOpen(false))).not.toThrow();
    expect(document.querySelector(".palette")).toBeNull();

    flushSync(() => root.unmount());
  });

  it("参数表单走一遍再关面板也不抛（参数表单状态就是当年越界的那三个 useState）", () => {
    usePlugins.setState({
      plugins: [
        {
          id: "demo",
          name: "演示插件",
          version: "1.0.0",
          description: "",
          enabled: true,
          commands: [
            {
              id: "demo.todo",
              title: "写一条待办",
              description: "",
              close_on_run: false,
              menus: [],
              params: [{ name: "text", label: "内容", type: "string", required: true, placeholder: "", options: [] }],
            },
          ],
          permissions: [],
          permissions_baseline: false,
          events: [],
          runtime: "logic",
          views: [],
        } as never,
      ],
      running: null,
    });
    usePalette.setState({ open: false, query: "" });
    const { render, root } = mount();
    render(React.createElement(CommandPalette));
    flushSync(() => usePalette.getState().setOpen(true));

    const item = [...document.querySelectorAll(".palette-item")].find((el) =>
      (el.textContent ?? "").includes("写一条待办"),
    );
    expect(item, "带参数的命令应当出现在面板里").toBeTruthy();
    flushSync(() => (item as HTMLElement).click());
    expect(document.querySelector(".palette-form"), "点开后就地切成参数表单").not.toBeNull();

    // 表单开着时关掉面板 / 再打开：两条渲染路径交替，hooks 顺序仍必须一致
    expect(() => flushSync(() => usePalette.getState().setOpen(false))).not.toThrow();
    expect(() => flushSync(() => usePalette.getState().setOpen(true))).not.toThrow();

    flushSync(() => root.unmount());
  });
});
