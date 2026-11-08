// ⭐ P3-1a 第四刀（task-57）：SyncPanel「同步核心」只读行 —— 文案矩阵 ＋ 接线判据。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { syncCoreRowText } from "./SyncPanel";
import type { SyncCoreStatus } from "../lib/api";

const status = (patch: Partial<SyncCoreStatus>): SyncCoreStatus => ({
  enabled: false,
  runtimeEnabled: false,
  running: false,
  lastRound: null,
  ...patch,
});

const round = {
  serverSpaces: 2,
  serverErrors: 1,
  meshSpaces: 3,
  meshOk: 2,
  meshFailed: 1,
  meshApplied: 5,
  hadChanges: true,
  emptyStreak: 0,
  nextDelayMs: 5000,
};

describe("syncCoreRowText：只读状态文案矩阵", () => {
  it("读不到（null/unknown）⇒ 明确 unknown，⛔ 不假装未启用", () => {
    for (const s of [null, undefined, "unknown" as const]) {
      const t = syncCoreRowText(s);
      expect(t.detail).toContain("unknown");
      expect(t.tone).toBe("muted");
      expect(t.detail).not.toContain("未启用");
    }
  });

  it("默认关闭 ⇒ 未启用（并说明本版只读、不从这里开）", () => {
    const t = syncCoreRowText(status({ enabled: false }));
    expect(t.detail).toContain("未启用");
    expect(t.detail).toContain("默认关闭");
    expect(t.detail).toContain("只读");
    expect(t.tone).toBe("muted");
  });

  it("enabled＋running ⇒ 运行中 ＋ 上一轮脱敏计数（服务端/网格）", () => {
    const t = syncCoreRowText(status({ enabled: true, running: true, lastRound: round }));
    expect(t.detail).toContain("运行中");
    expect(t.detail).toContain("服务端 2 个空间（失败 1）");
    expect(t.detail).toContain("网格 3 个空间（收下 5 条）");
    expect(t.tone).toBe("ok");
  });

  it("enabled＋已停止 ⇒ 已停止；没跑过则如实说「还没跑过」", () => {
    const t = syncCoreRowText(status({ enabled: true, running: false, lastRound: null }));
    expect(t.detail).toContain("已停止");
    expect(t.detail).toContain("还没跑过");
    expect(t.tone).toBe("warn");
  });
});

describe("SyncPanel · 同步核心行接线", () => {
  const panel = readFileSync("src/components/SyncPanel.tsx", "utf8");

  it("高级区有只读行；调只读命令；不提供开关/写操作", () => {
    expect(panel).toContain('data-testid="sync-core-status"');
    expect(panel).toContain('data-testid="sync-core-status-detail"');
    expect(panel).toContain(".syncCoreStatus()");
    expect(panel).toContain("syncCoreRowText(coreStatus)");
    expect(panel).toContain("本版只读");
    // ⛔ 这一行不许有开关/按钮去"启用 Core"，也不许写任何设置。
    const row = panel.slice(
      panel.indexOf('data-testid="sync-core-status"'),
      panel.indexOf('data-testid="crdt-shadow-diagnose-row"'),
    );
    expect(row).not.toContain("<button");
    expect(row).not.toContain("meshSetConfig");
    expect(row).not.toContain("setMetaState");
  });

  it("每轮事件只重读状态行（监听、卸载取消）", () => {
    expect(panel).toContain('"sync-core-round"');
    expect(panel).toContain("unlisten?.()");
    expect(panel).toContain("if (alive) setCoreStatus");
  });
});
