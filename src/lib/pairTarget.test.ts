// `autoPickPeer` 的判据 ✓（owner 2026-10-08：「附近设备同步流程太繁琐」⇒ 简化的**机器守门** ✓）。
// 反例（改造前）：默认「不指定」⇒ 用户只能走"要配两次"那条兜底 ✗。
import { describe, expect, it } from "vitest";
import { autoPickPeer } from "./pairTarget";

const A = { device_id: "dev-a" };
const B = { device_id: "dev-b" };

describe("autoPickPeer（自动选中对端）", () => {
  it("恰好一台 ⇒ 选它（走「一次双向」那条正路 ✓）", () => {
    expect(autoPickPeer([A], "")).toBe("dev-a");
  });
  it("一台都没有 ⇒ 不选（保留兜底：码离线传、要配两次 ✓）", () => {
    expect(autoPickPeer([], "")).toBe("");
  });
  it("多台 ⇒ 不替用户挑（挑错就是连错设备 ✗）", () => {
    expect(autoPickPeer([A, B], "")).toBe("");
  });
  it("用户已经选过 ⇒ 绝不覆盖（含主动选「不指定」✓）", () => {
    expect(autoPickPeer([A], "dev-choice")).toBe("dev-choice");
    expect(autoPickPeer([A, B], "dev-choice")).toBe("dev-choice");
  });
  it("已经选了 A、但候选里只剩 B ⇒ 仍保留用户的选择（不悄悄改口 ✓）", () => {
    expect(autoPickPeer([B], "dev-a")).toBe("dev-a");
  });
});
