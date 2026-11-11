// 判据：影子看门「每天至少扫一次」（owner 2026-11-11 批 A / 需求 §12 P0-1）。
//
// 四条口径：
// ① 昨天有记录、今天还没有 ⇒ **启动就补扫一次**（空闲日也要落一条，7 天观察才成立）；
// ② 今天已有记录 ⇒ 启动**不**补扫（只有变化扫描）；
// ③ 跨天（日期变了）⇒ 下一次跨天检查补扫；
// ④ 历史为空（首次观测）⇒ **不**凭空扫（那会把“还没开始观测”写成假记录）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCrdtShadowWatch, type CrdtShadowWatchDeps } from "./useCrdtShadowWatch";
import { emptyShadowRows } from "./crdtShadowScan";
import { SHADOW_HISTORY_KEY } from "./crdtShadowHistory";
import { useSpaceStore } from "../store/space";

function Probe({ pagesVersion, deps }: { pagesVersion: number; deps: CrdtShadowWatchDeps }) {
  useCrdtShadowWatch(pagesVersion, deps);
  return null;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    get: (k: string) => map.get(k) ?? null,
  };
}

/** 一条最小合法历史记录（只给 daily 检查认日期用；其余计数合法即可）。 */
function day(date: string) {
  return { date, total: 0, withState: 0, equal: 0, differ: 0, uncomparable: 0 };
}

describe("useCrdtShadowWatch · 跨天补扫", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSpaceStore.setState({ activeId: "sp-dev" });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    useSpaceStore.setState({ activeId: null });
  });

  const render = (pagesVersion: number, deps: CrdtShadowWatchDeps) => {
    flushSync(() => root.render(<Probe pagesVersion={pagesVersion} deps={deps} />));
  };

  it("① 昨天有记录、今天还没有 ⇒ 启动就补扫一次", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    const storage = fakeStorage({
      [SHADOW_HISTORY_KEY]: JSON.stringify([day("2026-11-10")]),
    });
    render(0, {
      isDev: true,
      scan,
      consoleInfo: vi.fn(),
      storage,
      now: () => new Date(2026, 10, 11, 9),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("② 今天已有记录 ⇒ 启动不补扫（只有变化扫描）", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    const storage = fakeStorage({
      [SHADOW_HISTORY_KEY]: JSON.stringify([day("2026-11-11")]),
    });
    render(0, {
      isDev: true,
      scan,
      consoleInfo: vi.fn(),
      storage,
      now: () => new Date(2026, 10, 11, 9),
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(1); // 只有变化扫描
  });

  it("③ 跨天 ⇒ 下一次跨天检查补扫", async () => {
    let nowMs = new Date(2026, 10, 11, 9).getTime();
    const scan = vi.fn(async () => emptyShadowRows());
    const storage = fakeStorage({
      [SHADOW_HISTORY_KEY]: JSON.stringify([day("2026-11-11")]),
    });
    render(0, {
      isDev: true,
      scan,
      consoleInfo: vi.fn(),
      storage,
      dailyCheckMs: 60_000,
      now: () => new Date(nowMs),
    });
    await vi.advanceTimersByTimeAsync(3000); // 变化扫描写 11-11
    expect(scan).toHaveBeenCalledTimes(1);
    nowMs = new Date(2026, 10, 12, 9).getTime(); // 跨天
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(2); // 补扫 11-12
  });

  it("④ 历史为空（首次观测）⇒ 不凭空扫", async () => {
    const scan = vi.fn(async () => emptyShadowRows());
    render(0, {
      isDev: true,
      scan,
      consoleInfo: vi.fn(),
      storage: fakeStorage(),
      now: () => new Date(2026, 10, 11, 9),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(scan).toHaveBeenCalledTimes(1); // 变化扫描
  });
});
