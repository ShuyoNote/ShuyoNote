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
    validatePlugin: vi.fn(),
    pluginDirStamp: vi.fn(),
    emitPluginEvent: vi.fn(),
  },
}));

vi.mock("../lib/pluginDrafts", () => ({
  confirmAndApplyDrafts: vi.fn().mockResolvedValue(""),
}));

import { api } from "../lib/api";
import type { PluginEventOutcome, PluginMeta, PluginValidation } from "../types";
import { confirmAndApplyDrafts } from "../lib/pluginDrafts";
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
  events: [],
};

const VALIDATION: PluginValidation = {
  ok: true,
  dir_name: "demo",
  id: "demo",
  name: "演示插件",
  version: "1.0.0",
  api_version: "1.0.0",
  main: "main.js",
  entry_bytes: 128,
  commands: [{ id: "demo.hello", title: "打个招呼", description: "", close_on_run: false, params: [] }],
  permissions: [{ id: "read:pages", title: "读取本空间页面统计", reason: "为了显示页面数", risk: "low", known: true, has_reason: true }],
  granted: ["read:pages"],
  permissions_baseline: false,
  problems: [],
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

/**
 * 热重载的契约。轮询最怕两种**不报错**的反向错误：
 * 「第一次就当成变化」（一打开面板就白扫一轮）与「变了却没重扫」（作者改了文件
 * 以为生效了，其实还是旧的）。两者都会让人慢慢不信这个工具，所以都钉住。
 */
describe("plugins store · 热重载", () => {
  beforeEach(() => {
    usePlugins.setState({ dirStamp: null, autoReloadedAt: null, validations: {} });
    vi.mocked(api.pluginDirStamp).mockResolvedValue("stamp-1");
    vi.mocked(api.validatePlugin).mockResolvedValue(VALIDATION);
  });

  it("首次只记基线，不触发重扫", async () => {
    await usePlugins.getState().watchPluginDir();

    expect(usePlugins.getState().dirStamp).toBe("stamp-1");
    expect(api.listPlugins).not.toHaveBeenCalled();
    expect(usePlugins.getState().autoReloadedAt).toBeNull();
  });

  it("指纹没变就不重扫（轮询不该反复打后端）", async () => {
    usePlugins.setState({ dirStamp: "stamp-1" });

    await usePlugins.getState().watchPluginDir();

    expect(api.listPlugins).not.toHaveBeenCalled();
    expect(api.pluginDirStamp).toHaveBeenCalledTimes(1);
  });

  it("指纹变了 → 重扫列表 + 重跑已展开的校验 + 记录时间", async () => {
    usePlugins.setState({ dirStamp: "stamp-1", validations: { demo: VALIDATION } });
    vi.mocked(api.pluginDirStamp).mockResolvedValue("stamp-2");

    await usePlugins.getState().watchPluginDir();

    expect(api.listPlugins).toHaveBeenCalledTimes(1);
    expect(api.validatePlugin).toHaveBeenCalledWith("demo");
    expect(usePlugins.getState().dirStamp).toBe("stamp-2");
    expect(usePlugins.getState().autoReloadedAt).toBeTypeOf("number");
  });

  it("没有展开校验时，重扫不会去校验任何插件", async () => {
    usePlugins.setState({ dirStamp: "stamp-1" });
    vi.mocked(api.pluginDirStamp).mockResolvedValue("stamp-2");

    await usePlugins.getState().watchPluginDir();

    expect(api.listPlugins).toHaveBeenCalledTimes(1);
    expect(api.validatePlugin).not.toHaveBeenCalled();
  });

  it("取指纹失败（Web 端没有磁盘插件）时静默跳过，不打断面板", async () => {
    vi.mocked(api.pluginDirStamp).mockRejectedValue("Web 版没有插件目录");

    await expect(usePlugins.getState().watchPluginDir()).resolves.toBeUndefined();

    expect(usePlugins.getState().dirStamp).toBeNull();
    expect(lastToast()).toBeUndefined();
  });
});

/** 作者校验：结果按插件 id 存档；收起即清掉（下次点是重跑，因为文件可能已经改了）。 */
describe("plugins store · 作者校验", () => {
  beforeEach(() => {
    usePlugins.setState({ validations: {} });
    vi.mocked(api.validatePlugin).mockResolvedValue(VALIDATION);
  });

  it("校验结果按 id 存档", async () => {
    await usePlugins.getState().verify("demo");

    expect(api.validatePlugin).toHaveBeenCalledWith("demo");
    expect(usePlugins.getState().validations.demo?.ok).toBe(true);
    expect(usePlugins.getState().validations.demo?.granted).toEqual(["read:pages"]);
  });

  it("收起校验：连结果一起清掉", async () => {
    await usePlugins.getState().verify("demo");
    usePlugins.getState().closeVerify("demo");

    expect(usePlugins.getState().validations.demo).toBeUndefined();
  });

  it("失败可见：弹 error toast 且带后端原文，不留半截结果", async () => {
    vi.mocked(api.validatePlugin).mockRejectedValue("非法插件 id：../evil");

    await usePlugins.getState().verify("demo");

    expect(usePlugins.getState().validations.demo).toBeUndefined();
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast()?.message).toContain("../evil");
  });
});

/**
 * 事件派发的契约。
 *
 * 这里最要紧的一条：**事件里的写操作也必须经用户确认**。事件触发时用户并没有在看
 * 确认框（他只是在编辑笔记），但这恰恰是"插件绝不静默改你的笔记"最容易被绕过的缝隙，
 * 所以用测试钉住：有草稿就必须走 confirmAndApplyDrafts，而不是直接落库。
 */
describe("plugins store · 事件派发", () => {
  const outcome = (over: Partial<PluginEventOutcome> = {}): PluginEventOutcome => ({
    plugin_id: "demo",
    plugin_name: "演示插件",
    message: "",
    toasts: [],
    drafts: [],
    error: null,
    ...over,
  });

  beforeEach(() => {
    vi.mocked(api.emitPluginEvent).mockResolvedValue([]);
  });

  it("没有插件订阅时什么都不做", async () => {
    await usePlugins.getState().emitEvent("page.saved", { pageId: "p1" });

    expect(api.emitPluginEvent).toHaveBeenCalledWith("page.saved", JSON.stringify({ pageId: "p1" }));
    expect(confirmAndApplyDrafts).not.toHaveBeenCalled();
    expect(lastToast()).toBeUndefined();
  });

  it("事件里的草稿必须走确认，而不是直接落库", async () => {
    vi.mocked(api.emitPluginEvent).mockResolvedValue([
      outcome({
        drafts: [{ key: "tag:今天", summary: "给页面加标签「今天」", payload: {} }],
      }),
    ]);

    await usePlugins.getState().emitEvent("page.saved", { pageId: "p1" });

    expect(confirmAndApplyDrafts).toHaveBeenCalledTimes(1);
    const [who, drafts] = vi.mocked(confirmAndApplyDrafts).mock.calls[0];
    expect(String(who)).toContain("演示插件");
    expect(String(who)).toContain("page.saved");
    expect(drafts).toHaveLength(1);
  });

  it("多个插件都产出草稿时，汇总成一次确认（不是每插件弹一次）", async () => {
    vi.mocked(api.emitPluginEvent).mockResolvedValue([
      outcome({ plugin_id: "a", plugin_name: "甲", drafts: [{ key: "1", summary: "甲改动", payload: {} }] }),
      outcome({ plugin_id: "b", plugin_name: "乙", drafts: [{ key: "2", summary: "乙改动", payload: {} }] }),
    ]);

    await usePlugins.getState().emitEvent("page.saved");

    expect(confirmAndApplyDrafts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmAndApplyDrafts).mock.calls[0][1]).toHaveLength(2);
  });

  it("插件的提示会弹出来", async () => {
    vi.mocked(api.emitPluginEvent).mockResolvedValue([outcome({ toasts: ["自动归档完成"] })]);

    await usePlugins.getState().emitEvent("page.saved");

    expect(lastToast()?.message).toBe("自动归档完成");
  });

  it("某个插件失败：只汇总提示一句（明细在插件日志里），不逐条刷屏", async () => {
    vi.mocked(api.emitPluginEvent).mockResolvedValue([
      outcome({ plugin_id: "a", plugin_name: "甲", error: "超时" }),
      outcome({ plugin_id: "b", plugin_name: "乙", error: "出错" }),
    ]);

    await usePlugins.getState().emitEvent("page.saved");

    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast()?.message).toContain("2 个插件");
    expect(lastToast()?.message).toContain("插件日志");
  });

  it("派发本身失败不影响保存路径：不抛错、不弹 error（记 console）", async () => {
    vi.mocked(api.emitPluginEvent).mockRejectedValue("插件目录读不到");

    await expect(usePlugins.getState().emitEvent("page.saved")).resolves.toBeUndefined();

    expect(lastToast()).toBeUndefined();
  });
});
