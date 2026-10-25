// ⭐ 2026-10-24（owner 报「同步了没有自动刷新页面」）：
// 同步回来时"要不要自动重挂当前页"的节流判据。判据本身很短，但它挡的是一个真事故：
// 同步一拍一跑（设备直连默认 2~5 秒），而编辑器保存有 600ms 去抖 —— 无脑自动刷会把
// 用户"正在敲、还没落库"的那几百毫秒换掉（看着像吞字）。
import { beforeEach, describe, expect, it } from "vitest";
import {
  REFRESH_IDLE_MS,
  isLocalEditRecent,
  markLocalEdit,
  msSinceLocalEdit,
  resetLocalEditClockForTests,
} from "./editIdle";

describe("editIdle · 同步回来时要不要自动重挂当前页", () => {
  beforeEach(() => resetLocalEditClockForTests());

  it("从没编辑过 ⇒ 距上次编辑是 Infinity、允许刷（启动后第一次同步不能被误挡）", () => {
    expect(msSinceLocalEdit(1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(isLocalEditRecent(1_000)).toBe(false);
  });

  it("刚编辑过（< 阈值）⇒ 不许刷", () => {
    markLocalEdit(1_000);
    expect(msSinceLocalEdit(1_000 + REFRESH_IDLE_MS - 1)).toBe(REFRESH_IDLE_MS - 1);
    expect(isLocalEditRecent(1_000 + REFRESH_IDLE_MS - 1)).toBe(true);
  });

  it("编辑过去超过阈值 ⇒ 可以刷（下一拍就能看到远端那版）", () => {
    markLocalEdit(1_000);
    expect(isLocalEditRecent(1_000 + REFRESH_IDLE_MS)).toBe(false);
  });

  it("阈值必须大于编辑器保存去抖（600ms）—— 否则刷到一半正好被保存覆盖", () => {
    expect(REFRESH_IDLE_MS).toBeGreaterThan(600);
  });
});
