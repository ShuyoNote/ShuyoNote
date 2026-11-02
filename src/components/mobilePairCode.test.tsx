// 移动端「首次配对」屏（`MobilePairCode`）的判据 —— 2026-10-29 补。
//
// 为什么补：R176-A 把它从"逐位比对 20 位长串"改成"只显示对方身份（设备名 ＋ 短标识）"，
// 而这块**此前一个测试文件都没有**（桌面那条线有 `SyncPanel.trustDevicePanel.wiring.test.tsx`）。
// 这类屏最容易出的三类错：① 屏上又冒出数字/「码」字样（R176-A 前功尽弃）；② 没点就自动发
// 信任命令（"自动通过"）；③ 缺前置条件（活动空间/pubkey）时仍然发命令或静默失败。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

// 本屏只经 `platform.executor.invoke` 与宿主打交道（无 `api.*`）；把整个 platform 模块桩掉，
// 顺便钉住"它调的是同一条 `mesh_trust_begin` 命令"。
vi.mock("../lib/platform", () => ({
  platform: { executor: { invoke: mocks.invoke } },
  isDesktopPlatform: () => false,
  isMobileUserAgent: () => true,
}));

import { MobilePairCode } from "./MobilePairCode";
import { MESH_TRUST_BEGIN_COMMAND } from "../lib/trustDevicePanelReadings";
import { useMobileNav } from "../store/mobileNav";
import { useSpaceStore } from "../store/space";

const PUBKEY = "ab".repeat(32);
const PEER = { deviceId: "dev-b", deviceName: "ZHAI-AMD", shortId: "2QS2T", pubkey: PUBKEY };

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { root, render: () => flushSync(() => root.render(React.createElement(MobilePairCode))) };
}
const text = () => document.body.textContent ?? "";
const q = (sel: string) => document.querySelector<HTMLElement>(sel);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  useSpaceStore.setState({ activeId: "sp-1" });
  useMobileNav.setState({ screen: "paircode", cameFrom: "pair", pairPeer: { ...PEER } });
});

afterEach(() => {
  document.body.innerHTML = "";
  useMobileNav.setState({ pairPeer: null });
});

describe("移动端首次配对屏（R176-A：只显示身份，不显示任何码）", () => {
  it("① 身份行 = 「设备名 · 短标识」；屏上**没有**数字网格、也没有「码」字样", () => {
    const { render, root } = mount();
    render();
    const id = q('[data-testid="mpair-device-identity"]');
    expect(id, "身份行必须在").not.toBeNull();
    expect(id!.textContent).toContain("ZHAI-AMD");
    expect(id!.textContent).toContain("2QS2T");
    // ⛔ 旧的 20 位网格（`.mpair-code-grid`）不许回来
    expect(q(".mpair-code-grid")).toBeNull();
    // ⛔ 「码」字样不许出现在这一屏的可见文案里（R176-A 的原文要求）
    expect(text()).not.toMatch(/[码]/);
    // ⛔ 也不许出现"连续 4 位以上数字"那种要人念的形状
    expect(text()).not.toMatch(/\d{4}/);
    flushSync(() => root.unmount());
  });

  it("② 对端没报短标识 ⇒ 如实说「对方没报短标识」（⛔ 不回落成设备号）", () => {
    useMobileNav.setState({ pairPeer: { ...PEER, shortId: "" } });
    const { render, root } = mount();
    render();
    const id = q('[data-testid="mpair-device-identity"]');
    expect(id!.textContent).toContain("对方没报短标识");
    expect(id!.textContent).not.toContain("dev-b");
    flushSync(() => root.unmount());
  });

  it("③ 挂着不发命令：进屏（含等一拍）后 `mesh_trust_begin` **零调用**", async () => {
    const { render, root } = mount();
    render();
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });

  it("④ 点「就是这台，确认」⇒ `mesh_trust_begin` **恰一次**，参数是那三格", async () => {
    const { render, root } = mount();
    render();
    const btn = q('[data-testid="mpair-code-confirm"]') as HTMLButtonElement;
    expect(btn, "确认按钮必须在").not.toBeNull();
    flushSync(() => btn.click());
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenCalledWith(MESH_TRUST_BEGIN_COMMAND, {
      spaceId: "sp-1",
      peerDeviceId: "dev-b",
      peerPubkey: PUBKEY,
    });
    // 成功 ⇒ 回上一屏（`cameFrom` 那套）
    expect(useMobileNav.getState().screen).toBe("pair");
    flushSync(() => root.unmount());
  });

  it("⑤ 没有活动空间 ⇒ 点确认**不发命令**，并如实报错（⛔ 不静默）", async () => {
    useSpaceStore.setState({ activeId: null });
    const { render, root } = mount();
    render();
    const btn = q('[data-testid="mpair-code-confirm"]') as HTMLButtonElement;
    flushSync(() => btn.click());
    await vi.waitFor(() => expect(q('[data-testid="mpair-code-error"]')).not.toBeNull());
    expect(q('[data-testid="mpair-code-error"]')!.textContent).toContain("没有活动空间");
    expect(mocks.invoke).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });

  it("⑥ 点「取消」⇒ 零命令 ＋ 回上一屏", () => {
    const { render, root } = mount();
    render();
    const cancel = q(".mpair-code-cancel") as HTMLButtonElement;
    flushSync(() => cancel.click());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useMobileNav.getState().screen).toBe("pair");
    flushSync(() => root.unmount());
  });
});
