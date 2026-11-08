// ⭐ task-67：dev 看门扫描后写近 7 天历史；生产不写；坏 JSON 重置。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCrdtShadowWatch, type CrdtShadowWatchDeps } from "./useCrdtShadowWatch";
import { emptyShadowRows } from "./crdtShadowScan";
import type { ShadowRowsResult } from "./crdtShadow";
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

describe("useCrdtShadowWatch · 历史写入", () => {
  let host: HTMLDivElement;
  let root: Root;
  let info: Mock<(message: string, data: ShadowRowsResult) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    info = vi.fn<(message: string, data: ShadowRowsResult) => void>();
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

  it("dev 扫描成功 ⇒ 写一条当天记录（只有计数）", async () => {
    const storage = fakeStorage();
    const summary = { ...emptyShadowRows(), total: 2, withState: 2, equal: 1, differ: 1 };
    render(0, {
      isDev: true,
      scan: vi.fn(async () => summary),
      consoleInfo: info,
      storage,
      now: () => new Date(2026, 10, 9, 12),
    });
    await vi.advanceTimersByTimeAsync(3000);
    const raw = storage.get(SHADOW_HISTORY_KEY);
    expect(raw).toBeTruthy();
    const list = JSON.parse(raw!) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      date: "2026-11-09",
      total: 2,
      withState: 2,
      equal: 1,
      differ: 1,
      uncomparable: 0,
    });
    expect(raw).not.toContain("differPageIds");
  });

  it("生产（isDev=false）⇒ 不扫描也不写", async () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    render(0, {
      isDev: false,
      scan: vi.fn(async () => emptyShadowRows()),
      consoleInfo: info,
      storage,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(setItem).not.toHaveBeenCalled();
    expect(storage.get(SHADOW_HISTORY_KEY)).toBeNull();
  });

  it("坏 JSON ⇒ 重置为合法数组（旧内容不被沿用）", async () => {
    const storage = fakeStorage({ [SHADOW_HISTORY_KEY]: "not json" });
    render(0, {
      isDev: true,
      scan: vi.fn(async () => ({ ...emptyShadowRows(), total: 1 })),
      consoleInfo: info,
      storage,
      now: () => new Date(2026, 10, 9, 12),
    });
    await vi.advanceTimersByTimeAsync(3000);
    const list = JSON.parse(storage.get(SHADOW_HISTORY_KEY)!) as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
  });

  it("storage 抛错 ⇒ 只吞掉，不影响扫描/日志", async () => {
    const storage = {
      getItem: () => {
        throw new Error("隐私模式");
      },
      setItem: () => {
        throw new Error("配额");
      },
    };
    const scan = vi.fn(async () => ({ ...emptyShadowRows(), total: 1 }));
    render(0, { isDev: true, scan, consoleInfo: info, storage });
    await vi.advanceTimersByTimeAsync(3000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
