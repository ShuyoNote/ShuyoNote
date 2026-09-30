// 「空闲退避」判据的测试（2026-09-30）。
//
// ⚠️ 每一条都对着 `syncBackoff.ts` 头注里那三条口径；**特别是 ④ 那条"无条件兜底"**——
//    它是这次改动唯一的失败模式来源，所以它必须有一条**会红的**判据 ✓。
import { describe, expect, it } from "vitest";
import {
  BACKOFF_CAP_MS,
  decideSyncTick,
  roundWasEmpty,
  type BackoffInput,
} from "./syncBackoff";

const BASE = 5_000;
const tick = (o: Partial<BackoffInput>) =>
  decideSyncTick({ nowMs: 0, lastRunAtMs: 0, baseMs: BASE, emptyStreak: 0, ...o });

describe("decideSyncTick：活跃时按基础节拍", () => {
  it("从没跑过 ⇒ 立刻该跑（不能因为没历史就不动）", () => {
    const d = tick({ lastRunAtMs: null });
    expect(d.due).toBe(true);
    expect(d.thresholdMs).toBe(BASE);
  });

  it("活跃（空转 0 次）⇒ 正好基础节拍到点才跑", () => {
    expect(tick({ nowMs: BASE - 1 }).due).toBe(false);
    expect(tick({ nowMs: BASE }).due).toBe(true);
  });

  it("基础节拍是用户选的 ⇒ base=30s 时 5s 不该跑", () => {
    expect(tick({ baseMs: 30_000, nowMs: 5_000 }).due).toBe(false);
    expect(tick({ baseMs: 30_000, nowMs: 30_000 }).due).toBe(true);
  });
});

describe("decideSyncTick：空闲时逐级放长（上限 60s）", () => {
  it("空转 1/2/3 次 ⇒ 10s / 20s / 40s", () => {
    expect(tick({ emptyStreak: 1 }).thresholdMs).toBe(10_000);
    expect(tick({ emptyStreak: 2 }).thresholdMs).toBe(20_000);
    expect(tick({ emptyStreak: 3 }).thresholdMs).toBe(40_000);
  });

  it("空转 4 次起顶到 60s（不再继续翻倍）", () => {
    expect(tick({ emptyStreak: 4 }).thresholdMs).toBe(BACKOFF_CAP_MS);
    expect(tick({ emptyStreak: 12 }).thresholdMs).toBe(BACKOFF_CAP_MS);
  });

  it("⭐ ④ 无条件兜底：空转再多，**60s 到点也必须跑**", () => {
    // 这一条就是"别人改了东西最多 60s 被发现"的判据 —— 去掉 cap 的钳制它必须红。
    for (const emptyStreak of [4, 8, 20, 999]) {
      const d = tick({ emptyStreak, nowMs: BACKOFF_CAP_MS - 1 });
      expect(d.due).toBe(false);
      expect(tick({ emptyStreak, nowMs: BACKOFF_CAP_MS }).due).toBe(true);
    }
  });

  it("⭐ 兜底不变量：**任何** 空转次数下 threshold ≤ cap", () => {
    const cap = Math.max(BASE, BACKOFF_CAP_MS);
    for (let s = 0; s <= 40; s++) {
      expect(tick({ emptyStreak: s }).thresholdMs).toBeLessThanOrEqual(cap);
    }
  });

  it("用户选了 1 分钟 ⇒ 硬顶不小于它（不许退避到比基础节拍更快，也不许更慢）", () => {
    const d = tick({ baseMs: 60_000, emptyStreak: 9 });
    expect(d.capMs).toBe(60_000);
    expect(d.thresholdMs).toBe(60_000);
  });

  it("用户选了 30 秒 ⇒ 30 → 60 封顶", () => {
    expect(tick({ baseMs: 30_000, emptyStreak: 0 }).thresholdMs).toBe(30_000);
    expect(tick({ baseMs: 30_000, emptyStreak: 1 }).thresholdMs).toBe(60_000);
    expect(tick({ baseMs: 30_000, emptyStreak: 7 }).thresholdMs).toBe(60_000);
  });
});

describe("decideSyncTick：坏输入不许抛（读不到就按基础节拍跑）", () => {
  it("base 非法（0 / 负数 / NaN）⇒ 退化成 1ms，不发散也不抛", () => {
    for (const baseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decideSyncTick({ nowMs: 0, lastRunAtMs: 0, baseMs, emptyStreak: 0 });
      expect(Number.isFinite(d.thresholdMs)).toBe(true);
      expect(d.thresholdMs).toBeGreaterThan(0);
    }
  });

  it("streak 非法（负数 / NaN / 小数）⇒ 夹到合法范围", () => {
    expect(tick({ emptyStreak: -5 }).thresholdMs).toBe(BASE);
    expect(tick({ emptyStreak: Number.NaN }).thresholdMs).toBe(BASE);
    expect(tick({ emptyStreak: 2.9 }).thresholdMs).toBe(20_000);
  });
});

describe("roundWasEmpty：只有「明确收到东西」才算非空", () => {
  it("全空 / null / undefined ⇒ 空", () => {
    expect(roundWasEmpty([], [])).toBe(true);
    expect(roundWasEmpty([null, undefined], [null, undefined])).toBe(true);
    expect(roundWasEmpty([{ pulled: 0 }], [{ peers: [{ fetched: 0, applied: 0 }] }])).toBe(true);
  });

  it("服务端档 pulled > 0 ⇒ 非空", () => {
    expect(roundWasEmpty([{ pulled: 1 }], [])).toBe(false);
  });

  it("网格档 fetched > 0 或 applied > 0 ⇒ 非空", () => {
    expect(roundWasEmpty([], [{ peers: [{ fetched: 2 }] }])).toBe(false);
    expect(roundWasEmpty([], [{ peers: [{ fetched: 0, applied: 3 }] }])).toBe(false);
  });

  it("⚠️ 只有 error（读不到 / 拉不动）⇒ **算空** —— 最坏是「多退一点」，不是「少拉」", () => {
    expect(roundWasEmpty([{ pulled: 0 } as never], [{ peers: [{ fetched: 0, applied: 0 }] }])).toBe(true);
    // 形状缺字段（真出错时 Rust 侧可能不带这些数）⇒ 同样算空 ✓
    expect(roundWasEmpty([{} as never], [{ peers: [{}] } as never])).toBe(true);
  });
});
