// `syncMode` 的判据：**三档**各自映射到什么、以及那条不变式（近实时**不禁用轮询**）。
//
// 为什么这几条值钱：面板上那一个下拉背后是**两个**底层设置（localStorage `shuyonote:autoSync`
// 与 `shuyonote:nearRealtime`），而 App 里那条定时器只认前者。所以"选了近实时 ⇒ 间隔是多少"
// 必须有人钉住 —— 钉错了的形状是"看着像开了近实时，其实轮询也被关了"，而那时**流一断就什么都不同步**。
import { afterEach, describe, expect, it } from "vitest";

import { NEAR_REALTIME_KEY, isNearRealtimeEnabled } from "./nearRealtime";
import {
  AUTO_SYNC_CHANGED_EVENT,
  AUTO_SYNC_KEY,
  SYNC_INTERVAL_MS,
  SYNC_REALTIME_FALLBACK_MS,
  broadcastAutoSyncChanged,
  effectiveAutoSyncMs,
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

describe("★ **行为侧**：有效间隔 `effectiveAutoSyncMs()`（真机抓到的口径不一致）", () => {
  // 现场（两台真机 2026-09-26）：面板显示「近实时」＋那句人话承诺"连不上时退回每 5 分钟兜底一次"，
  // 而 localStorage 里 `shuyonote:autoSync` **一个字都没写**（用户从没动过下拉框），
  // `shuyonote:nearRealtime` 又是**默认开** ⇒ 裸读 = 0 ⇒ App 那条定时器**不挂** ⇒
  // **一次自动同步都不会发生**。方向是最坏的那种：用户以为在自动同步，其实没有。
  const setKeys = (autoMs: number | null, nearRealtime: boolean | null) => {
    if (autoMs === null) localStorage.removeItem(AUTO_SYNC_KEY);
    else localStorage.setItem(AUTO_SYNC_KEY, String(autoMs));
    if (nearRealtime === null) localStorage.removeItem(NEAR_REALTIME_KEY);
    else localStorage.setItem(NEAR_REALTIME_KEY, nearRealtime ? "1" : "0");
  };
  afterEach(() => setKeys(null, null));

  it("★★ 近实时开着而间隔**没写过** ⇒ 必须按 5 分钟兜底跑（**不能是 0**）", () => {
    setKeys(null, null); // 真机现场的形状：两个键都从没被写过
    expect(readAutoSyncMs(), "前提：裸读确实是 0（否则这条判据测的不是那个现场）").toBe(0);
    expect(
      effectiveAutoSyncMs(),
      "近实时开着却算出 0 ⇒ 定时器不挂 ⇒ 面板那句「退回每 5 分钟兜底一次」是空话",
    ).toBe(SYNC_REALTIME_FALLBACK_MS);
    // ★ 与那条不变式**同一个谓词**：读出来的有效值必须让"轮询仍然挂着"成立。
    const pollingStillMounted = (s: { autoMs: number; nearRealtime: boolean }) =>
      s.nearRealtime ? s.autoMs > 0 : true;
    expect(
      pollingStillMounted({ autoMs: effectiveAutoSyncMs(), nearRealtime: isNearRealtimeEnabled() }),
      "「近实时 ＋ 间隔 0」就是判据里写死的那个坏设置 —— 读这一侧不许再让它成立",
    ).toBe(true);
  });

  it("近实时**显式关掉** 而间隔是 0 ⇒ 真的是「关闭」，一个字都不加", () => {
    setKeys(0, false);
    expect(effectiveAutoSyncMs()).toBe(0);
  });

  it("间隔写了就听间隔的（近实时开不开都不改它）", () => {
    setKeys(SYNC_INTERVAL_MS, false);
    expect(effectiveAutoSyncMs()).toBe(SYNC_INTERVAL_MS);
    setKeys(10_000, true);
    expect(effectiveAutoSyncMs()).toBe(10_000);
  });

  it("三档写下去之后，**有效值**读回来与那一档的语义一致（写读往返）", () => {
    for (const m of MODES) {
      const s = settingsForMode(m);
      setKeys(s.autoMs, s.nearRealtime);
      const effective = effectiveAutoSyncMs();
      if (m === "off") expect(effective, "「关闭」档居然还有自动间隔").toBe(0);
      else expect(effective, `「${m}」档的有效间隔算成了 0`).toBeGreaterThan(0);
    }
  });

  it("`broadcastAutoSyncChanged()` 自己就是那条广播（面板两半都落定后要再喊一次）", () => {
    let heard = 0;
    const onChanged = () => heard++;
    window.addEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
    try {
      broadcastAutoSyncChanged();
      expect(heard).toBe(1);
    } finally {
      window.removeEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
    }
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
