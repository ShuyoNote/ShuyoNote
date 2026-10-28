// ⭐ **R176-A ④「能读的状态」** 的**结果级**判据（真渲染，⛔ 不是只读源码 ✗）。
//
// 为什么要有这一层：纯函数（`src/lib/personalSyncReadout.test.ts`）只证明**算得对** ✓；
// 但用户看见的是**组件摆出来**的那三格 —— 值传错位／单位丢了／诊断句不渲染，函数测试都绿 ✓。
// 本仓**没有** @testing-library ⇒ 照 `SyncPanel.trustDevicePanel.wiring.test.tsx` 的老规矩：
// `createRoot` ＋ `flushSync` ＋ 真 DOM 断言 ✓（happy-dom 环境 ✓）。
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SyncReadout } from "./SyncReadout";
import {
  READOUT_UNREAD,
  ROUTE_DIRECT,
  UNTRUST_SCOPE_NOTE,
  discoveryDiagnosis,
  type PersonalSyncReadout,
} from "../lib/personalSyncReadout";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: PersonalSyncReadout): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<SyncReadout {...props} />));
  return host;
}

describe("R176-A ④：三格读数真的摆到屏上（值／单位／读不到）", () => {
  it("① 三格全在，且逐格对得上（走哪条路 / 服务 N 个空间 / 已信任 N 台）", () => {
    const el = render({ route: ROUTE_DIRECT, served: { kind: "ok", n: 3 }, trusted: { kind: "ok", n: 2 }, diagnosis: null });
    expect(el.querySelector('[data-testid="readout-route"]')?.textContent).toContain(ROUTE_DIRECT);
    const served = el.querySelector('[data-testid="readout-served"]')?.textContent ?? "";
    expect(served, "服务几个空间：值 ＋ 单位都要在").toContain("3");
    expect(served).toContain("个空间");
    const trusted = el.querySelector('[data-testid="readout-trusted"]')?.textContent ?? "";
    expect(trusted).toContain("本机");
    expect(trusted).toContain("2");
    expect(trusted).toContain("台已信任");
  });

  it("② 读不到 ⇒ 显示「未读到」，⛔ 不显示 0（0 是结论、读不到是没有结论）", () => {
    const el = render({
      route: READOUT_UNREAD,
      served: { kind: "unread" },
      trusted: { kind: "unread" },
      diagnosis: null,
    });
    const value = (key: string) =>
      el.querySelector(`[data-testid="readout-${key}"] .sync-hero-meta-v`)?.textContent ?? "";
    expect(value("route")).toBe(READOUT_UNREAD);
    expect(value("served")).toBe(READOUT_UNREAD);
    expect(value("trusted")).toBe(READOUT_UNREAD);
  });

  it("③ 真的 0 台／0 个空间 ⇒ 才显示 0（与上一条是两件事）", () => {
    const el = render({ route: ROUTE_DIRECT, served: { kind: "ok", n: 0 }, trusted: { kind: "ok", n: 0 }, diagnosis: null });
    const value = (key: string) =>
      el.querySelector(`[data-testid="readout-${key}"] .sync-hero-meta-v`)?.textContent ?? "";
    expect(value("served")).toBe("0");
    expect(value("trusted")).toBe("0");
    expect(el.textContent ?? "").toContain("台已信任");
  });

  it("④ J9 的诊断句：有就必须渲染，没有就一个空壳都不留", () => {
    const d = discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 2 }, nearbyCount: 0 });
    expect(d, "夹具前提：这个形状本该出诊断句").toBeTruthy();
    const withD = render({ route: ROUTE_DIRECT, served: { kind: "ok", n: 1 }, trusted: { kind: "ok", n: 2 }, diagnosis: d });
    expect(withD.querySelector('[data-testid="discovery-diagnosis"]')?.textContent).toBe(d);
    flushSync(() => root!.unmount());
    host!.remove();
    const withoutD = render({ route: ROUTE_DIRECT, served: { kind: "ok", n: 1 }, trusted: { kind: "ok", n: 2 }, diagnosis: null });
    expect(withoutD.querySelector('[data-testid="discovery-diagnosis"]'), "没有原因可解释时⛔ 不许留一条空条").toBeNull();
  });

  it("⑤ 自己写的文案不许在屏上出现 Markdown 星号（会原样显示 ✗）", () => {
    const el = render({
      route: READOUT_UNREAD,
      served: { kind: "unread" },
      trusted: { kind: "unread" },
      diagnosis: discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 1 }, nearbyCount: 0 }),
    });
    const text = el.textContent ?? "";
    expect(text).not.toContain("**");
    // 顺带钉住「解除语义那句」没跑到这一屏来（它在设备卡片上，`syncPanelPersonalTrust.wiring.test.ts` 钉着）
    expect(text).not.toContain(UNTRUST_SCOPE_NOTE);
  });
});
