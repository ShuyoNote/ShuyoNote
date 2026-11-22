// §13.6 O1「多设备同步图」数据面第一刀的判据（纯函数，不渲染、不联网）。
import { describe, expect, it } from "vitest";

import type { MeshWatermarks } from "./platform/commands";
import type { SyncHistoryRow } from "./meshDiagnose";
import { buildSyncGraph, syncGraphText } from "./syncGraph";

const AT = 1_700_000_000_000;
const SPACE = "研发空间";
const DEVICE_ID = "dev-0123456789abcdef0123456789abcdef";
const ADDR = "192.168.43.9";

function wm(over: Partial<MeshWatermarks> = {}): MeshWatermarks {
  return {
    spaceName: SPACE,
    localMaxSeq: 120,
    peers: [
      { index: 1, cursor: 120, online: true, lastOkAgoMs: 12_000 },
      { index: 2, cursor: 100, online: false, lastOkAgoMs: 3_600_000 },
      { index: 3, cursor: 0, online: null, lastOkAgoMs: null },
    ],
    onlineCount: 1,
    offlineCount: 1,
    unknownCount: 1,
    note: "读数来自本机记录",
    ...over,
  };
}

function hist(rows: Array<Record<string, unknown>>): SyncHistoryRow[] {
  return rows as unknown as SyncHistoryRow[];
}

describe("syncGraph：边与计数", () => {
  it("三台对端：已齐=ok、落后且离线=warn、无记录=unknown；计数与 headline 对得上", () => {
    const g = buildSyncGraph({ watermarks: wm(), at: AT });
    expect(g.counts).toMatchObject({ spaces: 1, edges: 3, ok: 1, warn: 1, unknown: 1 });
    expect(g.headline).toContain("1 条边需要注意");
    expect(g.headline).toContain("1 条读不到");

    const e1 = g.edges.find((e) => e.peerIndex === 1)!;
    expect(e1.level).toBe("ok");
    expect(e1.lag).toBe(0);
    expect(e1.reason).toContain("已齐");

    const e2 = g.edges.find((e) => e.peerIndex === 2)!;
    expect(e2.level).toBe("warn");
    expect(e2.lag).toBe(20);
    expect(e2.reason).toContain("落后 20");
    expect(e2.reason).toContain("在线=否");

    const e3 = g.edges.find((e) => e.peerIndex === 3)!;
    expect(e3.level).toBe("unknown");
    expect(e3.reason).toContain("还没有成功记录");
  });

  it("全部拉齐 ⇒ 结论 ok；没有对端 ⇒ 明说“没有可列出的设备边”", () => {
    const allOk = buildSyncGraph({
      watermarks: wm({ peers: [{ index: 1, cursor: 120, online: true, lastOkAgoMs: 1000 }] }),
      at: AT,
    });
    expect(allOk.headline).toContain("都已拉齐");

    const empty = buildSyncGraph({ watermarks: wm({ peers: [] }), at: AT });
    expect(empty.counts.edges).toBe(0);
    expect(empty.headline).toContain("没有可列出的设备边");
  });
});

describe("syncGraph：历史轮次", () => {
  it("每个空间只取最近一轮（乱序也给最近）；当前空间按名字并进边", () => {
    const rows = hist([
      { ws_id: "w1", ws_name: SPACE, at: AT - 60_000, ok: true, pushed: 2, pulled: 3, message: "" },
      { ws_id: "w2", ws_name: "另一个空间", at: AT - 300_000, ok: false, pushed: 0, pulled: 0, message: "**拉不动**：401" },
      { ws_id: "w1", ws_name: SPACE, at: AT - 900_000, ok: false, pushed: 0, pulled: 0, message: "旧的失败" },
    ]);
    const g = buildSyncGraph({ watermarks: wm(), history: rows, at: AT });
    const space = g.spaces.find((s) => s.spaceName === SPACE)!;
    expect(space.lastRound).toMatchObject({ ok: true, pushed: 2, pulled: 3 });
    expect(space.hasEdges).toBe(true);

    const other = g.spaces.find((s) => s.spaceName === "另一个空间")!;
    expect(other.lastRound).toMatchObject({ ok: false, message: "**拉不动**：401" });
    expect(other.hasEdges).toBe(false);
  });

  it("只有历史、没有水位 ⇒ 空间有行、边为 0，且不冒充“都正常”", () => {
    const g = buildSyncGraph({
      history: hist([
        { ws_id: "w1", ws_name: SPACE, at: AT - 1000, ok: true, pushed: 1, pulled: 1, message: "" },
      ]),
      at: AT,
    });
    expect(g.counts.spaces).toBe(1);
    expect(g.counts.edges).toBe(0);
    expect(g.headline).toContain("没有可列出的设备边");
  });
});

describe("syncGraph：缺输入与脱敏", () => {
  it("两个输入都没有 ⇒ 明说读不到（⛔ 不假装 0 台=正常）", () => {
    const g = buildSyncGraph({ at: AT });
    expect(g.counts).toEqual({ spaces: 0, edges: 0, ok: 0, warn: 0, unknown: 0 });
    expect(g.headline).toContain("读不到同步图");
  });

  it("syncGraphText 脱敏：不含空间名/设备号/地址；含对端序号、落后、在线三态", () => {
    const g = buildSyncGraph({
      watermarks: wm(),
      history: hist([
        {
          ws_id: "w1",
          ws_name: SPACE,
          at: AT - 1000,
          ok: false,
          pushed: 0,
          pulled: 0,
          message: "**拉不动**：401",
          // 模拟后端行里可能带的敏感字段：摘要只取白名单，不应出现。
          device_id: DEVICE_ID,
          addr: ADDR,
        },
      ]),
      at: AT,
    });
    const text = syncGraphText(g);
    expect(text).toContain("多设备同步图");
    expect(text).toContain("对端[2]");
    expect(text).toContain("落后=20");
    expect(text).toContain("在线=否");
    expect(text).toContain("原文：拉不动：401");
    expect(text).not.toContain(SPACE);
    expect(text).not.toContain(DEVICE_ID);
    expect(text).not.toContain(ADDR);
  });
});
