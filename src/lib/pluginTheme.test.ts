// 主题插件的解析规则。两个性质必须钉住：值不能变成对外请求的通道；
// 同一变量不能靠"谁最后加载"决定结果。
import { describe, expect, it } from "vitest";
import type { PluginMeta } from "../types";
import { applyThemeTokens, isValidThemeValue, resolveTheme } from "./pluginTheme";

const plugin = (id: string, tokens: Record<string, string>, enabled = true): PluginMeta =>
  ({
    id,
    name: `插件 ${id}`,
    version: "1.0.0",
    description: "",
    enabled,
    commands: [],
    permissions: [],
    permissions_baseline: false,
    events: [],
    runtime: "declarative",
    views: [],
    theme: { name: id, tokens },
  }) as PluginMeta;

describe("isValidThemeValue", () => {
  it("认得正常的颜色与圆角", () => {
    for (const [n, v] of [["--bg", "#1b1714"], ["--text", "#efe6dd"], ["--accent", "rgb(224, 149, 106)"], ["--radius", "6px"]] as const) {
      expect(isValidThemeValue(n, v), `${n}=${v}`).toBe(true);
    }
  });

  it("挡掉会造成外部请求或破坏样式的写法（这是安全边界）", () => {
    for (const bad of ["url(http://evil/x.png)", "URL(x)", "red; background: url(y)", "@import 'x'", "}html{display:none", "<script>"]) {
      expect(isValidThemeValue("--bg", bad), bad).toBe(false);
    }
  });

  it("类型不符 / 白名单外都拒", () => {
    expect(isValidThemeValue("--bg", "12px")).toBe(false);
    expect(isValidThemeValue("--radius", "红色")).toBe(false);
    expect(isValidThemeValue("--doc-width", "100px")).toBe(false); // 布局度量不在白名单
  });
});

describe("resolveTheme", () => {
  it("只取启用中的插件，未启用的主题不生效", () => {
    const r = resolveTheme([plugin("a", { "--bg": "#111" }), plugin("b", { "--bg": "#222" }, false)]);
    expect(r.tokens).toEqual({ "--bg": "#111" });
    expect(r.winners).toEqual({ "--bg": "a" });
  });

  it("同一变量只有一个赢家，冲突被报出来（而不是谁最后加载谁赢）", () => {
    const r = resolveTheme([plugin("zzz", { "--bg": "#222" }), plugin("aaa", { "--bg": "#111" })]);
    expect(r.tokens["--bg"]).toBe("#111");
    expect(r.winners["--bg"]).toBe("aaa");
    expect(r.conflicts).toEqual([{ token: "--bg", winner: "aaa", loser: "zzz" }]);
  });

  it("非法值在宿主侧再被筛一遍（不假设后端筛过）", () => {
    const r = resolveTheme([plugin("a", { "--bg": "url(http://evil/x)", "--text": "#fff" })]);
    expect(r.tokens).toEqual({ "--text": "#fff" });
  });

  it("统计来源只列真正贡献了变量的插件（被抢先的、白名单外的都不算）", () => {
    const r = resolveTheme([
      plugin("a", { "--bg": "#111", "--text": "#fff" }),
      plugin("b", { "--bg": "#222" }), // 被 a 抢先 → 贡献 0 项，不进来源
      plugin("c", { "--nope": "#000" }), // 白名单外
    ]);
    expect(r.sources.map((s) => s.id)).toEqual(["a"]);
    expect(r.sources[0].tokens).toBe(2);
    expect(r.conflicts).toEqual([{ token: "--bg", winner: "a", loser: "b" }]);
  });
});

describe("applyThemeTokens", () => {
  it("写入新变量、移除上一次有而这次没有的（停用插件要恢复原样）", () => {
    applyThemeTokens({ "--bg": "#111", "--text": "#eee" }, {});
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#111");

    applyThemeTokens({ "--text": "#fff" }, { "--bg": "#111", "--text": "#eee" });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("#fff");
    applyThemeTokens({}, { "--text": "#fff" });
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("");
  });
});
