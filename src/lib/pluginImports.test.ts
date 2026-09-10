// 导入触发的宿主侧规则：错了不会报错——只会多出一条点不动的入口，或者选文件时
// 筛掉了本该筛出来的格式（后者用户只会觉得"这个插件坏了"）。
import { describe, expect, it } from "vitest";
import type { PluginMeta, PluginTrigger } from "../types";
import {
  baseName,
  defaultImportTitle,
  dialogExtensions,
  filterLabel,
  importArgsJson,
  pluginImportItems,
} from "./pluginImports";

const trigger = (over: Partial<PluginTrigger> = {}): PluginTrigger => ({
  kind: "import",
  extensions: [".md"],
  command: "a.importMd",
  title: "",
  ...over,
});

const plugin = (id: string, enabled: boolean, triggers: PluginTrigger[]): PluginMeta =>
  ({
    id, name: `插件 ${id}`, version: "1.0.0", description: "", enabled,
    commands: [], permissions: [], permissions_baseline: false, events: [],
    runtime: "logic", views: [], triggers,
  }) as PluginMeta;

describe("pluginImportItems", () => {
  it("一条触发一个入口，标题默认带上插件名与扩展名", () => {
    const items = pluginImportItems([plugin("a", true, [trigger()])]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("导入：用「插件 a」打开 .md");
    expect(items[0].commandId).toBe("a.importMd");
  });

  it("作者写了 title 就照用（不套默认文案）", () => {
    const items = pluginImportItems([plugin("a", true, [trigger({ title: "用甲插件导入" })])]);
    expect(items[0].title).toBe("用甲插件导入");
  });

  it("未启用的插件不露脸（与命令、/ 菜单一致）", () => {
    expect(pluginImportItems([plugin("a", false, [trigger()])])).toHaveLength(0);
  });

  it("缺命令或没有扩展名：不出现（入口点了必然失败，或根本不知道筛什么文件）", () => {
    const items = pluginImportItems([
      plugin("a", true, [trigger({ command: "" }), trigger({ extensions: [] })]),
    ]);
    expect(items).toHaveLength(0);
  });

  it("扩展名去重，入口 key 带插件前缀（避免与内置项、其它插件撞车）", () => {
    const items = pluginImportItems([
      plugin("a", true, [trigger({ extensions: [".md", ".md", ".csv"] })]),
      plugin("b", true, [trigger({ extensions: [".md", ".csv"] })]),
    ]);
    expect(items[0].extensions).toEqual([".md", ".csv"]);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it("没有声明 triggers 的插件（老插件）什么都不产出", () => {
    const legacy = { ...plugin("a", true, []), triggers: undefined } as unknown as PluginMeta;
    expect(pluginImportItems([legacy])).toHaveLength(0);
  });
});

describe("文件选择器与参数", () => {
  it("对话框的扩展名不带点（平台约定），过滤器的名字给人看", () => {
    expect(dialogExtensions([".md", ".csv"])).toEqual(["md", "csv"]);
    expect(filterLabel([".md", ".csv"])).toBe("MD / CSV 文件");
    expect(filterLabel([])).toBe("文件");
  });

  it("fileName 只给文件名，不给路径（插件没有文件能力，路径是白送的隐私）", () => {
    expect(baseName("/Users/me/笔记/日程.md")).toBe("日程.md");
    expect(baseName("C:\\Users\\me\\todo.csv")).toBe("todo.csv");
    expect(baseName("bare.md")).toBe("bare.md");
  });

  it("argsJson 就是 { fileName, content }（与后端 argsJson 通道同源）", () => {
    expect(JSON.parse(importArgsJson("a.md", "# 标题\n正文"))).toEqual({
      fileName: "a.md",
      content: "# 标题\n正文",
    });
  });

  it("默认标题在多个扩展名时全部列出（只写第一个会让用户以为别的文件点不开）", () => {
    expect(defaultImportTitle("甲", [".md", ".csv"])).toBe("导入：用「甲」打开 .md / .csv");
  });
});
