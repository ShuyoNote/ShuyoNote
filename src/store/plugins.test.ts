// 插件 store 的「失败必须看得见」语义。
//
// 背景：load/toggle/uninstall/install/openDir 以前把失败**全部吞进 console.error**
// ——装上坏插件、卸载失败、开关失败，用户界面上一点反应都没有。这里锁死两条：
//   1) 失败一定弹 error toast，且带上后端返回的**原始错误文本**（不是通用文案）；
//   2) 返回值要能区分成败，命令面板才不会「失败也报已切换」。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: {
    listPlugins: vi.fn(),
    setPluginEnabled: vi.fn(),
    uninstallPlugin: vi.fn(),
    installPlugin: vi.fn(),
    openPluginDir: vi.fn(),
    runPluginCommand: vi.fn(),
  },
}));

import { api } from "../lib/api";
import type { PluginMeta } from "../types";
import { usePlugins } from "./plugins";
import { useToast } from "./toast";

const PLUGIN: PluginMeta = {
  id: "demo",
  name: "演示插件",
  version: "1.0.0",
  description: "",
  enabled: true,
  commands: [],
};

const lastToast = () => {
  const { toasts } = useToast.getState();
  return toasts[toasts.length - 1];
};

beforeEach(() => {
  vi.resetAllMocks();
  useToast.setState({ toasts: [] });
  usePlugins.setState({ plugins: [PLUGIN], managerOpen: false });
  vi.mocked(api.listPlugins).mockResolvedValue([PLUGIN]);
  vi.mocked(api.setPluginEnabled).mockResolvedValue(undefined);
  vi.mocked(api.uninstallPlugin).mockResolvedValue(undefined);
  vi.mocked(api.installPlugin).mockResolvedValue(PLUGIN);
  vi.mocked(api.openPluginDir).mockResolvedValue("");
});

describe("plugins store · 失败必须看得见", () => {
  it("切换失败：error toast 带后端原文，返回 ok:false 且不刷新列表", async () => {
    vi.mocked(api.setPluginEnabled).mockRejectedValue("同名插件已存在");

    const r = await usePlugins.getState().toggle("demo");

    expect(r).toEqual({ ok: false, error: "同名插件已存在" });
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast()?.message).toContain("同名插件已存在");
    expect(api.listPlugins).not.toHaveBeenCalled();
  });

  it("切换成功：写库 → 重新拉列表 → success toast，返回 ok:true", async () => {
    const r = await usePlugins.getState().toggle("demo");

    expect(r).toEqual({ ok: true });
    expect(api.setPluginEnabled).toHaveBeenCalledWith("demo", false);
    expect(api.listPlugins).toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ kind: "success" });
    expect(lastToast()?.message).toContain("演示插件");
  });

  it("列表过期的插件：不再静默 return，而是给出可见失败", async () => {
    usePlugins.setState({ plugins: [] });

    const r = await usePlugins.getState().toggle("demo");

    expect(r.ok).toBe(false);
    expect(r.error).toContain("插件不存在");
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(api.setPluginEnabled).not.toHaveBeenCalled();
  });

  it("安装失败：保留后端原文（如 插件源目录不存在）", async () => {
    vi.mocked(api.installPlugin).mockRejectedValue("插件源目录不存在");

    const r = await usePlugins.getState().install("/nope");

    expect(r).toEqual({ ok: false, error: "插件源目录不存在" });
    expect(lastToast()?.message).toContain("插件源目录不存在");
    expect(lastToast()).toMatchObject({ kind: "error" });
  });

  it("安装成功：给出成功提示（否则装完界面上什么都没发生）", async () => {
    const r = await usePlugins.getState().install("/ok");

    expect(r).toEqual({ ok: true });
    expect(lastToast()).toMatchObject({ kind: "success" });
    expect(lastToast()?.message).toContain("演示插件");
  });

  it("卸载失败：保留后端原文，并带上插件名", async () => {
    vi.mocked(api.uninstallPlugin).mockRejectedValue("插件不存在");

    const r = await usePlugins.getState().uninstall("demo");

    expect(r).toEqual({ ok: false, error: "插件不存在" });
    expect(lastToast()?.message).toContain("插件不存在");
    expect(lastToast()?.message).toContain("演示插件");
  });

  it("打开插件目录失败：保留后端原文", async () => {
    vi.mocked(api.openPluginDir).mockRejectedValue("打开目录失败: permission denied");

    const r = await usePlugins.getState().openDir();

    expect(r).toEqual({ ok: false, error: "打开目录失败: permission denied" });
    expect(lastToast()?.message).toContain("permission denied");
  });

  it("列表加载失败：弹 error toast，而不是只写 console", async () => {
    vi.mocked(api.listPlugins).mockRejectedValue("manifest 解析失败: expected value");

    await usePlugins.getState().load();

    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast()?.message).toContain("manifest 解析失败");
  });
});
