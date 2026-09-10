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
    pluginLogs: vi.fn(),
    clearPluginLogs: vi.fn(),
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
  permissions: [{ id: "read:pages", title: "读取本空间页面统计", reason: "为了显示页面数", risk: "low" }],
  permissions_baseline: false,
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

describe("plugins store · 运行态 / 取消 / __toast / 日志", () => {
  it("执行期间 running 可见，结束后复位", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.runPluginCommand).mockReturnValue(
      new Promise((res) => {
        release = res;
      }) as never,
    );

    const p = usePlugins.getState().runCommand("demo", "demo.hello", null);
    expect(usePlugins.getState().running).toMatchObject({
      pluginId: "demo",
      commandId: "demo.hello",
    });

    release({ message: "done", insert: null, toasts: [] });
    await p;
    expect(usePlugins.getState().running).toBeNull();
  });

  it("__toast 的提示随结果回传（此前只写 stderr，用户看不到）", async () => {
    vi.mocked(api.runPluginCommand).mockResolvedValue({
      message: "已执行",
      insert: null,
      toasts: ["来自插件的提示"],
    });

    const r = await usePlugins.getState().runCommand("demo", "demo.toast", null);

    expect(r.toasts).toEqual(["来自插件的提示"]);
  });

  it("取消：丢弃结果（cancelled=true），且提示是诚实文案", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.runPluginCommand).mockReturnValue(
      new Promise((res) => {
        release = res;
      }) as never,
    );

    const p = usePlugins.getState().runCommand("demo", "demo.slow", null);
    usePlugins.getState().cancelRun();

    expect(usePlugins.getState().running).toBeNull();
    // 插件线程本身停不下来，所以文案不能说「已终止」，只能说「已取消等待」。
    expect(lastToast()?.message).toContain("取消等待");
    expect(lastToast()?.message).toContain("仍在后台");

    release({ message: "太晚了", insert: "不该被写入", toasts: ["也不该弹"] });
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.insert).toBeUndefined();
    expect(r.toasts).toBeUndefined();
  });

  it("写能力的草稿随结果回传（store 不自行落库）", async () => {
    vi.mocked(api.runPluginCommand).mockResolvedValue({
      message: "ok",
      insert: null,
      toasts: [],
      drafts: [
        { key: "create_page:X", summary: "新建页面「X」", payload: { kind: "create_page", args: { title: "X" } } },
      ],
    });

    const r = await usePlugins.getState().runCommand("demo", "w.create", null);

    expect(r.drafts).toHaveLength(1);
    expect(r.drafts?.[0].summary).toBe("新建页面「X」");
  });

  it("日志：按插件读取 / 清空 / 失败可见", async () => {
    vi.mocked(api.pluginLogs).mockResolvedValue([
      { plugin_id: "demo", level: "info", message: "你好", at_ms: 1 },
    ]);

    await usePlugins.getState().openLogs("demo");

    expect(api.pluginLogs).toHaveBeenCalledWith("demo");
    expect(usePlugins.getState().logsFor).toBe("demo");
    expect(usePlugins.getState().logs).toHaveLength(1);

    vi.mocked(api.clearPluginLogs).mockResolvedValue(undefined);
    await usePlugins.getState().clearLogs();
    expect(usePlugins.getState().logs).toEqual([]);

    usePlugins.getState().closeLogs();
    expect(usePlugins.getState().logsFor).toBeNull();

    vi.mocked(api.pluginLogs).mockRejectedValue("读取日志失败");
    await usePlugins.getState().openLogs("demo");
    expect(lastToast()).toMatchObject({ kind: "error" });
  });
});
