// **两个"最后接上"的宿主事件**（`import.finished` / `sync.completed`）。
//
// 为什么值得单独一套：这两个事件在注册表里存在了很久，但标记是 `hosted: false`——
// 作者写了 `on("import.finished", ...)`、启用了插件、却永远收不到（校验器会提醒他，
// 但那份声明仍然是白写的）。2026-09 把它们接上，这条链路是
// 「宿主行为 → 播报 → 插件 handler」，中间任何一环漏了都不会报错，只会静默不响应。
//
// 这里测三件事：
//   1. **播报规则**（纯）：什么算"一次导入/同步完成"、失败/取消时不该叫醒插件；
//   2. **真的接在宿主行为上**：走 api 的入口（`api.importAttachmentFiles` / `syncNow` /
//      `syncWorkspace`），看事件有没有真的播出去——而不是只测那个包装函数；
//   3. **payload 是作者文档里写的那个形状**。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setPlatform, type Platform } from "./platform";
import {
  emitImportFinished,
  emitSyncCompleted,
  registerHostEventEmitter,
  type HostEventEmitter,
} from "./pluginEvents";

/** 一个只实现 executor 的平台替身（api 里被测的三个入口只用它）。 */
function platformWith(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  return { executor: { invoke } } as unknown as Platform;
}

describe("播报规则", () => {
  let emit: ReturnType<typeof vi.fn>;
  let real: HostEventEmitter | null = null;

  beforeEach(() => {
    emit = vi.fn();
    registerHostEventEmitter(emit as unknown as HostEventEmitter);
  });
  afterEach(() => {
    real = null;
    void real;
  });

  it("导入了东西才算「导入完成」：取消选择（空数组）不播报", () => {
    expect(emitImportFinished([], "p1")).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    expect(emitImportFinished([{ hash: "h" }, { hash: "h2" }], "p1")).toBe(true);
    expect(emit).toHaveBeenCalledWith("import.finished", { count: 2, pageId: "p1" });
  });

  it("封面/画布这类不属于页面的导入，pageId 如实为 null", () => {
    emitImportFinished([{ hash: "h" }], null);
    expect(emit).toHaveBeenCalledWith("import.finished", { count: 1, pageId: null });
  });

  it("同步全失败不算「完成」；部分成功只累加成功那些", () => {
    expect(emitSyncCompleted([])).toBe(false);
    expect(
      emitSyncCompleted([{ pushed: 0, pulled: 0, error: "连不上服务器" }]),
      "整次都失败时叫醒插件，插件会按「同步完成」去处理（比如清本地待同步队列）——更糟",
    ).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    expect(
      emitSyncCompleted([
        { pushed: 3, pulled: 5, error: null },
        { pushed: 100, pulled: 100, error: "这个空间失败了" },
        { pushed: 1, pulled: 0, error: null },
      ]),
    ).toBe(true);
    expect(emit, "失败那个空间的数字不该混进来当成绩").toHaveBeenCalledWith("sync.completed", {
      pushed: 4,
      pulled: 5,
    });
  });
});

describe("真的接在宿主行为上", () => {
  let emit: ReturnType<typeof vi.fn>;
  let calls: { cmd: string; args: unknown }[];
  let results: Record<string, unknown>;

  beforeEach(() => {
    emit = vi.fn();
    registerHostEventEmitter(emit as unknown as HostEventEmitter);
    calls = [];
    results = {};
    setPlatform(
      platformWith(async (cmd, args) => {
        calls.push({ cmd, args });
        return results[cmd] ?? [];
      }),
    );
  });

  // api.ts 与本测试共用一个模块实例；平台替身只影响 executor。
  const loadApi = () => import("./api").then((m) => m.api);

  it("api.importAttachmentFiles → 导入完播报一次（带份数与页）", async () => {
    const api = await loadApi();
    results.import_attachment_files = [{ hash: "a" }, { hash: "b" }];
    const metas = await api.importAttachmentFiles("page-1", ["/tmp/a.png", "/tmp/b.png"]);
    expect(metas).toHaveLength(2);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("import.finished", { count: 2, pageId: "page-1" });
  });

  it("api.importAttachmentFiles 返回空（导入被拒/全部失败）时不播报", async () => {
    const api = await loadApi();
    results.import_attachment_files = [];
    await api.importAttachmentFiles("page-1", ["/tmp/a.png"]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("api.syncWorkspace → 同步完播报一次（带 pushed/pulled）", async () => {
    const api = await loadApi();
    results.sync_workspace = { ws_id: "w1", pushed: 7, pulled: 2, last_pushed_seq: 0, last_pulled_seq: 0, error: null };
    await api.syncWorkspace("w1");
    expect(emit).toHaveBeenCalledWith("sync.completed", { pushed: 7, pulled: 2 });
  });

  it("api.syncNow → 多空间**求和**后再播报一次（不是每个空间各播一次）", async () => {
    const api = await loadApi();
    results.sync_now = [
      { ws_id: "w1", pushed: 1, pulled: 1, last_pushed_seq: 0, last_pulled_seq: 0, error: null },
      { ws_id: "w2", pushed: 2, pulled: 0, last_pushed_seq: 0, last_pulled_seq: 0, error: null },
      { ws_id: "w3", pushed: 0, pulled: 0, last_pushed_seq: 0, last_pulled_seq: 0, error: "挂了" },
    ];
    await api.syncNow();
    expect(emit, "一次调用一次事件（插件 handler 不该被每个空间叫一遍）").toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("sync.completed", { pushed: 3, pulled: 1 });
  });

  it("同步抛错时不播报（那次本来就没完成）", async () => {
    setPlatform(
      platformWith(async () => {
        throw new Error("连不上");
      }),
    );
    const api = await loadApi();
    await expect(api.syncWorkspace("w1")).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
