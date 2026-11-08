// P1「全部空间立即同步」的纯逻辑判据。
//
// 覆盖任务点名的四类场景（每条都断言"人话里有该有的数与词"）：
//   ① 全部成功；② 部分失败（含"只重试失败项"）；③ 空列表；④ 重试失败项；
// 外加：挑空间（团队排除 / 分类读不到照收 / 去重 / 保序）＋ 中途停止的如实说法 ＋ 面板接线。
//
// ⚠️ 本文件只测**纯函数**（不联网、不渲染）：串行循环本身在 `SyncPanel`，它只调既有
//    `api.meshSyncNow`（同一个命令＝没有第二条同步路，接线判据在末尾读源码钉住）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allSyncFailures,
  allSyncProgressText,
  allSyncSummary,
  pickAllSyncSpaces,
  type AllSyncResult,
  type AllSyncRun,
  type AllSyncTarget,
} from "./meshAllSpaces";

const t = (n: number): AllSyncTarget => ({ wsId: `ws-${n}`, name: `空间${n}` });

const okResult = (target: AllSyncTarget, applied = 0): AllSyncResult => ({
  target,
  ok: true,
  applied,
  note: "网格：拉了 1 台对端",
  error: null,
});

const failResult = (target: AllSyncTarget, error = "连不上"): AllSyncResult => ({
  target,
  ok: false,
  applied: 0,
  note: "",
  error,
});

function run(
  targets: AllSyncTarget[],
  results: AllSyncResult[],
  over: Partial<AllSyncRun> = {},
): AllSyncRun {
  return {
    targets,
    done: results.length,
    current: null,
    results,
    stopped: false,
    startedAt: 1_000,
    nearbyCount: 0,
    running: false,
    ...over,
  };
}

describe("挑目标空间 · pickAllSyncSpaces", () => {
  it("个人空间全收；明确 team 的跳过；未分类/分类读不到照收（⛔ 不静默少同步）", () => {
    const spaces = [
      { id: "a", name: "工作", kind: "personal" },
      { id: "b", name: "团队库", kind: "team" },
      { id: "c", name: "", kind: "" },
      { id: "d", name: "老空间" }, // 没有 kind 这一格（老形状）
    ];
    const got = pickAllSyncSpaces(spaces as never);
    expect(got.map((x) => x.wsId), "team 必须跳过；其余按传入顺序保留").toEqual(["a", "c", "d"]);
    expect(got[1].name, "名字空 ⇒ 「这个空间」（⛔ 不回落成 id）").toBe("这个空间");
  });

  it("分类以 spaceSecurityOverview 的读数为准（比空间自带的 kind 更新）；读不到该条时回落 kind", () => {
    const spaces = [
      { id: "a", name: "A", kind: "personal" },
      { id: "b", name: "B", kind: "personal" },
    ];
    const kindByWs = new Map<string, string>([
      ["a", "team"], // 后端读数是团队 ⇒ 即便空间自带 personal 也跳过
    ]);
    expect(pickAllSyncSpaces(spaces as never, kindByWs).map((x) => x.wsId)).toEqual(["b"]);
    // 分类表整个读不到（null）⇒ 按空间自带的 kind 判，不做"全都当团队"的静默降级
    expect(pickAllSyncSpaces(spaces as never, null).map((x) => x.wsId)).toEqual(["a", "b"]);
  });

  it("去重（同一 wsId 只跑一次）；空输入/坏输入 ⇒ 空列表；空 id 跳过", () => {
    expect(pickAllSyncSpaces([])).toEqual([]);
    expect(pickAllSyncSpaces(null)).toEqual([]);
    expect(pickAllSyncSpaces(undefined)).toEqual([]);
    const spaces = [
      { id: "a", name: "A", kind: "personal" },
      { id: "a", name: "A 再来一次", kind: "personal" },
      { id: "  ", name: "空 id", kind: "personal" },
    ];
    expect(pickAllSyncSpaces(spaces as never)).toEqual([{ wsId: "a", name: "A" }]);
  });
});

describe("进度 · allSyncProgressText", () => {
  it("跑着的时候说 x/y ＋ 当前空间名 ＋ 附近台数 ＋ 已 Ns", () => {
    const targets = [t(1), t(2), t(3)];
    const r = run(targets, [okResult(targets[0])], {
      current: targets[1],
      done: 1,
      startedAt: 1_000,
      nearbyCount: 2,
      running: true,
    });
    const text = allSyncProgressText(r, 4_500);
    expect(text).toContain("全部空间 2/3");
    expect(text).toContain("正在同步「空间2」");
    expect(text).toContain("附近 2 台");
    expect(text).toContain("已 3s"); // 4500 - 1000 = 3.5s ⇒ 取整 3s
  });

  it("停止后 / 准备下一个 / 空列表各有各的说法（⛔ 不拿一句「正在同步」糊过去）", () => {
    const targets = [t(1), t(2)];
    expect(allSyncProgressText(run(targets, [], { stopped: true }), 2_000)).toContain("已停止");
    expect(allSyncProgressText(run(targets, [], {}), 2_000)).toContain("准备下一个空间");
    expect(allSyncProgressText(run([], [], {}), 2_000)).toBe("没有可同步的个人空间");
  });
});

describe("汇总 · 场景① 全部成功", () => {
  it("成功台数 = 总数；收下页数取各轮 applied 之和", () => {
    const targets = [t(1), t(2), t(3)];
    const s = allSyncSummary(
      run(targets, [okResult(targets[0], 2), okResult(targets[1], 0), okResult(targets[2], 5)]),
    );
    expect(s.okCount).toBe(3);
    expect(s.failedCount).toBe(0);
    expect(s.applied).toBe(7);
    expect(s.failures).toEqual([]);
    expect(s.text).toContain("全部空间同步完成：3/3 个空间成功");
    expect(s.text).toContain("本轮收下 7 页"); // 复用 meshRoundSummaryText 的口径
  });

  it("一页都没收下时**不补**「收下 0 页」的废话（与单空间同步同一口径）", () => {
    const targets = [t(1)];
    const s = allSyncSummary(run(targets, [okResult(targets[0], 0)]));
    expect(s.text).not.toContain("收下 0 页");
  });
});

describe("汇总 · 场景② 部分失败", () => {
  it("说清成功几台/失败几台，并标出失败项可以重试", () => {
    const targets = [t(1), t(2), t(3)];
    const s = allSyncSummary(
      run(targets, [okResult(targets[0], 1), failResult(targets[1]), okResult(targets[2], 2)]),
    );
    expect(s.okCount).toBe(2);
    expect(s.failedCount).toBe(1);
    expect(s.applied).toBe(3);
    expect(s.failures.map((x) => x.wsId)).toEqual(["ws-2"]);
    expect(s.text).toContain("2/3 个空间成功");
    expect(s.text).toContain("1 个失败");
    expect(s.text).toContain("可以重试");
  });
});

describe("汇总 · 场景③ 空列表", () => {
  it("空目标 ⇒ 不假装同步过：进度/汇总都说「没有可同步的个人空间」", () => {
    const r = run([], []);
    expect(allSyncProgressText(r, 2_000)).toBe("没有可同步的个人空间");
    const s = allSyncSummary(r);
    expect(s.okCount).toBe(0);
    expect(s.failedCount).toBe(0);
    expect(s.text).toBe("没有可同步的个人空间");
    expect(allSyncFailures(r)).toEqual([]);
  });
});

describe("汇总 · 场景④ 重试失败项", () => {
  it("只重跑失败的那几个（⛔ 不重跑已成功的）；重跑全成功 ⇒ 汇总变成全成功", () => {
    const targets = [t(1), t(2), t(3)];
    const first = run(targets, [okResult(targets[0]), failResult(targets[1]), failResult(targets[2])]);
    const retryTargets = allSyncFailures(first);
    expect(retryTargets.map((x) => x.wsId), "重试目标 = 只含失败项").toEqual(["ws-2", "ws-3"]);
    const second = run(retryTargets, [okResult(retryTargets[0], 1), okResult(retryTargets[1], 2)]);
    const s = allSyncSummary(second);
    expect(s.failedCount).toBe(0);
    expect(s.applied).toBe(3);
    expect(s.text).toContain("2/2 个空间成功");
  });

  it("被用户「停止」⇒ 如实说处理到哪，并保留可重试的失败项", () => {
    const targets = [t(1), t(2), t(3), t(4)];
    const s = allSyncSummary(
      run(targets, [okResult(targets[0]), failResult(targets[1])], { stopped: true, done: 2 }),
    );
    expect(s.text).toContain("已停止");
    expect(s.text).toContain("2/4");
    expect(s.text).toContain("成功 1、失败 1");
    expect(s.failures.map((x) => x.wsId)).toEqual(["ws-2"]);
  });
});

describe("面板接线 · 全部空间立即同步（文本级，与 syncPanelMesh.wiring 同一手法）", () => {
  const panel = readFileSync(resolve(process.cwd(), "src/components/SyncPanel.tsx"), "utf8");

  it("有入口/进度/停止/重试，且同步只用既有 `api.meshSyncNow(ws_id)`", () => {
    expect(panel, "没有入口按钮").toContain('data-testid="mesh-all-sync-start"');
    expect(panel, "没有停止按钮").toContain('data-testid="mesh-all-sync-stop"');
    expect(panel, "没有重试失败项按钮").toContain('data-testid="mesh-all-sync-retry"');
    expect(panel, "没接纯函数（目标选择）").toContain("pickAllSyncSpaces(");
    expect(panel, "没接纯函数（进度）").toContain("allSyncProgressText(");
    expect(panel, "没接纯函数（汇总）").toContain("allSyncSummary(");
    // ⛔ 不新增第二条同步路：全部空间这一档也用同一个命令、同一个结果形状
    expect(panel, "全部空间那条路没走既有命令").toContain("api.meshSyncNow(target.wsId)");
    // 串行：本轮跑着的时候不许再点单空间「立即同步」（并发会抢锁）
    const meshFn = panel.slice(panel.indexOf("const syncMeshNow"), panel.indexOf("const statusKind"));
    expect(meshFn, "单空间同步没挡「全部空间正在跑」⇒ 会并发").toContain("allSync?.running");
  });
});
