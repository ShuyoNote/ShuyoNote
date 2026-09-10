// 「需要重新确认」这件事的说法。两个地方要复用同一句话（插件管理 + 命令面板），
// 而且必须**说清具体新增了什么**——"插件发生了变化"这种话用户没法据此做决定。
import { describe, expect, it } from "vitest";
import type { PluginMeta } from "../types";
import { approvalDetail, approvalLabel, needsApproval } from "./pluginApproval";

const plugin = (over: Partial<PluginMeta["approval"]> = {}): PluginMeta =>
  ({
    id: "p",
    name: "演示插件",
    approval: { required: true, added_permissions: [], added_events: [], approved_version: "", ...over },
  }) as PluginMeta;

describe("插件授权状态的说法", () => {
  it("把新增的权限与事件都摊出来（用户是据此判断的）", () => {
    const detail = approvalDetail(
      plugin({ added_permissions: ["read:pages", "write:pages"], added_events: ["page.saved"], approved_version: "1.0.0" }),
    );
    expect(detail).toContain("read:pages");
    expect(detail).toContain("write:pages");
    expect(detail).toContain("page.saved");
    expect(detail).toContain("v1.0.0");
    expect(detail).toContain("不会运行");
  });

  it("只有事件新增时也要说（那是不点命令也会跑的那种）", () => {
    const detail = approvalDetail(plugin({ added_events: ["page.saved"] }));
    expect(detail).toContain("事件 page.saved");
    expect(detail).not.toContain("权限");
  });

  it("没有版本信息时不留一个空括号", () => {
    expect(approvalDetail(plugin())).not.toContain("v");
    expect(approvalDetail(plugin())).toContain("你当初同意的那份声明");
  });

  it("needsApproval 只认 required（缺字段的老数据当没事）", () => {
    expect(needsApproval(plugin())).toBe(true);
    expect(needsApproval(plugin({ required: false }))).toBe(false);
    expect(needsApproval({ approval: undefined } as unknown as PluginMeta)).toBe(false);
  });

  it("短标签简短到能挂在入口名后面", () => {
    expect(approvalLabel()).toBe("需重新确认");
  });
});
