// **菜单里的插件命令真的连到"那一页"了吗？** —— 挂起来点一遍。
//
// 为什么必须是渲染级测试：`page.context`（页面列表行菜单）这条链是
// 「插件清单 → 过滤 → 菜单里的按钮 → 跑命令时把**被点的那一页**当当前页」。
// 中间任何一环接错都**不会报错**：
//   - 传成"现在打开的那一页" → 「导出这一页」导出的是别人（比没这个入口更糟）；
//   - 忘了过滤启用状态 → 停用的插件仍在菜单里露脸；
//   - 带参数的命令直接在菜单里跑 → 用户在没有任何表单的情况下收到 bad_args。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const runPluginCommandWithUi = vi.fn(async () => ({ message: "跑完了", cancelled: false }));
vi.mock("../lib/pluginRun", () => ({
  runPluginCommandWithUi: (...args: unknown[]) => runPluginCommandWithUi(...(args as [])),
}));

import { PluginMenuItems } from "./PluginMenuItems";
import { usePlugins } from "../store/plugins";
import { usePalette } from "../store/palette";
import { useToast } from "../store/toast";
import type { PluginMeta } from "../types";

const cmd = (id: string, menus: string[], params: unknown[] = []) => ({
  id,
  title: `命令 ${id}`,
  description: "",
  close_on_run: false,
  params,
  menus,
});

const plugin = (id: string, enabled: boolean, commands: unknown[]): PluginMeta =>
  ({
    id,
    name: `插件 ${id}`,
    version: "1.0.0",
    description: "",
    enabled,
    commands,
    permissions: [],
    permissions_baseline: false,
    events: [],
    runtime: "logic",
    views: [],
    triggers: [],
    approval: { required: false, added_permissions: [], added_events: [], approved_version: "" },
  }) as unknown as PluginMeta;

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return root;
}

const buttonFor = (commandId: string) =>
  document.querySelector(`.plugin-menu-item[data-command="${commandId}"]`) as HTMLElement | null;

describe("菜单里的插件命令（page.context）", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    runPluginCommandWithUi.mockClear();
    usePalette.setState({ open: false, query: "" });
    useToast.setState({ toasts: [] });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    usePlugins.setState({ plugins: [] });
    document.body.innerHTML = "";
  });

  it("只列这个入口的、且是启用中的插件命令；没有就整块不渲染", () => {
    usePlugins.setState({
      plugins: [
        plugin("on", true, [cmd("on.ctx", ["page.context"]), cmd("on.slash", ["slash"])]),
        plugin("off", false, [cmd("off.ctx", ["page.context"])]),
      ],
    });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "p1" }));
    expect(buttonFor("on.ctx"), "启用中且声明了 page.context 的应当出现").not.toBeNull();
    expect(buttonFor("on.slash"), "别的入口的命令不该漏进来").toBeNull();
    expect(buttonFor("off.ctx"), "停用的插件不该露脸").toBeNull();

    flushSync(() => root!.unmount());
    // 一条插件命令都没有时：连"插件命令"这个分组标题都不该出现
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.slash", ["slash"])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "p1" }));
    expect(document.querySelector(".plugin-menu-title")).toBeNull();
  });

  it("点一下真的跑那条命令，而且「当前页」是**被点的那一页**", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["page.context"])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "page-42" }));

    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(runPluginCommandWithUi).toHaveBeenCalled());
    // 第 5 个参数是"宿主给的入参"：这个入口不传（只有 file.context 那类才传），所以是 undefined
    expect(runPluginCommandWithUi).toHaveBeenCalledWith("「命令 on.ctx」", "on", "on.ctx", "page-42", undefined);
  });

  it("跑完把结果说给用户（导出/草稿确认的文案都从这儿出去）", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["page.context"])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "p1" }));
    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(useToast.getState().toasts.some((t) => t.message === "跑完了")).toBe(true));
  });

  it("带参数的命令不在这里跑：转交命令面板（表单只实现一份）", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["page.context"], [{ name: "x" }])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "p1" }));
    expect(buttonFor("on.ctx")!.textContent, "菜单里要标出需要填参数").toContain("需填参数");

    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(runPluginCommandWithUi, "没有表单就跑，用户只会收到 bad_args").not.toHaveBeenCalled();
    expect(usePalette.getState().open).toBe(true);
    expect(usePalette.getState().query).toBe("命令 on.ctx");
  });

  it("点完通知调用方（行菜单靠它把自己收起来）", async () => {
    const onDone = vi.fn();
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["page.context"])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "page.context", pageId: "p1", onDone }));
    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDone).toHaveBeenCalled();
  });

  // 宿主自己给入参时（文件右键菜单：`{ fileName, size, mime }`），**不能再转交命令面板**：
  // 面板是让用户填参数的，而这里用户已经用"点了哪个文件"表达过意图；弹表单只会把刚拿到的
  // 文件信息丢掉，插件收到空参数后只会报 bad_args。
  it("带宿主入参的入口（file.context）：带参数的命令也直接跑，入参原样传下去", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["file.context"], [{ name: "x" }])])] });
    root = mount(
      React.createElement(PluginMenuItems, {
        menuId: "file.context",
        pageId: "page-9",
        argsJson: '{"fileName":"a.png","size":3,"mime":"image/png"}',
      }),
    );
    expect(buttonFor("on.ctx")!.textContent, "有宿主入参时不该标「需填参数」").not.toContain("需填参数");
    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(runPluginCommandWithUi).toHaveBeenCalled());
    expect(runPluginCommandWithUi).toHaveBeenCalledWith(
      "「命令 on.ctx」",
      "on",
      "on.ctx",
      "page-9",
      '{"fileName":"a.png","size":3,"mime":"image/png"}',
    );
    expect(usePalette.getState().open, "不该顺手打开命令面板").toBe(false);
  });

  it("没有宿主入参时仍然转交面板——两种入口的行为差别就在这一处", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.ctx", ["file.context"], [{ name: "x" }])])] });
    root = mount(React.createElement(PluginMenuItems, { menuId: "file.context", pageId: "p1" }));
    expect(buttonFor("on.ctx")!.textContent).toContain("需填参数");
    flushSync(() => buttonFor("on.ctx")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(runPluginCommandWithUi).not.toHaveBeenCalled();
    expect(usePalette.getState().open).toBe(true);
  });
});
