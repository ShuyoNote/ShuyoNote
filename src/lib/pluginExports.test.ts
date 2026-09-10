// 导出的宿主侧规则：插件申请、用户决定。
// 这几条错了不会报错——只会让用户看到一个莫名的保存对话框，或者以为"导出成功了"而其实
// 一个文件都没写（把「取消」算成「完成」就是骗人）。
import { describe, expect, it } from "vitest";
import type { PluginExport } from "../types";
import { exportDialogOptions, exportOutcomeMessage, extensionOf } from "./pluginExports";

const item = (over: Partial<PluginExport> = {}): PluginExport => ({
  file_name: "大纲.md",
  content: "# 标题",
  bytes: 6,
  ...over,
});

describe("extensionOf", () => {
  it("取扩展名（小写、不带点）；没有扩展名给空串", () => {
    expect(extensionOf("大纲.md")).toBe("md");
    expect(extensionOf("A.CSV")).toBe("csv");
    expect(extensionOf("无扩展名")).toBe("");
    expect(extensionOf(".bashrc")).toBe(""); // 隐藏文件不是扩展名
    expect(extensionOf("结尾点.")).toBe("");
  });
});

describe("exportDialogOptions", () => {
  it("默认文件名就是插件的建议名，过滤器按扩展名来", () => {
    const o = exportDialogOptions(item());
    expect(o.defaultPath).toBe("大纲.md");
    expect(o.filters).toEqual([{ name: "MD 文件", extensions: ["md"] }]);
    expect(o.title).toContain("大纲.md");
  });

  it("没有扩展名就不给过滤器（而不是给一个空过滤器让对话框看起来坏了）", () => {
    expect(exportDialogOptions(item({ file_name: "无扩展名" })).filters).toEqual([]);
  });
});

describe("exportOutcomeMessage", () => {
  it("全成功", () => {
    expect(exportOutcomeMessage({ written: 2, cancelled: 0, failed: [] })).toBe("已导出 2 个文件");
  });

  it("全取消：明说「没有写任何东西」（不能混进已完成）", () => {
    expect(exportOutcomeMessage({ written: 0, cancelled: 1, failed: [] })).toBe("1 个已取消（没有写任何东西）");
  });

  it("部分取消：两个数都要在", () => {
    const msg = exportOutcomeMessage({ written: 1, cancelled: 2, failed: [] });
    expect(msg).toContain("已导出 1 个文件");
    expect(msg).toContain("2 个已取消");
  });

  it("失败要说清是哪个文件、为什么（不能只报「导出完成」）", () => {
    const msg = exportOutcomeMessage({
      written: 1,
      cancelled: 0,
      failed: [{ fileName: "a.md", error: "磁盘只读" }],
    });
    expect(msg).toContain("已导出 1 个文件");
    expect(msg).toContain("a.md");
    expect(msg).toContain("磁盘只读");
  });

  it("失败多了只列前两个，其余用「另有 N 个」——不要把一屏日志糊给用户", () => {
    const msg = exportOutcomeMessage({
      written: 0,
      cancelled: 0,
      failed: [
        { fileName: "a.md", error: "e1" },
        { fileName: "b.md", error: "e2" },
        { fileName: "c.md", error: "e3" },
        { fileName: "d.md", error: "e4" },
      ],
    });
    expect(msg).toContain("4 个导出失败");
    expect(msg).toContain("a.md");
    expect(msg).toContain("另有 2 个失败");
    expect(msg).not.toContain("d.md");
  });

  it("什么都没有（空清单）时说清楚，而不是留一句空话", () => {
    expect(exportOutcomeMessage({ written: 0, cancelled: 0, failed: [] })).toBe("没有要导出的内容");
  });
});
