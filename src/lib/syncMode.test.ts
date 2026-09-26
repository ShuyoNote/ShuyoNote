// `syncMode` 的判据：**三档**各自映射到什么、以及那条不变式（近实时**不禁用轮询**）。
//
// 为什么这几条值钱：面板上那一个下拉背后是**两个**底层设置（localStorage `shuyonote:autoSync`
// 与 `shuyonote:nearRealtime`），而 App 里那条定时器只认前者。所以"选了近实时 ⇒ 间隔是多少"
// 必须有人钉住 —— 钉错了的形状是"看着像开了近实时，其实轮询也被关了"，而那时**流一断就什么都不同步**。
import { describe, expect, it } from "vitest";

import {
  AUTO_SYNC_CHANGED_EVENT,
  SYNC_INTERVAL_MS,
  SYNC_REALTIME_FALLBACK_MS,
  readAutoSyncMs,
  settingsForMode,
  syncModeHint,
  syncModeOf,
  writeAutoSyncMs,
  type SyncMode,
} from "./syncMode";

const MODES: SyncMode[] = ["off", "interval", "realtime"];

describe("读：当前设置落在哪一档", () => {
  it("近实时开着 ⇒ `realtime`（**不管**间隔是多少 —— 它本来就可能与老值并存）", () => {
    expect(syncModeOf(0, true)).toBe("realtime");
    expect(syncModeOf(60_000, true)).toBe("realtime");
  });

  it("近实时关着 ＋ 间隔 > 0 ⇒ `interval`；间隔 0 ⇒ `off`", () => {
    expect(syncModeOf(10_000, false)).toBe("interval");
    expect(syncModeOf(300_000, false)).toBe("interval");
    expect(syncModeOf(0, false)).toBe("off");
  });

  it("老值（面板收窄前存的 10 秒 / 1 分钟 / 5 分钟）都能映射回来 —— 不把用户的设置读没", () => {
    for (const legacy of [10_000, 30_000, 60_000, 300_000]) {
      expect(syncModeOf(legacy, false)).toBe("interval");
    }
  });
});

describe("写：选了某一档之后的两个底层设置", () => {
  it("★ **近实时那一档的兜底轮询必须 > 0**（否则流一断就彻底不同步）", () => {
    const s = settingsForMode("realtime");
    expect(s.nearRealtime).toBe(true);
    expect(s.autoMs, "近实时档把间隔设成 0 ⇒ 轮询被关掉 ⇒ 流断了什么都不更新").toBeGreaterThan(0);
    expect(s.autoMs).toBe(SYNC_REALTIME_FALLBACK_MS);
  });

  it("「关闭」两件事都关；「按间隔」只有间隔、近实时关着", () => {
    expect(settingsForMode("off")).toEqual({ autoMs: 0, nearRealtime: false });
    expect(settingsForMode("interval")).toEqual({ autoMs: SYNC_INTERVAL_MS, nearRealtime: false });
  });

  it("**往返一致**：`settingsForMode` 出来的值，`syncModeOf` 必须读回同一档", () => {
    for (const m of MODES) {
      const s = settingsForMode(m);
      expect(syncModeOf(s.autoMs, s.nearRealtime), `「${m}」档读回来变成了别的档`).toBe(m);
    }
  });

  it("★ 不变式「轮询仍然挂着」：坏设置（近实时 ＋ 间隔 0）必须被判红", () => {
    // 这条不变式就是"流断了也还能自己找回来"的实现形态。写成**谓词**而不是写死数字，
    // 是为了让它同时干两件事：证明当前设置合规，**并且**证明坏设置真的会被抓住
    // （有人把 `SYNC_REALTIME_FALLBACK_MS` 改成 0 ⇒ 上面那条「兜底轮询 > 0」当场红）。
    const pollingStillMounted = (s: { autoMs: number; nearRealtime: boolean }) =>
      s.nearRealtime ? s.autoMs > 0 : true;
    expect(pollingStillMounted(settingsForMode("realtime"))).toBe(true);
    expect(
      pollingStillMounted({ autoMs: 0, nearRealtime: true }),
      "「近实时 ＋ 间隔 0」是一个坏设置（流一断就什么都不更新）—— 它必须为假",
    ).toBe(false);
  });

  it("三档各自都有一句人话（面板只显示这一句，不另写）", () => {
    for (const m of MODES) expect(syncModeHint(m).length).toBeGreaterThan(8);
    expect(syncModeHint("interval")).toContain("30 秒");
    expect(syncModeHint("realtime")).toContain("5 分钟");
  });
});

describe("落盘与广播（面板改档 ⇒ App 那条定时器要重挂）", () => {
  it("写进去读得回来，并且**广播一次**（订阅方靠它把新档位接上）", () => {
    let heard = 0;
    const onChanged = () => heard++;
    window.addEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
    try {
      writeAutoSyncMs(SYNC_INTERVAL_MS);
      expect(readAutoSyncMs()).toBe(SYNC_INTERVAL_MS);
      expect(heard, "写档位必须广播一次 —— 否则 App 不会重挂定时器").toBe(1);
      writeAutoSyncMs(0);
      expect(readAutoSyncMs()).toBe(0);
      expect(heard).toBe(2);
    } finally {
      window.removeEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
      writeAutoSyncMs(0); // 别把状态留给别的用例（同一个 happy-dom 进程）
    }
  });
});
