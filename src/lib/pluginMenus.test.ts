// 编辑器 `/` 菜单里插件命令的三条筛选规则。
// 错了不会报错——只会在菜单里多出点不动的项、或少了本该有的项。
import { describe, expect, it } from "vitest";
import type { PluginMeta } from "../types";
import { pluginSlashItems } from "./pluginMenus";

const cmd = (id: string, menus: string[], params: unknown[] = []) => ({
  id, title: `命令 ${id}`, description: "", close_on_run: false, params, menus,
}) as never;

const plugin = (id: string, enabled: boolean, commands: unknown[]): PluginMeta =>
  ({
    id, name: `插件 ${id}`, version: "1.0.0", description: "", enabled,
    commands, permissions: [], permissions_baseline: false, events: [], runtime: "logic", views: [], triggers: [],
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
