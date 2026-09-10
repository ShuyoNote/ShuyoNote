// **编辑器工具栏里真的出现插件命令了吗？** —— 打开那个「⋯」菜单点一遍。
//
// 为什么必须是渲染级测试：`editor.toolbar` 这条链是「插件清单 → 过滤 → 工具栏「⋯」菜单里
// 的按钮 → 跑命令时把**正在编辑的这一页**当当前页」。接错任何一环都不报错：
//   - 菜单里没有它 → 作者写了声明、用户看不到（还以为插件坏了）；
//   - pageId 传成 null → 命令里省略 pageId 的能力调用会报「当前没有打开的页面」；
//   - 忘了走同一份 `PluginMenuItems` → 停用的插件在这个入口继续露脸。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const runPluginCommandWithUi = vi.fn(async () => ({ message: "跑完了", cancelled: false }));
vi.mock("../lib/pluginRun", () => ({
  runPluginCommandWithUi: (...args: unknown[]) => runPluginCommandWithUi(...(args as [])),
}));
// 工具栏一挂载就会读一些宿主数据（模板 / 历史 / 视图偏好）。本测试只关心菜单里有什么。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { EditorToolbar } from "./EditorToolbar";
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

function mountToolbar(pageId: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(EditorToolbar, { pageId })));
  return root;
}

/** 点「⋯」打开菜单，返回菜单元素。 */
function openMoreMenu() {
  const more = document.querySelector(".editor-toolbar-more button") as HTMLElement;
  flushSync(() => more.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return document.querySelector(".editor-more-menu");
}

const itemFor = (commandId: string) =>
  document.querySelector(
    `.editor-more-menu .plugin-menu-item[data-command="${commandId}"]`,
  ) as HTMLElement | null;

describe("编辑器工具栏的「⋯」菜单里的插件命令", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    runPluginCommandWithUi.mockClear();
    useToast.setState({ toasts: [] });
    usePalette.setState({ open: false, query: "" });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    usePlugins.setState({ plugins: [] });
    document.body.innerHTML = "";
  });

  it("声明了 editor.toolbar 的命令出现在「⋯」菜单里，别的入口的不出现", () => {
    usePlugins.setState({
      plugins: [
        plugin("on", true, [cmd("on.tb", ["editor.toolbar"]), cmd("on.slash", ["slash"])]),
        plugin("off", false, [cmd("off.tb", ["editor.toolbar"])]),
      ],
    });
    root = mountToolbar("p1");
    expect(openMoreMenu(), "「⋯」菜单应当打得开").not.toBeNull();
    expect(itemFor("on.tb"), "声明了 editor.toolbar 的应当出现").not.toBeNull();
    expect(itemFor("on.slash"), "别的入口的命令不该漏进来").toBeNull();
    expect(itemFor("off.tb"), "停用的插件不该露脸").toBeNull();
    // 内置的导出项还在（别把人家挤掉）
    expect(document.querySelectorAll(".editor-more-menu .toolbar-menu-item").length).toBeGreaterThan(3);
  });

  it("没有插件命令时不留一个空分组", () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.slash", ["slash"])])] });
    root = mountToolbar("p1");
    openMoreMenu();
    expect(document.querySelector(".editor-more-menu .plugin-menu-title")).toBeNull();
  });

  it("点一下真的跑，且「当前页」是正在编辑的这一页；菜单随即收起", async () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.tb", ["editor.toolbar"])])] });
    root = mountToolbar("page-77");
    openMoreMenu();
    flushSync(() => itemFor("on.tb")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await vi.waitFor(() => expect(runPluginCommandWithUi).toHaveBeenCalled());
    expect(runPluginCommandWithUi).toHaveBeenCalledWith("「命令 on.tb」", "on", "on.tb", "page-77", undefined);
    expect(document.querySelector(".editor-more-menu"), "跑完菜单要收起（否则挡住正文）").toBeNull();
  });

  it("带参数的命令在这里也转交命令面板（表单只实现一份），并收起菜单", () => {
    usePlugins.setState({ plugins: [plugin("on", true, [cmd("on.tb", ["editor.toolbar"], [{ name: "x" }])])] });
    root = mountToolbar("p1");
    openMoreMenu();
    expect(itemFor("on.tb")!.textContent).toContain("需填参数");
    flushSync(() => itemFor("on.tb")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(runPluginCommandWithUi).not.toHaveBeenCalled();
    expect(usePalette.getState().open, "转交命令面板").toBe(true);
    expect(document.querySelector(".editor-more-menu")).toBeNull();
  });
});
