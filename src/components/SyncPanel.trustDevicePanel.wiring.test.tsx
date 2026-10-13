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
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrustDevicePanel } from "./TrustDevicePanel";
import {
  MESH_TRUST_BEGIN_COMMAND,
  TRUST_READINGS_UNAVAILABLE_REASON,
  unavailableTrustDeviceReadings,
} from "../lib/trustDevicePanelReadings";

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **修 B（2026-10-13，owner 拍板 ＋ Lead 三条裁定）**：「允许/信任」的**主路径**必须真的可点 ✗。
//
// 现场（owner 实测逐字）：「在「附近的设备」那一行 `ZHAI-AMD` 上**点不动**」——
// 诊断（`_tmp/scratch/trust-button-diag-20261013.md` ✓）：那一行右端**渲染 `null`** ✗
// （`SyncPanel.tsx:2080`，因为 `serves_current === false` ✓），而真正的"允许"动作
// （`trustDevice()` ⇒ `mesh_trust_begin`）原先**只由** `TrustDevicePanel` 里那颗「接入」触发 ✗ ——
// 那颗按钮在四格读数 `unavailable` 时**压根不渲染**（`TrustDevicePanel.tsx:197-241` ✓）。
//
// ⇒ 本组钉**新契约**：⭐ 「附近的设备」那一行自己必须给一颗**走 `trustDevice` 的**按钮 ✓
//   （⛔ 不再依赖勾选 `pickedCount` ✗）；`serves_current === false` ⇒ **必须有可见文案**（⛔ 不许静默 `null` ✗）。
//
// ⚠️ 为什么这组要**真挂 `SyncPanel`** ✗：这一片的全部价值就是"**用户点得到**" ——
//   只读源码判不了"那颗按钮真会被渲染出来"，而 `TrustDevicePanel` 单独挂又盖不到**那一行** ✓。
//   ⚠️ 本仓既有接线判据多是**文本级**（见 `syncPanelMesh.wiring.test.ts` 头注的理由 ✓）；
//      这一组升级成**真渲染 ＋ 真点**：`createRoot` ＋ `flushSync`（本仓无 @testing-library ✓）
//      ＋ `api` ／ `platform.executor.invoke` 换桩 ⇒ ⛔ 不起真 Chromium ✗。
// ═══════════════════════════════════════════════════════════════════════════════

/** ⚠️ `__TAURI_INTERNALS__` 必须在**模块加载之前**就在 ⇒ `platform/index.ts:67` 才会选桌面那一档
 *  （`isDesktopPlatform()` ＝ 「有没有 Rust 内核」✓ —— 本判据量的正是桌面那一支 ✓）。 */
const { invokeSpy, lanStatusSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  return { invokeSpy: vi.fn(), lanStatusSpy: vi.fn() };
});

/** ⚠️ `api` 除下面两条外一律"空读数"（面板那些分支只读、不崩 ✓）—— 本判据只问**那一行的可达性** ✓。
 *  ⚠️⭐ 这两条**必须给数组** ✗：`refresh()` 里 `new Map(profiles.map(…))`（`SyncPanel.tsx:541` ✓）拿到
 *  `null` 会当场抛 ⇒ `setRows` 跑不到 ⇒ `activeRow` 空 ⇒ ⭐ 连**「附近设备」那一整块**（它被
 *  `:1962` 的 `!!activeRow` 挡着 ✓）都不渲染 ⇒ 那是一条**夹具假红**（实测踩到一次 ✓）。 */
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      lanStatus: (id: string) => lanStatusSpy(id),
      listSyncProfiles: async () => [],
      spaceSecurityOverview: async () => [],
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => null) },
  ),
}));

import { platform } from "../lib/platform";
import { AUTO_SYNC_KEY } from "../lib/syncMode";
import { useSpaceStore } from "../store/space";
import type { NearbyPeer } from "../lib/platform/commands";
import { SyncPanel } from "./SyncPanel";

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
    // ⭐ **R192「换对象不删断言」（Lead 2026-10-13 拍）**：这一格原来断言源码**必须含**
    //    `unavailableTrustDeviceReadings()` ✗ —— 那钉的是"四格读数一律读不到"这个**占位状态**，
    //    与「用户点得到吗」无关（后端把读数做出来之后它还会**挡路** ✗）。
    //    ⇒ 改成指向**新契约**：⭐ 那一行自己必须有一颗走 `trustDevice` 的按钮 ✓（⛔ 不是删掉这条 ✗，
    //    也不是降低强度 ✗ —— 下面第 4 组会**真挂面板、真点它** ✓）。
    expect(SYNC_PANEL_SRC, "「附近的设备」那一行没给「允许」入口 ⇒ 又回到『点不了』✗").toContain(
      'data-testid="nearby-allow"',
    );
    expect(SYNC_PANEL_SRC, "「那一行服务的是别的空间」时必须有可见文案（⛔ 不许静默 null ✗）").toContain(
      'data-testid="nearby-other-space"',
    );
    expect(SYNC_PANEL_SRC, "没接「信任这台设备」那条命令（owner 拍的甲：一端点就通）").toContain(
      MESH_TRUST_BEGIN_COMMAND,
    );
    // ⭐⛔ 老路一个字不许动：`device_pair_advanced`（严格模式那一折）与里面的 `device_pair` 都要在 ✓
    expect(SYNC_PANEL_SRC, "把「严格模式（高级）」那一折弄坏了 ✗").toContain('data-testid="device-pair-advanced"');
    expect(SYNC_PANEL_SRC, "严格模式里那套机制被删了 ✗").toContain('data-testid="device-pair"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ 第 4 组（修 B 的判据）：**真挂 `SyncPanel` ＋ 真点那一行** ✓
//
// ⚠️ 这就是"owner 现场"那一格：`lanStatus.nearby` 有一台、`serves_current` 真/假各一次 ✓。
// ⛔ 桩里**不出现任何**"编出来的读数"：`spaceId` 取 `useSpaceStore.activeId`（真读数 ✓），
//    `peerDeviceId`／`peerPubkey` 取那一台的公告（真读数 ✓）。
// ═══════════════════════════════════════════════════════════════════════════════

const PEER_PUBKEY = "ab".repeat(32);

function peer(servesCurrent: boolean, over: Partial<NearbyPeer> = {}): NearbyPeer {
  return {
    device_id: "dev-amd",
    device_name: "ZHAI-AMD",
    short_id: "2QS2T",
    addr: "172.16.174.9:8788",
    spaces: servesCurrent ? ["ws-1"] : ["other-space"],
    serves_current: servesCurrent,
    invitable: true,
    pubkey: PEER_PUBKEY,
    ...over,
  } as NearbyPeer;
}

/** 打开面板（`usePopover` 起始是关的 ⇒ 点它自己那颗触发器 `.btn-sync` ✓）并等 `lan_status` 那条 effect 落地 ✓。 */
async function openPanelWith(nearby: NearbyPeer[]): Promise<HTMLElement> {
  lanStatusSpy.mockResolvedValue({
    enabled: true,
    peers: nearby.length,
    kind: "lan",
    line: "同步地址：直连（局域网） ｜ 本网段发现 1 台",
    mesh: { enabled: true, bind: "0.0.0.0:8788", tokenSet: true, window: "172.16.174.0/24", note: "" },
    nearby,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<SyncPanel />));
  const trigger = host.querySelector<HTMLButtonElement>(".btn-sync");
  if (!trigger) throw new Error("夹具失败：面板没渲染出触发器（`.btn-sync`）—— 不是判据红");
  flushSync(() => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  // ⚠️ `lan_status` 是 async ⇒ 让微任务跑完（本仓无 @testing-library ⇒ 不用 act ✓）。
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    flushSync(() => {});
  }
  return host;
}

describe("修 B：那一行**自己**就是「允许」的入口（owner 现场）", () => {
  beforeEach(() => {
    // ⚠️ 夹具前提：**「附近设备」那一块只在设备直连开着时才出现** ✗（`lanDirectOn` ✓ =
    //    `lanStatus.mesh.enabled && syncMode !== "off"` ✓）⇒ 把自动同步这一格设成非 0，
    //    否则 `syncModeOf(0, false)` ⇒ `"off"` ⇒ **整块不渲染**（那会是一条**夹具假红** ✓，实测踩到 ✓）。
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
  });

  it("4) ⭐ `serves_current = true` ⇒ 那一行有一颗可点的「接入」，点它 ⇒ 真的调 `mesh_trust_begin`（新契约）", async () => {
    const el = await openPanelWith([peer(true)]);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="nearby-allow"]');
    expect(
      btn,
      "⭐ 那一行必须自己给一颗「允许」按钮（修 B）—— 今天【红】：它渲染的是 null，" +
        "而唯一能触发 `trustDevice` 的按钮在四格读数读不到时**不渲染** ✗",
    ).toBeTruthy();
    expect(btn!.disabled, "⛔ 不许因为『没勾选』就禁用（修 B 就是去掉勾选流程 ✓）").toBe(false);

    flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      flushSync(() => {});
    }
    expect(
      invokeSpy.mock.calls.some((c) => c[0] === MESH_TRUST_BEGIN_COMMAND),
      "点它必须真的调 `mesh_trust_begin` —— ⛔ 只 `setDpPeer`（老行为）不算 ✓",
    ).toBe(true);
    const [, args] = invokeSpy.mock.calls.find((c) => c[0] === MESH_TRUST_BEGIN_COMMAND)!;
    expect(args, "spaceId 取**真读数**（活动空间 ✓）；对面那两格取公告 ✓").toEqual({
      spaceId: "ws-1",
      peerDeviceId: "dev-amd",
      peerPubkey: PEER_PUBKEY,
    });
  });

  it("5) ⭐ `serves_current = false`（owner 截图那一行）⇒ **必须有可见文案**（⛔ 不许静默 null）", async () => {
    const el = await openPanelWith([peer(false)]);
    const note = el.querySelector<HTMLElement>('[data-testid="nearby-other-space"]');
    expect(
      note,
      "⛔ `SyncPanel.tsx:2080` 那种静默 `null` 正是『点不了』的直接原因 ⇒ 必须如实说明它服务的是别的空间 ✓",
    ).toBeTruthy();
    expect(note!.textContent ?? "", "文案要说得出来『别的空间』✓").toContain("别的空间");
    expect(
      el.querySelector('[data-testid="nearby-allow"]'),
      "它服务的是别的空间 ⇒ ⛔ 不给「允许」按钮（那会对错的空间动手 ✓）",
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-B（2026-10-13）**：「缺暗号 ／ 空间已删」**不许再长得像"对端没服务我"** ✗
//
// 依据：`_tmp/scratch/personal-space-device-level-scope-20261013.md` §①8、§②、§④P-B ✓。
// ⚠️ 报告已写明：唯一那条"**必然 false**"的真红**已被 `c86a4843` 吃掉** ✓ ⇒ ⭐ 本片这两条
//    **今天红**、因为"原因读数"**今天还不存在** ✗（面板只会念 `hub_spaces` 原文 ⇒ 一律
//    显示成「服务 另外 N 个空间」✗）⇒ ⭐ 这两条是**修**（先红后绿 ✓），不是"新写即绿"的锁 ✓。
// ⛔ 并且**同时锁住**：⭐ 暗号**值**一个字符都不许出现在界面文本里 ✓（`INV-UI-copy-no-internal-ids` ✓）。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-B：那一条「原因」不许长得像『对端没服务我』", () => {
  it("6) ⭐ 本机**没设暗号** ⇒ 那一行必须明说「暗号」（⛔ 不是「服务 另外 N 个空间」）", async () => {
    const SECRET = "ROOM-SECRET-VALUE-MUST-NEVER-RENDER";
    const el = await openPanelWith([
      peer(false, { serves_reason: "no_secret", spaces: [SECRET] } as Partial<NearbyPeer>),
    ]);
    const row = el.querySelector<HTMLElement>(".sync-nearby-row");
    expect(row, "夹具前提：那一行要渲染出来").toBeTruthy();
    const text = row!.textContent ?? "";
    expect(
      text,
      "⭐ 缺暗号时必须出现「暗号」字样（今天【红】：面板还不知道这一格 ⇒ 只念 hub_spaces 原文 ✓）",
    ).toContain("暗号");
    expect(
      text,
      "⛔ 暗号**值**不许出现在界面文本里（那是内部标识 ⇒ `INV-UI-copy-no-internal-ids` ✓）",
    ).not.toContain(SECRET);
  });

  it("7) ⭐ 对端服务的空间**在本机已删** ⇒ 那一行必须明说「已删」（⛔ 不是「没服务我」）", async () => {
    const el = await openPanelWith([peer(false, { serves_reason: "space_deleted" } as Partial<NearbyPeer>)]);
    const row = el.querySelector<HTMLElement>(".sync-nearby-row");
    expect(row, "夹具前提：那一行要渲染出来").toBeTruthy();
    expect(
      row!.textContent ?? "",
      "⭐ 已删空间必须说出来（今天【红】）—— ⛔ 不许让它长得像『对端没服务我』✗",
    ).toContain("已删");
  });
});
