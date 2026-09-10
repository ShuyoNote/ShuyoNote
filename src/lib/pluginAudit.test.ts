// 审计面板里那两行文字的口径：能力调用 vs **运行记录**（M11.13 之后审计里多了后者）。
// 错了不会报错——只会让用户看到 "host.run" 这种内部名字，或者把"被杀"显示成"ok"。
import { describe, expect, it } from "vitest";
import { auditDetail, auditStatus, auditTitle, formatBytes, isRunRecord } from "./pluginAudit";

const cap = (over = {}) => ({ capability: "pages.count", scope: "current-space", ok: true, error_code: null, peak_rss_bytes: null, ...over });
const run = (over = {}) => ({ capability: "host.run", scope: "command", ok: true, error_code: null, peak_rss_bytes: 30 * 1024 * 1024, ...over });

describe("审计记录的展示口径", () => {
  it("能力调用照原名显示，运行记录说人话", () => {
    expect(isRunRecord(cap())).toBe(false);
    expect(auditTitle(cap())).toBe("pages.count");
    expect(auditTitle(run())).toBe("命令运行");
    expect(auditTitle(run({ scope: "event" }))).toBe("事件运行");
  });

  it("运行记录的次要说明是**峰值内存**；能力调用还是作用域", () => {
    expect(auditDetail(cap())).toBe("current-space");
    expect(auditDetail(run())).toBe("峰值内存 30.0 MiB");
    // 读不到读数（Windows 还没实现 / 没轮到轮询）就什么都不说，不显示 "0 B"
    expect(auditDetail(run({ peak_rss_bytes: null }))).toBe("");
    expect(auditDetail(run({ peak_rss_bytes: 0 }))).toBe("");
  });

  it("状态标签：成功的能力是 ok，成功的运行是「完成」（免得两件事混成一句）", () => {
    expect(auditStatus(cap())).toBe("ok");
    expect(auditStatus(run())).toBe("完成");
    expect(auditStatus(run({ ok: false, error_code: "out_of_memory" }))).toBe("out_of_memory");
    expect(auditStatus(run({ ok: false, error_code: null }))).toBe("err");
  });

  it("字节数说人话：MiB / KiB，非法值不显示", () => {
    expect(formatBytes(30 * 1024 * 1024)).toBe("30.0 MiB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(100)).toBe("1 KiB");
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
  });
});
