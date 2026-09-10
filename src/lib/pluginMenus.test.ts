// 编辑器 `/` 菜单里插件命令的三条筛选规则。
// 错了不会报错——只会在菜单里多出点不动的项、或少了本该有的项。
import { describe, expect, it } from "vitest";
import type { PluginMeta } from "../types";
import { pluginMenuItems, pluginSlashItems } from "./pluginMenus";

const cmd = (id: string, menus: string[], params: unknown[] = []) => ({
  id, title: `命令 ${id}`, description: "", close_on_run: false, params, menus,
}) as never;

const plugin = (id: string, enabled: boolean, commands: unknown[]): PluginMeta =>
  ({
    id, name: `插件 ${id}`, version: "1.0.0", description: "", enabled,
    commands, permissions: [], permissions_baseline: false, events: [], runtime: "logic", views: [], triggers: [],
    approval: { required: false, added_permissions: [], added_events: [], approved_version: "" },
  }) as PluginMeta;

describe("pluginSlashItems", () => {
  it("只取声明了 slash 的命令", () => {
    const items = pluginSlashItems([
      plugin("a", true, [cmd("a.one", ["slash"]), cmd("a.two", []), cmd("a.three", ["page.context"])]),
    ]);
    expect(items.map((i) => i.commandId)).toEqual(["a.one"]);
  });

  it("未启用的插件不露脸（禁用了却还出现在编辑器里是误导）", () => {
    const items = pluginSlashItems([
      plugin("a", false, [cmd("a.one", ["slash"])]),
      plugin("b", true, [cmd("b.one", ["slash"])]),
    ]);
    expect(items.map((i) => i.pluginId)).toEqual(["b"]);
  });

  it("带参数的命令标记出来（由调用方转交命令面板，不在这里渲染表单）", () => {
    const items = pluginSlashItems([
      plugin("a", true, [cmd("a.one", ["slash"], [{ name: "x" }]), cmd("a.two", ["slash"])]),
    ]);
    expect(items.find((i) => i.commandId === "a.one")?.hasParams).toBe(true);
    expect(items.find((i) => i.commandId === "a.two")?.hasParams).toBe(false);
  });

  it("key 带插件前缀，避免与内置项撞车；标题为空时退回 id", () => {
    const items = pluginSlashItems([plugin("a", true, [{ id: "a.one", title: "", description: "", close_on_run: false, params: [], menus: ["slash"] } as never])]);
    expect(items[0].key).toBe("plugin:a:a.one");
    expect(items[0].title).toBe("a.one");
  });
});

// 同一个函数服务**所有**宿主入口（`slash` / `page.context` / …）：入口各写一份过滤逻辑，
// 迟早有一处忘了"只取启用中的插件"，停用的插件就在那一处继续露脸。
describe("pluginMenuItems（按入口取）", () => {
  it("只取声明了这个入口的命令", () => {
    const items = pluginMenuItems(
      [plugin("a", true, [cmd("a.slash", ["slash"]), cmd("a.ctx", ["page.context"]), cmd("a.both", ["slash", "page.context"])])],
      "page.context",
    );
    expect(items.map((i) => i.commandId)).toEqual(["a.ctx", "a.both"]);
  });

  it("两个入口都如实反映启用状态", () => {
    const plugins = [plugin("off", false, [cmd("off.ctx", ["page.context"])]), plugin("on", true, [cmd("on.ctx", ["page.context"])])];
    expect(pluginMenuItems(plugins, "page.context").map((i) => i.pluginId)).toEqual(["on"]);
    expect(pluginMenuItems(plugins, "slash")).toEqual([]);
  });

  it("按入口取：声明了别的入口不会漏进来", () => {
    const plugins = [plugin("a", true, [cmd("a.one", ["file.context"])])];
    expect(pluginMenuItems(plugins, "page.context")).toEqual([]);
    expect(pluginMenuItems(plugins, "slash")).toEqual([]);
    // 而声明了 file.context 的命令在 file.context 这个入口下是取得到的——
    // "宿主还没接这个入口"由注册表与校验器（menu_not_hosted）如实告知作者，
    // 不是在这里悄悄丢掉（静默丢掉才是最难查的）。
    expect(pluginMenuItems(plugins, "file.context").map((i) => i.commandId)).toEqual(["a.one"]);
  });

  it("pluginSlashItems 就是 slash 那一份（同一份实现，不是两套规则）", () => {
    const plugins = [plugin("a", true, [cmd("a.one", ["slash"]), cmd("a.two", ["page.context"])])];
    expect(pluginSlashItems(plugins)).toEqual(pluginMenuItems(plugins, "slash"));
  });
});
