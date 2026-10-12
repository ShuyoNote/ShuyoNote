// 判据（task 派单：把 `TrustDevicePanel` 挂到同步面板上）。
//
// ⭐ 两半都用机器判：
//   ⭐ **结果级**：把面板**真渲染**出来（`createRoot` ＋ `flushSync`，照 `TrustDevicePanel.test.tsx:10-11`
//      的房规 —— 本仓**没有** @testing-library ✓），断言那几条"读不到"槽位**都出现** ✓
//      且**没有一个显示 0** ✓（⛔ 0 是一个**结论**，"读不到"是**没有结论** —— 界面上必须长得不一样 ✓）
//      ⚠️ 2026-10-11（任务 B）：槽位从四条变**五条** ✗（多了"走到哪一步" ✓，见 `TrustDevicePanel.test.tsx`
//         那一组 ✓）—— 这条清单**跟着读数一起长** ✓，⛔ 不是漏了一条 ✗。
//   ⭐ **接线级**：`SyncPanel.tsx` 里真的挂了这个面板 ＋ 老路（严格模式那一折）**还在** ✓
//
// ⭐ **怎么看出它会红**（三条，逐条都能真跑）：
//   · 把 `unavailableTrustDeviceReadings` 改成返回 `{ kind: "ok", value: [] }`
//     ⇒ 第 1 条红 ✓（那是"编 0 冒充没有"✗ 的**机器版** ✓）
//   · 把 `SyncPanel.tsx` 里的 `<TrustDevicePanel …/>` 删掉 ⇒ 第 3 条红 ✓（＝"挂载点又变回 0 处" ✓）
//   · 把「严格模式（高级）」那一折删掉/改名 ⇒ 第 3 条红 ✓（＝"把老路弄坏了" ✓）
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { TrustDevicePanel } from "./TrustDevicePanel";
import {
  MESH_TRUST_BEGIN_COMMAND,
  TRUST_READINGS_UNAVAILABLE_REASON,
  unavailableTrustDeviceReadings,
} from "../lib/trustDevicePanelReadings";

const SYNC_PANEL_SRC = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  return host;
}

describe("信任设备那一屏 · 挂载 ＋ 读不到（task 派单）", () => {
  it("1) ⭐ 读数**全是 unavailable**（⛔ 一个 `ok` 都没有 ⇒ ⛔ 不许拿 0 冒充『没有』）＋ 每条都带人话原因", () => {
    const r = unavailableTrustDeviceReadings();
    for (const [key, value] of Object.entries(r)) {
      expect(value.kind, `${key} 不是「读不到」⇒ 那是拿 0／假数冒充 ✗`).toBe("unavailable");
      if (value.kind === "unavailable") {
        expect(value.reason.trim().length, `${key} 的"读不到"没给原因`).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(r).sort()).toEqual([
      "attachOffer",
      "deviceCode",
      "localSpaces",
      "mergeOverlap",
      "trustState",
    ]);
  });

  it("2) ⭐ **结果级**：真渲染那一屏 ⇒ 五个槽位都出现「读不到」，且**没有一个显示 0**", () => {
    const el = render(<TrustDevicePanel {...unavailableTrustDeviceReadings()} />);
    // ⭐ 面板自己给这五个槽位挂了 testid（`TrustDevicePanel.tsx` 里各一处 ✓）
    for (const id of [
      "offer-unavailable",
      "overlap-unavailable",
      "code-unavailable",
      "local-unavailable",
      "trust-state-unavailable",
    ]) {
      const node = el.querySelector(`[data-testid="${id}"]`);
      expect(node, `${id} 没渲染出来（面板没挂上／读数被当成有值了？）`).toBeTruthy();
      expect(node!.textContent ?? "", `${id} 里没出现「读不到」`).toContain("读不到");
      // ⛔ 这一格里**不许**出现单独的 0（那会读成"没有重合／没有空间"＝一个结论 ✗）
      expect(node!.textContent ?? "", `${id} 里出现了 0 冒充"没有" ✗`).not.toMatch(/(^|\D)0(\D|$)/);
    }
    // ⭐ 而且原因要**真的写出来**（不是只说"读不到"三个字 ✓）
    expect(el.textContent ?? "").toContain(TRUST_READINGS_UNAVAILABLE_REASON);
  });

  it("3) ⭐ 接线：`SyncPanel` 真的挂了这一屏 ＋ ⭐ 老路（严格模式（高级）那一折）还在", () => {
    expect(SYNC_PANEL_SRC, "SyncPanel 没挂 TrustDevicePanel ⇒ 界面上还是点不到").toContain("<TrustDevicePanel");
    expect(SYNC_PANEL_SRC, "没给读数 ⇒ 面板拿不到 props").toContain("unavailableTrustDeviceReadings()");
    expect(SYNC_PANEL_SRC, "没接「信任这台设备」那条命令（owner 拍的甲：一端点就通）").toContain(
      MESH_TRUST_BEGIN_COMMAND,
    );
    // ⭐⛔ 老路一个字不许动：`device_pair_advanced`（严格模式那一折）与里面的 `device_pair` 都要在 ✓
    expect(SYNC_PANEL_SRC, "把「严格模式（高级）」那一折弄坏了 ✗").toContain('data-testid="device-pair-advanced"');
    expect(SYNC_PANEL_SRC, "严格模式里那套机制被删了 ✗").toContain('data-testid="device-pair"');
  });
});
