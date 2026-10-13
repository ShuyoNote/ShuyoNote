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
const { invokeSpy, lanStatusSpy, meshSetConfigSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  return { invokeSpy: vi.fn(), lanStatusSpy: vi.fn(), meshSetConfigSpy: vi.fn() };
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
      // ⭐ **P-2b（2026-10-13）**：`duList`（"本机认过哪几台"✓）就是从这条命令的 `paired` 拿的
      //   （`SyncPanel.tsx:291-292` ✓）⇒ 分段判据要能**给这条桩喂名单** ✓（⛔ 不改它默认的 `null` ✗
      //   —— 其余用例照旧落到"读不到 ⇒ 空名单" ✓）。
      meshSetConfig: (...a: unknown[]) => meshSetConfigSpy(...a),
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

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-2a-1（2026-10-13）**：⭐ **同一份内容**要能渲染进**内容区** ✗（今天只有抽屉那一条路 ✓）。
//   ⭐ 做法＝`SyncPanel` 加 `contentOnly?: boolean` ⇒ **同一份 JSX 两处复用** ✓（⛔ 一行 JSX 都不搬 ✗）。
// ⚠️ **判据①今天红**：`contentOnly` 还不存在 ⇒ 渲染出来的是**触发器**（`.btn-sync` **在** ✓）
//    而**内容体**（「立即同步」`SyncPanel.tsx:1419` ✓）**不在** ✗。
// ⚠️ **判据②今天红**（⭐ owner 点名的**不变量** ✗）：`「立即同步」`（`:1419` ✓）与路线那坨
//    `.sync-att-text`（`:1494` ✓）⭐ **必须同在一个容器内、且前者在前** ✓ —— 今天内容体压根不渲染 ⇒ 红 ✓。
// ⭐ 锁（今天应绿 ⇒ 如实标"锁，不是本片的修"✗）：⭐ 抽屉那支**仍可用** ✓（点 `.btn-sync` 仍开浮层 ✓）／
//    ⛔ 界面**没有**「口令」格 ✓。
// ═══════════════════════════════════════════════════════════════════════════════

/** ⚠️ 今天 `contentOnly` **还不存在** ⇒ 用 cast 传（⛔ 不假装契约已在 ✗）；改后同一行就是**真契约** ✓。 */
async function renderPanelWithContentOnly(): Promise<HTMLElement> {
  lanStatusSpy.mockResolvedValue({
    enabled: true,
    peers: 1,
    kind: "lan",
    line: "同步地址：直连（局域网） ｜ 本网段发现 1 台",
    mesh: { enabled: true, bind: "0.0.0.0:8788", tokenSet: true, window: "172.16.174.0/24", note: "" },
    nearby: [],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const props = { contentOnly: true } as unknown as Record<string, never>;
  flushSync(() => root!.render(<SyncPanel {...props} />));
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    flushSync(() => {});
  }
  return host;
}

describe("P-2a-1：同一份内容要能进内容区（`contentOnly`）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
  });

  it("① ⭐ `contentOnly` ⇒ ⛔ 不许渲染触发器（`.btn-sync` ✗）＋ ⭐ 内容体必须在（今天【红】）", async () => {
    const el = await renderPanelWithContentOnly();
    expect(
      el.querySelector(".btn-sync"),
      "⛔ 内容区那支**不该**再带一颗抽屉触发器（那是抽屉那支的事 ✓）—— 今天【红】：触发器就在 ✓",
    ).toBeNull();
    expect(
      el.textContent ?? "",
      "⭐ 内容体必须**真的**渲染出来（「立即同步」在 `SyncPanel.tsx:1419` ✓）—— 今天【红】：压根不渲染 ✗",
    ).toContain("立即同步");
  });

  it("② ⭐ 不变量：「立即同步」与路线那坨**同在一个容器内、且它在前面**（今天【红】）", async () => {
    const el = await renderPanelWithContentOnly();
    const pop = el.querySelector<HTMLElement>(".sync-popover");
    const route = el.querySelector<HTMLElement>(".sync-att-text");
    const syncNow = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes("立即同步"),
    );
    expect(
      pop && route && syncNow,
      "⭐ 三者都要在（容器 `.sync-popover` ✓／路线 `.sync-att-text` `:1494` ✓／「立即同步」`:1419` ✓）—— 今天【红】",
    ).toBeTruthy();
    expect(pop!.contains(route!) && pop!.contains(syncNow!), "⭐ 二者必须在**同一个容器**内 ✓").toBe(true);
    expect(
      syncNow!.compareDocumentPosition(route!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "⭐ 「立即同步」必须在**路线那坨之前** ✓（顺序变了就是我们弄坏的 ✗）",
    ).toBeTruthy();
  });

  it("③ 锁（今天已绿 ✓）：抽屉那支**仍可用** ⇒ 点 `.btn-sync` 仍然开浮层", async () => {
    const el = await openPanelWith([]);
    expect(el.querySelector(".btn-sync"), "⭐ 抽屉那支的触发器不许被弄没 ✗").toBeTruthy();
    expect(el.querySelector(".sync-popover"), "⭐ 点它之后浮层要出来 ✓").toBeTruthy();
  });

  it("④ 锁（今天已绿 ✓）：⛔ 界面**没有**「口令」格", async () => {
    const el = await renderPanelWithContentOnly();
    const phs = [...el.querySelectorAll("input")].map((i) => i.getAttribute("placeholder") ?? "");
    expect(
      phs.some((p) => p.includes("口令")),
      `⛔ 面板上不许再有「口令」输入格 ✗（owner 2026-10-13 拍了去掉 ✓）：实测 ${JSON.stringify(phs)}`,
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-2b（2026-10-13，owner 拍「按这个执行」✓）**：「附近的设备」那一列按
//   ⭐ **本机认没认过** 分成**两段**（`已信任` ／ `待配对` ✓）——
//   判据取**本机认过的那份名单** `duList`（⭐ 与下面「解除」那块**同一份读数** ✓
//   ＝ `api.meshSetConfig(activeId, null, null)` 的 `paired` ✓ `SyncPanel.tsx:291-292` ✓，⛔ 不新造读数 ✗）。
//
// ⚠️ ⭐ **第三段「需要重新配对（钥匙变了）」不在本片** ✗：那条**逐台**读数今天**不存在**（R7 ✓）
//   ⇒ ⭐ 先造读数、再画段 ✓（归 **P-3** ✓）—— ⛔ 也不许为了凑三段去造数 ✗。
//
// ⚠️ **本组三条都是"先红后绿"** ✗（⛔ 没有一条是"新写即绿"的锁 ✗）：
//   ① 两段标题今天**都没有** ✓；② 今天**没有段可分** ✓；③ 那句「待 P-3」的注释**随本片一起进** ✓
//   （⚠️ 实测：把本片的 `SyncPanel.tsx` 暂时退回 ⇒ **三条一起红** ✓ ⇒ ⛔ 别把 ③ 标成"锁" ✗）。
//   ⭐ 本片**不带**独立的锁 —— 相邻那几条锁（抽屉仍可用／没有「口令」格）在上一组里已经钉着 ✓。
// ═══════════════════════════════════════════════════════════════════════════════

const TRUSTED_ID = "dev-amd";
const PENDING_ID = "dev-other";

/** 那一行**归属哪一段**：往上找最近的段标题（`Fragment` 不产生 DOM 节点 ⇒ 二者是兄弟 ✓）。 */
function groupBefore(row: Element): string | null {
  let n: Element | null = row.previousElementSibling;
  while (n) {
    const id = n.getAttribute("data-testid") ?? "";
    if (id.startsWith("nearby-group-")) return id;
    n = n.previousElementSibling;
  }
  return null;
}

/** 行名（`.sync-nearby-name` ✓）→ 那一行元素。 */
function rowByName(el: HTMLElement, name: string): Element | null {
  return (
    [...el.querySelectorAll(".sync-nearby-row")].find(
      (r) => (r.querySelector(".sync-nearby-name")?.textContent ?? "").trim() === name,
    ) ?? null
  );
}

describe("P-2b：附近的设备分两段（已信任／待配对）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    // ⭐ 本组的桩：`duList` 里有**一台**（`dev-amd` ✓）⇒ 它进「已信任」✓，另一台落「待配对」✓。
    meshSetConfigSpy.mockReset();
    meshSetConfigSpy.mockResolvedValue({ paired: [{ deviceId: TRUSTED_ID, addedAtMs: 1 }] });
  });
  afterEach(() => {
    meshSetConfigSpy.mockReset();
  });

  it("① ⭐ 两段标题都在（今天【红】：一段都没有 ✓）", async () => {
    const el = await openPanelWith([
      peer(true),
      peer(false, { device_id: PENDING_ID, device_name: "ZHAI-MAC" } as Partial<NearbyPeer>),
    ]);
    expect(
      el.querySelector('[data-testid="nearby-group-trusted"]'),
      "⭐ 「已信任」那一段的标题要在 ✓（判据 ＝ `duList` ✓，⛔ 不是服务不服务我 ✗）",
    ).toBeTruthy();
    expect(
      el.querySelector('[data-testid="nearby-group-pending"]'),
      "⭐ 「待配对」那一段的标题要在 ✓（今天【红】：列表还是**一整片**、没有任何分段 ✗）",
    ).toBeTruthy();
  });

  it("② ⭐ 认过的那台落在「已信任」、没认过的落在「待配对」（今天【红】：没有段可分 ✓）", async () => {
    const el = await openPanelWith([
      peer(true),
      peer(false, { device_id: PENDING_ID, device_name: "ZHAI-MAC" } as Partial<NearbyPeer>),
    ]);
    const trustedRow = rowByName(el, "ZHAI-AMD");
    const pendingRow = rowByName(el, "ZHAI-MAC");
    expect(trustedRow, "夹具前提：认过的那一行要渲染出来").toBeTruthy();
    expect(pendingRow, "夹具前提：没认过的那一行也要渲染出来").toBeTruthy();
    expect(
      groupBefore(trustedRow!),
      "⭐ 在 `duList` 里的那一台 ⇒ 必须落在「已信任」那一段 ✓（判据是**本机认过** ✓，⛔ 不是 `serves_current` ✗）",
    ).toBe("nearby-group-trusted");
    expect(
      groupBefore(pendingRow!),
      "⭐ 不在 `duList` 里的那一台 ⇒ 必须落在「待配对」那一段 ✓",
    ).toBe("nearby-group-pending");
    // ⭐ 段的**先后**也要对：已信任在前 ✓（排序键就是"认没认过" ✓）。
    const rows = [...el.querySelectorAll(".sync-nearby-row")];
    expect(
      rows.indexOf(trustedRow!),
      "⭐ 已信任那一段要排在待配对之前 ✓",
    ).toBeLessThan(rows.indexOf(pendingRow!));
  });

  it("③（**本片的一部分**，⛔ 不是锁 ✗，先红后绿同 ①②）：源码里留着「第三段待 P-3」那句话", () => {
    expect(
      SYNC_PANEL_SRC,
      "⛔ 别把「第三段（钥匙变了）待 P-3」这句话删掉 ✗ —— 它是**如实交代缺一段**的那条注释 ✓" +
        "（那条逐台读数今天不存在 ✓，⭐ 先造读数再画段 ✓）",
    ).toContain("待 P-3");
  });
});
