// ★ 角标的数据源：**一个轮询，多个订阅者**（2026-09-26 真机收尾时读出来的问题）。
//
// 现场：`SyncPanel` 在手机上同时挂了**两个**实例（侧栏那颗按钮 ＋ 手机底部那个槽位），
// 而第一版是每个实例各自起一个 30 秒定时器 ⇒ 同一张表每 30 秒被问**两次**。
// 这条判据盯的就是"**只有一份真相、一个轮询**"：两个订阅者 ⇒ 一轮只许问一次库。
//
// 为什么用假定时器 ＋ 桩 API：这是**行为**（"几次调用"），不是形状 —— 文本级判据看不出
// "两个实例各起一个 interval"。变异：把 `subscribePendingRemoteTotal` 改成每个订阅者各起一个
// 定时器（＝第一版的形状）⇒ 第一条当场红。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listPendingRemotePages = vi.fn();
vi.mock("./api", () => ({
  api: {
    listPendingRemotePages: (...args: unknown[]) => listPendingRemotePages(...args),
  },
}));

import {
  PENDING_REMOTE_POLL_MS,
  publishPendingRemoteTotal,
  subscribePendingRemoteTotal,
} from "./pendingRemoteBadge";

// ⚠️ 假定时器装上之后 `setTimeout(0)` 不会自己跑 ⇒ 用 `advanceTimersByTimeAsync(0)` 当"让微任务跑完"。
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("角标的数据源：一个轮询、多个订阅者", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listPendingRemotePages.mockReset();
    listPendingRemotePages.mockResolvedValue({ total: 2, pages: [{ page_id: "p1" }] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★★ 两个订阅者 ⇒ **一轮只问一次库**（第一版是两个实例各问一次）", async () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const offA = subscribePendingRemoteTotal((n) => seenA.push(n));
    const offB = subscribePendingRemoteTotal((n) => seenB.push(n));

    await flush();
    expect(listPendingRemotePages, "订阅两个 ⇒ 一上来就问两次").toHaveBeenCalledTimes(1);
    // 两个订阅者都要拿到那个数字（第二个是立刻拿到的，没等下一轮）
    expect(seenA[seenA.length - 1]).toBe(2);
    expect(seenB[seenB.length - 1]).toBe(2);

    await vi.advanceTimersByTimeAsync(PENDING_REMOTE_POLL_MS);
    expect(listPendingRemotePages, "过了 30 秒又变成两次了").toHaveBeenCalledTimes(2);

    offA();
    offB();
  });

  it("最后一个订阅者走了 ⇒ 定时器停掉（不留一个没人要的轮询）", async () => {
    const offA = subscribePendingRemoteTotal(() => {});
    const offB = subscribePendingRemoteTotal(() => {});
    await flush();
    offA();
    await vi.advanceTimersByTimeAsync(PENDING_REMOTE_POLL_MS);
    const afterFirstOff = listPendingRemotePages.mock.calls.length;
    offB();
    await vi.advanceTimersByTimeAsync(PENDING_REMOTE_POLL_MS * 3);
    expect(listPendingRemotePages.mock.calls.length, "退订之后还在问库").toBe(afterFirstOff);
  });

  it("面板自己读到同一个数字时**公布**进来 ⇒ 订阅者立刻跟上，且不多读一次", async () => {
    const seen: number[] = [];
    const off = subscribePendingRemoteTotal((n) => seen.push(n));
    await flush();
    const before = listPendingRemotePages.mock.calls.length;
    publishPendingRemoteTotal(7);
    expect(seen[seen.length - 1], "公布的值没有传给订阅者").toBe(7);
    expect(listPendingRemotePages.mock.calls.length, "公布不该再读一次库（省这一次正是它的目的）").toBe(before);
    off();
  });

  it("晚来的订阅者立刻拿到现值（不用空等 30 秒）", async () => {
    const offA = subscribePendingRemoteTotal(() => {});
    await flush();
    const seenB: number[] = [];
    const offB = subscribePendingRemoteTotal((n) => seenB.push(n));
    expect(seenB, "第二个订阅者要立刻拿到现值").toEqual([2]);
    offA();
    offB();
  });

  it("读库失败 ⇒ **不改**那个数字（清成 0 会骗人）", async () => {
    const offA = subscribePendingRemoteTotal(() => {});
    await flush();
    const seen: number[] = [];
    const offB = subscribePendingRemoteTotal((n) => seen.push(n));
    expect(seen[seen.length - 1]).toBe(2);
    listPendingRemotePages.mockRejectedValueOnce(new Error("锁被毒掉了"));
    await vi.advanceTimersByTimeAsync(PENDING_REMOTE_POLL_MS);
    expect(seen[seen.length - 1], "读失败时把角标清成 0 了 ⇒ 用户以为没有待裁决的").toBe(2);
    offA();
    offB();
  });
});
