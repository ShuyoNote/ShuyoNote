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
const { invokeSpy, lanStatusSpy, meshSetConfigSpy, secOverviewSpy, pairingCodeReadingSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  // ⭐ **P-3e-1**：⭐ 那颗"未加密空间"读数（`spaceSecurityOverview` ✓）走**本文件的 spy** ✓ ——
  //   ⚠️⭐ **默认仍是 `[]`** ✗（省了它 ⇒ 回 `undefined` ⇒ `refresh()` 里 `new Map(...)` 当场抛 ✗
  //      ⇒ 既有那几组**变假红** ✓ —— 今晚踩过同形的坑 ✓）。
  return {
    invokeSpy: vi.fn(),
    lanStatusSpy: vi.fn(),
    meshSetConfigSpy: vi.fn(),
    secOverviewSpy: vi.fn().mockResolvedValue([]),
    // ⭐ P-4 片③：命令那一层要能**数次数 ＋ 断言实参** ✓
    pairingCodeReadingSpy: vi.fn(),
  };
});

/** ⚠️ `api` 除下面两条外一律"空读数"（面板那些分支只读、不崩 ✓）—— 本判据只问**那一行的可达性** ✓。
 *  ⚠️⭐ 这两条**必须给数组** ✗：`refresh()` 里 `new Map(profiles.map(…))`（`SyncPanel.tsx:541` ✓）拿到
 *  `null` 会当场抛 ⇒ `setRows` 跑不到 ⇒ `activeRow` 空 ⇒ ⭐ 连**「附近设备」那一整块**（它被
 *  `:1962` 的 `!!activeRow` 挡着 ✓）都不渲染 ⇒ 那是一条**夹具假红**（实测踩到一次 ✓）。 */
// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-3e-1（2026-10-13，R9 的最小片）**：⭐ 未加密空间的**主动提醒** ✗ ——
//   ⭐ 读数＝既有那条 `spaceSecurityOverview()` ✓ 的 `encrypted_on_disk`（`space_crypto.rs:475-484` ✓）；
//   ⭐ N ＝ `rows.filter((r) => !r.encrypted_on_disk).length` ✓（⛔ 不用 `in_keyring`／`key_available` ✗）。
// ⚠️ **判据①今天红**（⭐ 先加断言、先跑 ✓）：还没有那行提醒 ✓。
// ⛔ 本片**没做**：`[]`／reject 那两条锁 ✗、「去开加密」那颗按钮 ✗（留下一片 ✓，见收口 ✓）。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-3e-1：未加密空间 ⇒ 主动提醒（只说个数）", () => {
  afterEach(() => {
    // ⭐ 本用例把默认值改过 ⇒ **复位** ✓（⛔ 不许把可变状态留给别的组 ✗）。
    secOverviewSpy.mockResolvedValue([]);
  });

  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
  });

  it("① ⭐ 留 1 个 `encrypted_on_disk: false` ⇒ 那行提醒必须在（今天【红】）", async () => {
    const rows = [
      {
        space_id: "ws-2",
        kind: "personal",
        encrypted_on_disk: false,
        in_keyring: false,
        key_available: false,
        gate: {},
      },
    ];
    // ⚠️⭐ **默认值也要给同一份** ✗：`refresh()` 会跑**不止一次**（打开一次、事件一次 ✓）
    //   ⇒ 只给 `Once` 的话第二次就回默认 `[]` ⇒ N=0 ⇒ **假红**（实测踩到 ✓）。
    secOverviewSpy.mockResolvedValue(rows);
    secOverviewSpy.mockResolvedValueOnce(rows);
    const el = await openPanelWith([]);
    const warn = el.querySelector<HTMLElement>('[data-testid="plaintext-warning"]');
    expect(
      warn,
      "⭐ 真有 1 个未加密空间 ⇒ 必须在同步页顶部提醒 ✓（今天【红】：还没有那行 ✓）",
    ).toBeTruthy();
    expect(warn!.textContent ?? "", "⭐ 提示要说清「没开加密 ⇒ 明文传输」✓").toContain("明文");
    expect(warn!.textContent ?? "", "⭐ 只报**个数** ✓（⛔ 不摆空间名 ✗）").toContain("1");
  });

  it("② 锁（今天已绿 ✓，⭐ 不是本片的修 ✗）：`[]` ⇒ ⛔ 那行提醒**不出现**", async () => {
    secOverviewSpy.mockResolvedValue([]);
    const el = await openPanelWith([]);
    expect(
      el.querySelector('[data-testid="plaintext-warning"]'),
      "⛔ 一个未加密的空间都没有 ⇒ 不许出现那行提醒 ✓（N=0 ≠ 危险 ✗）",
    ).toBeNull();
  });

  it("③ 锁（今天已绿 ✓，⭐ 不是本片的修 ✗）：**读不到**（reject）⇒ ⛔ 不出现（读不到 ≠ 0 ✗）", async () => {
    secOverviewSpy.mockRejectedValue(new Error("读不到"));
    const el = await openPanelWith([]);
    expect(
      el.querySelector('[data-testid="plaintext-warning"]'),
      "⛔ 读不到 ⇒ **不许**出现 ✓（⛔ 更不许拿 0 冒充「你很安全」✗）",
    ).toBeNull();
  });

  it("④ ⭐ 提醒里要有「去开加密」（今天【红】：还没那颗按钮）", async () => {
    const rows = [
      {
        space_id: "ws-2",
        kind: "personal",
        encrypted_on_disk: false,
        in_keyring: false,
        key_available: false,
        gate: {},
      },
    ];
    // ⚠️⭐ 同上：默认值也要给同一份 ✓（`refresh()` 会跑不止一次 ⇒ 只给 `Once` 会假红 ✓）。
    secOverviewSpy.mockResolvedValue(rows);
    const el = await openPanelWith([]);
    const btn = el.querySelector<HTMLElement>('[data-testid="plaintext-go-encrypt"]');
    expect(btn, "⭐ 那行提醒里要有一颗「去开加密」✓（今天【红】）").toBeTruthy();
    expect(btn!.textContent ?? "", "⭐ 按钮文案逐字 ✓").toContain("去开加密");
  });
});

vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      lanStatus: (id: string) => lanStatusSpy(id),
      listSyncProfiles: async () => [],
      spaceSecurityOverview: () => secOverviewSpy(),
      // ⭐ **P-2b（2026-10-13）**：`duList`（"本机认过哪几台"✓）就是从这条命令的 `paired` 拿的
      //   （`SyncPanel.tsx:291-292` ✓）⇒ 分段判据要能**给这条桩喂名单** ✓（⛔ 不改它默认的 `null` ✗
      //   —— 其余用例照旧落到"读不到 ⇒ 空名单" ✓）。
      meshSetConfig: (...a: unknown[]) => meshSetConfigSpy(...a),
      // ⭐ P-4 片③：屏上那份 `pairCode` 走的就是这一条 ✓（⭐ 两个实参 ⇒ 判据能断言它带了哪一台 ✓）
      pairingCodeReading: (a: { peerDeviceId: string; peerPubkey: string }) => pairingCodeReadingSpy(a),
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
async function openPanelWith(
  nearby: NearbyPeer[],
  // ⭐ **P-4 片②a** 起多收一个可选的 `pairCode`（⭐ 那一屏要显示的比对码 ✓）—— ⚠️ 不传 ⇒
  // `SyncPanel` 的**默认**占位（如实「读不到」✓）⇒ ⭐ 既有调用点一个字不动 ✓。
  props: { pairCode?: { kind: "ok"; value: string | null } | { kind: "unavailable"; reason: string } } = {},
): Promise<HTMLElement> {
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
  flushSync(() => root!.render(<SyncPanel {...props} />));
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

  it("4) ⭐ `serves_current = true` ⇒ 那一行有一颗可点的「接入」；⭐ 点它 ＋ 点「确认」⇒ 真的调 `mesh_trust_begin`（新契约）", async () => {
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
    // ⭐ **P-4 片②b（2026-10-13）**：⭐ 这一下**不再**直接调它了 ✗ —— ⭐ 时点挪到「码对得上，确认」之后 ✓
    //   （⭐ 断言**一条没删** ✓ —— 按本仓 R192「换对象不删断言」：只是把"点它"换成"点它 ⇒ 再点确认" ✓，
    //    下面参数那一格照旧逐字 ✓）。
    const confirm = el.querySelector<HTMLElement>('[data-testid="pair-confirm"]');
    expect(
      confirm,
      "⭐ 点「接入」之后那一屏要开（P-4 片②a ✓）⇒ 「码对得上，确认」那颗要在 ✓",
    ).toBeTruthy();
    flushSync(() => confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      flushSync(() => {});
    }
    expect(
      invokeSpy.mock.calls.some((c) => c[0] === MESH_TRUST_BEGIN_COMMAND),
      "点「接入」＋「确认」之后必须真的调 `mesh_trust_begin` —— ⛔ 只 `setDpPeer`（老行为）不算 ✓" +
        "（⭐ 时点归 P-4 片②b ✓）",
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

  it("③ 换对象不删断言（R192 ✓，P-3d 2026-10-13）：那句注释从「待 P-3」改成「已落地」＋ 读不到不算变了", () => {
    // ⚠️ 这一格原来钉的是 `待 P-3`（＝"第三段还没造出来" ✓）—— ⭐ P-3d 把第三段画出来之后
    //    那句话**必须改**（留着就是**过时的读数** ✗）⇒ ⭐ 按本仓 R192「换对象不删断言」✗：
    //    断言一个字不删 ✓，只把**对象**换成新事实 ✓。
    expect(
      SYNC_PANEL_SRC,
      "⭐ 注释必须明说第三段**已落地** ✓（⛔ 别还留着「待 P-3」说它不存在 ✗）",
    ).toContain("第三段已落地");
    expect(
      SYNC_PANEL_SRC,
      "⭐ 同时必须写清口径来源：判据是 P-3a 供的逐台读数 `key_changed` ✓",
    ).toContain("key_changed");
    expect(
      SYNC_PANEL_SRC,
      "⭐ 且必须写明「**读不到（`null`）不算变了**」✓ —— 那是本片最容易松掉的一条口径 ✓",
    ).toContain("读不到（`null`）不算变了");
    expect(
      SYNC_PANEL_SRC,
      "⛔ 过时的那句「待 P-3」不许再留在这一块里 ✗（它已经被兑现了 ✓）",
    ).not.toContain("第三段「需要重新配对（钥匙变了）」待 P-3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-3d（2026-10-13）**：画第三段 ⭐「**需要重新配对**」✗ —— 判据取的是
//   ⭐ **逐台读数** `key_changed`（P-3a 供的 ✓ `commands.ts` 的 `NearbyPeer` ✓）。
//
// ⚠️⭐ **口径不能松** ✗：⭐ 只有 `key_changed === true` 才进第三段 ✓ ——
//   ⭐ **读不到（`null`）** 与 **`false`（没变）** 一律**不进** ✗
//   （「读不到」是**没有结论** ✓，⛔ 不许被当「变了」✗ —— 与那几格读数同一把尺 ✓）。
//
// ⭐ 段序（`SyncPanel.tsx` 里那个 bucket ✓）：需要重新配对 ⇒ 已信任 ⇒ 待配对 ✓。
//
// ⚠️ **本组只有 ① 是先红后绿** ✓；**② ③ 是锁**（今天已绿 ✓，⛔ 不是本片的修 ✗）——
//   实测：② 是一条**反向断言**（`null` ⇒ 不许出第三段 ✓），第三段还没造出来时它**天生成绿** ✓
//   ⇒ ⛔ 不许硬凑成"今天红"✗；③ 钉的是 P-2b 那两段仍在 ✓（用 `nearby-group-pending` ✓ ——
//   ⚠️⛔ **不许拿「已信任」当锁** ✗：那要求该行在 `duList` 里 ✓，而夹具的 `duList` 是**空的** ✓
//   ⇒ `peer(true)` **不会**出「已信任」标题 ✓（前一位就这么错过 ✗）。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-3d：第三段「需要重新配对」（key_changed === true）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    // ⚠️ 本组**刻意**不动 `meshSetConfigSpy` ⇒ `duList` 保持**空** ✓（本组不需要"已信任"那一段 ✓）。
    meshSetConfigSpy.mockReset();
  });

  it("① ⭐ 一台 `key_changed: true` ⇒ 第三段标题「需要重新配对」必须出现（今天【红】：一段都没有 ✓）", async () => {
    const el = await openPanelWith([
      // ⚠️ 用 `peer(true, …)`＝**它服务的正是当前空间** ✓ —— 那才是"要重新配对"的现实场景 ✓
      //   （`key_changed: true` **优先**于 `duList` ⇒ 这一段排在「已信任」之前 ✓）。
      //   ⚠️⭐ 它**不服务当前空间**时不给这颗按钮 ✓（会动错空间 ✗）⇒ 那时落回「别的空间」那句 ✓。
      peer(true, { key_changed: true, key_reason: "ok" } as Partial<NearbyPeer>),
    ]);
    const head = el.querySelector<HTMLElement>('[data-testid="nearby-group-keychanged"]');
    expect(
      head,
      "⭐ 逐台读数说「钥匙变了」⇒ 界面必须**单独成段**说出来 ✓（今天【红】：只有「已信任／待配对」两段 ✗）",
    ).toBeTruthy();
    expect(head!.textContent ?? "", "⭐ 那一段的文案逐字是「需要重新配对」✓").toContain("需要重新配对");
    expect(
      el.querySelector('[data-testid="nearby-repair"]'),
      "⭐ 那一段的行里要有那颗「重新配对」✓（⛔ 不是「立即同步」✗、也⛔ 不是「解除」✗）",
    ).toBeTruthy();
    expect(
      (el.querySelector('[data-testid="nearby-repair"]') as HTMLElement).textContent ?? "",
      "⭐ 那颗按钮的文案逐字是「重新配对」✓",
    ).toContain("重新配对");
  });

  it("② 锁（今天已绿 ✓，⭐ 不是本片的修）：⭐ 读不到（`null`）**不许**进第三段", async () => {
    const el = await openPanelWith([
      peer(false, { key_changed: null, key_reason: "no_record" } as Partial<NearbyPeer>),
    ]);
    expect(
      el.querySelector('[data-testid="nearby-group-keychanged"]'),
      "⛔ `null` ＝ **读不到**（**没有结论** ✓）⇒ ⛔ **不许**被当成「变了」而进第三段 ✗" +
        "（那正是这条口径要挡的假结论 ✓；⭐ 第三段只收 `key_changed === true` ✓）",
    ).toBeNull();
  });

  it("③ 锁（今天已绿 ✓）：P-2b 那两段仍在 —— ⭐ 没进第三段的那些落在「待配对」✓", async () => {
    const el = await openPanelWith([
      peer(false, { key_changed: false, key_reason: "ok" } as Partial<NearbyPeer>),
    ]);
    expect(
      el.querySelector('[data-testid="nearby-group-pending"]'),
      "⭐ `key_changed: false`（＝**没变** ✓）⇒ 照旧走 P-2b 的「待配对」那一段 ✓",
    ).toBeTruthy();
    expect(
      el.querySelector('[data-testid="nearby-group-keychanged"]'),
      "⛔ `false`（没变）**不许**进第三段 ✗",
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-2c（2026-10-13，R10）**：⭐ 补那句**实话** ✗ ＋ ⭐ 纠正那句**错的**注释 ✓
//
// ⭐ 真相（今晚实测 ✓）：⭐ 那段载荷／文本**不是一次性的** ✗ —— 载荷里**没有** nonce／时间戳／有效期 ✓，
//    采纳侧也**幂等**（可以再次采纳 ✓）⇒ ⚠️ 界面那句「比对码（一次性）」说的是**那串短码的显示** ✓，
//    ⛔ 不是"文本用完就失效" ✗（两者在界面上**长得像** ✗ ⇒ 必须明说 ✓）。
// ⚠️ **判据①今天红**：面板文本里**没有**那句「不是一次的」✓；且源码里那句错注释
//    「显示比对码（**一次性**」✓ 还在 ⇒ 红 ✓。
// ⭐ **判据②是锁**（今天已绿 ⇒ ⭐ 如实标"锁，不是本片的修"✗）：⛔ 不许写「60 秒失效」（现状做不到 ✗）／
//    ⛔ 不许把**载荷／文本**说成一次性的 ✗。
// ⛔ 本组**只往文件末尾追加** ✓（⛔ 不改别人的组 ✗）。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-2c：那段文本不是一次性的（说实话 ＋ 改错注释）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
  });

  it("① ⭐ 说实话那句 ＋ 改掉错注释（今天【红】；⚠️ **源码级**，见下）", async () => {
    // ⚠️⭐ **如实说明**：本该是**DOM 级**（"界面文本含"）✗ —— 但这一块的渲染被 `activeRow` 挡着，
    //   而本文件那份**共享** `api` 桩把 `listSyncProfiles` 定为 `[]` ✗ ⇒ 那条**设备配对**那一块
    //   压根不渲染（实测 ✓：渲染出的文本里没有「要点」那一句 ✓）。
    //   ⛔ 改那个共享桩会**动到别的组**（P-B／P-2a／P-2b 都吃它 ✓）⇒ 本片按仓内既有的
    //   **源码级接线判据**同形来判 ✓（`syncPanelMesh.wiring.test.ts` 就是这一形态 ✓）；
    //   ⭐ **DOM 级那一条留给下一片**（把夹具补成"有一条 profile"再说 ✓）。
    const src = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
    expect(
      src,
      "⭐ 必须有一句用户看得见的实话：这段文本／这串码**不是一次性的** ✓（今天【红】：没有 ✓）",
    ).toContain("不是一次性的");
    expect(
      src,
      "⛔ 那句错注释「显示比对码（**一次性**」必须改掉 ✗ —— 载荷里没有 nonce／有效期 ✓（今晚实测 ✓）",
    ).not.toContain("显示比对码（**一次性**");
  });

  it("② 锁（今天已绿 ✓）：⛔ 不许写「60 秒失效」✗、⛔ 不许把载荷／文本说成一次性的 ✗", async () => {
    const el = await openPanelWith([]);
    const text = el.textContent ?? "";
    expect(text, "⛔ 现状做不到 60 秒失效 ⇒ 界面上不许这么写 ✗").not.toContain("60 秒失效");
    expect(text, "⛔ 载荷不是一次性的 ⇒ 不许把文本说成一次性 ✗").not.toContain("文本是一次性的");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **P-3c（2026-10-13，R8）**：⭐ 「解除」那颗按钮必须**先问一句** ✗ —— ⛔ 未确认 ⇒ **一个字节都不发** ✗。
//
// ⚠️⭐ **如实交代判据形态**：本组是**源码级**（⛔ 不是 DOM 级 ✗）。原因（实测 ✓）：
//   要"真点那颗「解除」"就得让那一块过 `activeRow` ✓，而本文件那份**共享** `api` 桩把
//   `listSyncProfiles` 定成 `[]` ✓ ⇒ 那一整块不渲染 ✓；换成"本组自带夹具"（Lead 拍的 (iii)）
//   要么动共享桩（会波及 P-B／P-2a／P-2b ✗），要么 `vi.resetModules` ＋ `vi.doMock` ＋ 动态 import
//   **整个 `SyncPanel` 依赖图** —— 代价大且脆 ✗ ⇒ ⭐ 退 (ii)（Lead 已拍 ✓），并在下面**逐条**说清
//   每条判据**为什么**等价于"先确认、未确认不发"✓。⭐ DOM 级那一条留待有真夹具时 ✓。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-3c：「解除信任」先二次确认（源码级，理由见上）", () => {
  /** ⭐ 只取 `duUnpair` 的**函数体**（从它的声明到第一个 `catch (e)` ✓）—— 别把别处的代码算进来 ✓。 */
  function duUnpairBody(): string {
    const src = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
    const at = src.indexOf("const duUnpair = async");
    if (at < 0) throw new Error("夹具失败：SyncPanel.tsx 里找不到 `const duUnpair = async`");
    const end = src.indexOf("catch (e)", at);
    if (end < 0) throw new Error("夹具失败：`duUnpair` 里找不到 `catch (e)`");
    return src.slice(at, end);
  }

  it("① ⭐ 确认件要在 `api.deviceUnpair(` **之前**、且未确认就 `return`（今天【红】）", () => {
    const body = duUnpairBody();
    expect(body, "⭐ 必须调仓内那个确认件（`store/confirm` 的 `confirmDialog(` ✓）").toContain(
      "confirmDialog(",
    );
    expect(
      body,
      "⛔ 未确认 ⇒ 必须**当场 return**（＝一个字节都不发 ✓；⛔ 不许「先调再撤」✗）",
    ).toContain("if (!ok) return;");
    const confirmAt = body.indexOf("confirmDialog(");
    const callAt = body.indexOf("api.deviceUnpair(");
    expect(callAt, "夹具前提：`duUnpair` 里要真有 `api.deviceUnpair(` ✓").toBeGreaterThan(-1);
    expect(
      confirmAt,
      "⭐ 确认那一下必须在调用**之前** ✓（顺序反了就等于「先解除再问」✗）",
    ).toBeLessThan(callAt);
  });

  it("② ⭐ 确认文案必须含「解除这一台？」与「重新配对」（今天【红】）", () => {
    const body = duUnpairBody();
    expect(body, "⭐ 标题逐字用 owner 那句 ✓").toContain("解除这一台？");
    expect(
      body,
      "⭐ 必须含「**重新配对**」口径 ✓ —— 那是 owner 的承诺（解除 ≠ 永久失联 ✓）",
    ).toContain("重新配对");
  });

  it("③ 锁（今天已绿 ✓，⭐ 不是本片的修 ✗）：`api.deviceUnpair` **恰好一处** ＋ 乐观摘行仍在**成功分支**", () => {
    const body = duUnpairBody();
    expect(
      body.split("api.deviceUnpair(").length - 1,
      "⛔ 只许一处调用 ✓（确认之后**恰好一次** ✓ —— 不许两次 ✗）",
    ).toBe(1);
    const callAt = body.indexOf("api.deviceUnpair(");
    const filterAt = body.indexOf("setDuList((prev) => prev.filter(");
    expect(filterAt, "夹具前提：那条乐观摘行要在 ✓").toBeGreaterThan(-1);
    expect(
      callAt,
      "⭐ 摘行必须在**成功分支**里（＝在 api 调用**之后** ✓；⛔ 别挪到确认之前 ✗）",
    ).toBeLessThan(filterAt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐⭐ **P-4 片②a（2026-10-13）**：⭐ 「**对码**」那一屏 ✗ —— ⭐ 本片**只到"屏能开"** ✓。
//
// ⚠️ 范围（⛔ 别越界 ✗）：⭐ 本片＝**新增**一个可选 prop（`pairCode` ✓）＋ 一屏 ✓；
//   ⛔ **不改** `trustDevice` 的**调用时点** ✗（⭐ 那是**片②b** ✓）⇒ ⭐ 本片只保证「接入」那一下
//   **顺手把屏打开** ✓（`setPairScreen(true)` ✓），`setDpPeer`／`trustDevice` 逐字不动 ✓。
//
// ⚠️ ⭐ 口径（⛔ 一条都不许松 ✗）：
//   · ⭐ **分组 ＝ 5 组 × 4 位** ✓（`pairing.rs:369` 的 `format!("{n:020}")` ＋ `:371` 的 `.chunks(4)` ✓
//     ⇒ 屏上写 `XXXX-XXXX-XXXX-XXXX-XXXX` ✓，⛔ 不是 4 组 ✗）；
//   · ⭐ `kind === "ok"` 才渲染那串码 ✓；⭐ `unavailable` ⇒ **如实说为什么** ✓（⛔ 不编一个码 ✗）；
//   · ⛔ 屏上**没有**「继续／自动通过」一类入口 ✗（⭐ 仓里逐字：状态机里**没有"自动通过"这一格** ✓）；
//   · ⭐ **6 位码今天不做、且已决定不做** ✗（⭐ 它需要 PAKE ✓；`mesh.rs:825` 逐字「6 位数字…搜索空间只有 10^6」✗）⇒
//     ⭐ 屏上如实说「这是**比对码**（20 位、5 组）—— 这是**现在的做法**；6 位码需要 PAKE，**已决定不做**」✓
//     （⭐ **2026-10-13 owner 拍板** ✓ —— ⛔ 旧那句"要等 PAKE 落地"是**过期承诺** ✗，已删 ✓）。
//
// ⚠️ **本组只有 ① 与 ③ 是先红后绿** ✓（⭐ ③ 钉的那一段**是本片加的** ⇒ ⚠️ **实测它随本片一起红** ✗
//   ⇒ ⛔ 不许标成"锁" ✗ —— 如实标"本片的一部分" ✓）；⭐ **② 才是锁**（今天已绿 ✓，⛔ 不是本片的修 ✗ ——
//   ⭐ 实测：整份 `SyncPanel.tsx` 里 `自动通过` **只出现在我新加的注释里** ✓ ⇒ ⭐ 必须先**剥注释**再判 ✓，
//   而 `继续` 只出现在**严格模式那条既有文案**里 ✓ ⇒ ⭐ ② 只判「自动通过」＋ 那条停态守卫 ✓，
//   ⛔ 不许拿整份文件判「继续」✗（那会假红 ✓））。
// ═══════════════════════════════════════════════════════════════════════════════

/** 我那一屏那一段源码（⭐ 从它的 testid 起到 window 末 ✓，且**先整份剥注释再切** ✓）。
 *  ⚠️ 顺序不能反 ✗ —— ⭐ 先切再剥的话，窗口里那个**没闭合**的块注释（JSX 注释 ✓）会把
 *  它后面的**注释文本**当成 JSX 留下 ⇒ ⭐ 实测报出 `**局域网发现的读数**` 这种**假红** ✓。 */
function pairScreenCode(): string {
  const stripped = SYNC_PANEL_SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = stripped.indexOf('data-testid="pair-code-screen"');
  if (at < 0) throw new Error("SyncPanel.tsx 里找不到 `pair-code-screen`（屏还没加？）");
  return stripped.slice(at, at + 2200);
}

describe("P-4 片②a：对码那一屏（只显示、不下结论）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    meshSetConfigSpy.mockReset();
  });

  it("① ⭐ 桩给一个固定的 20 位码 ⇒ 屏上出现**那串**（5 组 × 4 位）＋ `pair-confirm`（今天【红】✓）", async () => {
    // ⭐ 20 位、按 4 位一组 ⇒ **5 组** ✓（与 `pairing.rs` 的 `format!("{n:020}")` ＋ `.chunks(4)` 同形 ✓）
    const CODE = "1234 5678 9012 3456 7890";
    const el = await openPanelWith([peer(true)], { pairCode: { kind: "ok", value: CODE } });
    expect(CODE.trim().split(/\s+/).length, "夹具前提：桩给的是 5 组 × 4 位 ✓").toBe(5);
    expect(CODE.replace(/\s/g, "").length, "夹具前提：一共 20 位 ✓").toBe(20);

    const allow = el.querySelector<HTMLButtonElement>('[data-testid="nearby-allow"]');
    expect(allow, "夹具前提：那一行的「接入」要在 ✓").toBeTruthy();
    // ⭐ 本片只保证"**屏能开**" ✓：由「接入」那一下顺手打开 ✓
    flushSync(() => allow!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      flushSync(() => {});
    }

    const screen = el.querySelector<HTMLElement>('[data-testid="pair-code-screen"]');
    expect(
      screen,
      "⭐ 「接入」那一下之后，对码那一屏必须**开** ✓（今天【红】：没有这一屏 ✗；" +
        "⚠️ 本片**不改** `trustDevice` 的时点 ✓ —— 那归片②b ✓）",
    ).toBeTruthy();
    expect(
      screen!.querySelector('[data-testid="pair-code-value"]')?.textContent ?? "",
      "⭐ 屏上必须**逐字**显示那串码 ✓（⛔ 不是编一个／也不是空白 ✗）",
    ).toContain(CODE);
    expect(
      screen!.querySelector('[data-testid="pair-confirm"]'),
      "⭐ 「码对得上，确认」那颗按钮必须在 ✓",
    ).toBeTruthy();
    expect(screen!.querySelector('[data-testid="pair-cancel"]'), "⭐ 「取消」也要在 ✓").toBeTruthy();
    // ⭐ 三句如实都要在（⭐ 一句都不许省 ✗）
    const notes = screen!.querySelector('[data-testid="pair-code-notes"]')?.textContent ?? "";
    // ⭐ **2026-10-13（owner 拍「不要 pake 了，就 20 位比对码」）**：⭐ **换主语不换断言** ✓ ——
    //   ⛔ 一条都不删，只把"6 位码要等 PAKE"那半 ✗ 改成**改后为真**的话 ✓。
    expect(notes, "⭐ 必须说清它是**比对码**（20 位／5 组）＋ 这是**现在的做法** ✓").toContain("比对码");
    expect(notes, "⭐ 要说清位数与分组（20 位）✓").toContain("20 位");
    expect(notes, "⭐ 要如实说 PAKE **已决定不做** ✓（⛔ 不再承诺「以后会变短」✗）").toContain(
      "已决定不做",
    );
    expect(notes, "⛔ 屏上**不许**再出现「等 PAKE 落地」那类**过期承诺** ✗").not.toContain("等 PAKE");
    expect(notes, "⭐ 必须说清它含窗口口令 ⇒ 只发你自己那台 ✓").toContain("只发你自己那台");
    expect(notes, "⭐ 必须说清它**不是一次性的** ✓").toContain("不是一次性的");
  });

  it("② 锁（今天已绿 ✓，⛔ 不是本片的修 ✗）：整份 `SyncPanel.tsx` 里**没有**「自动通过」这类说法", () => {
    // ⚠️ ⭐ 实测口径（⛔ 不许拿整份文件判「继续」✗ —— 严格模式那条**既有文案**里本来就有「继续」✓ ⇒ 会假红 ✓）：
    // ⭐ 「自动通过」这一格全份文件（**先剥注释** ✓）**一次都不许出现** ✓。
    const code = SYNC_PANEL_SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      code,
      "⛔ 不许出现「自动通过」✗（⭐ 仓里逐字：状态机里**没有这一格** ✓ ⇒ 界面也不许长出一个 ✓）",
    ).not.toContain("自动通过");
    expect(
      code,
      "⭐ 反面也要钉：**停态就是停态** ✓（⭐ 既有那条 `dpOutcome === 'stopped'` 的守卫不许被拆掉 ✓）",
    ).toContain('dpOutcome === "stopped"');
  });

  it("③（**本片的一部分**，⛔ 不是锁 ✗ —— 实测随本片一起红 ✓）：我这一屏里没有「继续」入口、也没有 Markdown `**…**`", () => {
    const code = pairScreenCode();
    expect(
      code,
      "⛔ 屏上不许出现「继续」入口 ✗（⭐ 对不上时只能**说文案**、⛔ 不给任何「接着走」的按钮 ✓）",
    ).not.toContain("继续");
    const bad = code.match(/\*\*[^*\n]{1,40}\*\*/g);
    expect(
      bad,
      `⛔ 我这一屏的 JSX 里出现了 Markdown 粗体：${bad?.[0]} ⇒ 请用 <b> 包起来 ✓（⭐ 今晚刚踩过 ✓）`,
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐⭐ **P-4 片②b（2026-10-13）**：⭐ **只挪时点** ✗ —— `trustDevice([activeId], p)` 那一次调用
//   从「接入」搬进「码对得上，确认」✓（⭐ 命令名／参数／返回值处理**一字未改** ✓）。
//
// ⭐ 数次数的地方＝ ⭐ `platform.executor.invoke`（桩＝ `invokeSpy` ✓）—— ⭐ 真因：`trustDevice`
//   自己就是走它调的（`SyncPanel.tsx:1291` 逐字 `await platform.executor.invoke(MESH_TRUST_BEGIN_COMMAND, {…})` ✓）
//   ⇒ ⭐ 按命令名数**恰好**数得到 ✓（⛔ 不是靠 api 层 ✗）。
//
// ⚠️ **①②③ 都是今天的红** ✓（⭐ 今天「接入」那一下**就**把它调了 ✓ ⇒ 三种点法都不对 ✓）；
//   ⚠️ ⭐ ②**必须按"增量"断言** ✗（⭐ 只断言"确认之后恰好一次"会**假绿** ✓ —— 今天「接入」已经调过一次、
//   总数也是 1 ✓）⇒ ⭐ 这里记 `before` ／ `after` 两个数，断言**差 = 1** ✓。
// ⭐ **④ 是锁**（今天已绿 ✓，⛔ 不是本片的修 ✗）。
// ═══════════════════════════════════════════════════════════════════════════════

/** `mesh_trust_begin` 一共被调了几次 ✓（⭐ 按命令名数 ✓ —— `invokeSpy` 里还有 `mesh_trust_state` 等 ✓）。 */
const trustBeginCalls = () =>
  invokeSpy.mock.calls.filter((c) => c[0] === "mesh_trust_begin").length;

/** 点一下那颗 ＋ 等微任务落地（⭐ 与既有那几条同一手法 ✓）。 */
async function clickAndSettle(el: HTMLElement) {
  flushSync(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  // ⭐ P-4 片③（2026-10-14）：⭐ 点击路径里多一次 api 往返（⇒ 两条 await 续体）⇒ ⛔ 3 拍不够 ✗
  //   —— ⚠️ 实测：3 拍时屏上停在「正在取这一轮的比对码…」(＝状态进了渲染 ✓，只是**结果还没回来** ✗) ✓
  await new Promise((r) => setTimeout(r, 0)); // 让 api 那条宏任务级往返落地 ✓
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync(() => {});
  }
}

describe("P-4 片②b：把调用时点挪到「确认」之后（只挪时点）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    meshSetConfigSpy.mockReset();
  });

  const okCode = () => ({ pairCode: { kind: "ok" as const, value: "1234 5678 9012 3456 7890" } });

  it("① ⭐ 点「接入」⇒ `mesh_trust_begin` **零调用**（今天【红】：那一它就调了 ✓）", async () => {
    const el = await openPanelWith([peer(true)], okCode());
    const allow = el.querySelector<HTMLElement>('[data-testid="nearby-allow"]');
    expect(allow, "夹具前提：那一行的「接入」要在 ✓").toBeTruthy();
    await clickAndSettle(allow!);
    expect(
      el.querySelector('[data-testid="pair-code-screen"]'),
      "⭐ 点「接入」只**开屏** ✓（⭐ 那是片②a 的既有行为 ✓）",
    ).toBeTruthy();
    expect(
      trustBeginCalls(),
      "⛔ 人**还没确认** ⇒ ⛔ 一个字节都不许发 ✗（⭐ 今天【红】：那一就调了 `mesh_trust_begin` ✓）",
    ).toBe(0);
  });

  it("② ⭐ 点「码对得上，确认」⇒ **恰好多一次**（今天【红】：那一下什么都不做 ✓）", async () => {
    const el = await openPanelWith([peer(true)], okCode());
    const allow = el.querySelector<HTMLElement>('[data-testid="nearby-allow"]');
    await clickAndSettle(allow!);
    const before = trustBeginCalls();
    const confirm = el.querySelector<HTMLElement>('[data-testid="pair-confirm"]');
    expect(confirm, "⭐ 「码对得上，确认」要在 ✓").toBeTruthy();
    await clickAndSettle(confirm!);
    expect(
      trustBeginCalls() - before,
      "⭐ 确认之后必须**恰好一次** ✓（⚠️ 按**增量**判 ✓ —— 只判总数会假绿 ✓）",
    ).toBe(1);
  });

  it("③ ⭐ 点「取消」⇒ 零调用 ＋ 屏关掉（今天【红】：接入那一已调过一次 ✓）", async () => {
    const el = await openPanelWith([peer(true)], okCode());
    const allow = el.querySelector<HTMLElement>('[data-testid="nearby-allow"]');
    await clickAndSettle(allow!);
    const cancel = el.querySelector<HTMLElement>('[data-testid="pair-cancel"]');
    expect(cancel, "⭐ 「取消」要在 ✓").toBeTruthy();
    await clickAndSettle(cancel!);
    expect(el.querySelector('[data-testid="pair-code-screen"]'), "⭐ 取消 ⇒ 那一屏要**关掉** ✓").toBeNull();
    expect(
      trustBeginCalls(),
      "⛔ 从「接入」到「取消」这一路**一个字节都不许发** ✗（⭐ 今天【红】：接入那一就发了 ✓）",
    ).toBe(0);
  });

  it("④ 锁（今天已绿 ✓，⛔ 不是本片的修 ✗）：整份 `SyncPanel.tsx`（**先剥注释** ✓）里没有「自动通过」", () => {
    const code = SYNC_PANEL_SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "⛔ 不许出现「自动通过」✗（⭐ 状态机里没有这一格 ✓ ⇒ 界面也不许长出一个 ✓）").not.toContain(
      "自动通过",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐⭐ **P-4 片③（2026-10-14）**：⭐ 屏上那份 `pairCode` 从**占位**换成 ⭐ **真读数** ✗ ——
//   点「接入」之后 ⭐ 调 `api.pairingCodeReading(p.device_id, p.pubkey)` ✓，⭐ 映射成那个 `Reading`：
//   ⭐ `code` 有值 ⇒ `kind: "ok"` ✓；⭐ `code: null` ⇒ `kind: "unavailable"` ⭐ **带命令给的人话原因** ✓
//   （⛔ 不自编原因 ✗）；⭐ 还没回来 ⇒ ⭐ **不许显示假码** ✗（维持「读取中」那种如实态 ✓）。
// ⚠️ ⭐ **不注入 prop 时才自己取** ✗：⭐ 调用方给了 `pairCode` ⇒ ⛔ 不抢它的 ✗
//   （⭐ 于是片②a／②b 那些当锁的判据照旧可控 ✓）。
// ⚠️ **①②③ 都是今天的红** ✓（⭐ 今天屏上永远是那个占位 ⇒ 桩改不了它 ✓）；⭐ **④ 是锁** ✓。
// ═══════════════════════════════════════════════════════════════════════════════

describe("P-4 片③：屏上那份 `pairCode` 换成**真读数**", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [], activeId: "ws-1" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    meshSetConfigSpy.mockReset();
    pairingCodeReadingSpy.mockReset();
  });

  it("① ⭐ 命令给了码 ⇒ 屏上出现**那串**（5 组 × 4 位）（今天【红】：屏上只有占位 ✓）", async () => {
    pairingCodeReadingSpy.mockResolvedValue({ code: "4829-1377-6021-5489-0376", reason: "ok" });
    const el = await openPanelWith([peer(true)]);
    const allow = el.querySelector<HTMLElement>('[data-testid="nearby-allow"]');
    await clickAndSettle(allow!);
    // ⭐ P-4 片③：⭐ 取值是**点击路径里的一次 api 往返** ✓ ⇒ ⭐ 用 waitFor 等它落地 ✓
    //   （⛔ 固定拍数在**整套并发**下不够 ✗ —— 实测：单跑绿、整套跑红 ✓）。
    let shown = "";
    await vi.waitFor(() => {
      shown =
        el.querySelector<HTMLElement>('[data-testid="pair-code-value"]')?.textContent ?? "";
      expect(shown, "⭐ 命令给的码必须**逐字**上屏 ✓（今天【红】：屏上还是那个占位 ✗）").toContain(
        "4829-1377-6021-5489-0376",
      );
    });
    // ⭐ 分组形状：**5 组 × 4 位数字** ✓（⭐ 后端用空格 ✓、⭐ 桩里那串用连字符 ✓ ⇒ 两种都认 ✓）
    const groups = shown.trim().split(/[\s-]+/);
    expect(groups.length, "⭐ 5 组 ✓（与后端 `chunks(4)` 的**组数**一致 ✓）").toBe(5);
    expect(
      groups.every((g) => /^\d{4}$/.test(g)),
      `⛔ 每组必须是 4 位数字 ✗（实测 ${JSON.stringify(groups)}）`,
    ).toBe(true);
  });

  it("② ⭐ 命令说读不到 ⇒ 屏上出现**那句原因**、且**一个码都没有**（今天【红】✓）", async () => {
    pairingCodeReadingSpy.mockResolvedValue({ code: null, reason: "本机还没生成设备密钥" });
    const el = await openPanelWith([peer(true)]);
    await clickAndSettle(el.querySelector<HTMLElement>('[data-testid="nearby-allow"]')!);
    // ⭐ 同上：等那一趟 api 落地 ✓（⛔ 固定拍数在整套并发下不够 ✗）
    await vi.waitFor(() => {
      const box = el.querySelector<HTMLElement>('[data-testid="pair-code-unavailable"]');
      expect(box, "⭐ 读不到 ⇒ 必须走「如实说原因」那一支 ✓").toBeTruthy();
      expect(box!.textContent ?? "", "⭐ **命令给的那句原因**要逐字在屏上 ✓（⛔ 不许自编 ✗）").toContain(
        "本机还没生成设备密钥",
      );
    });
    expect(el.querySelector('[data-testid="pair-code-value"]'), "⛔ 读不到时**一个码都不许出现** ✗").toBeNull();
  });

  it("③ ⭐ 点「接入」⇒ `pairingCodeReading` **恰好一次**，且实参是那一台的 id 与 pubkey（今天【红】✓）", async () => {
    pairingCodeReadingSpy.mockResolvedValue({ code: null, reason: "先放着" });
    const el = await openPanelWith([peer(true)]);
    expect(pairingCodeReadingSpy, "⛔ 还没点就不许取 ✗").not.toHaveBeenCalled();
    await clickAndSettle(el.querySelector<HTMLElement>('[data-testid="nearby-allow"]')!);
    expect(pairingCodeReadingSpy, "⭐ 点「接入」⇒ **恰好一次** ✓").toHaveBeenCalledTimes(1);
    expect(pairingCodeReadingSpy, "⭐ 实参必须是**那一台** ✓（⛔ 不传 space_id ✗ —— 空间不参与派生 ✓）").toHaveBeenCalledWith({
      peerDeviceId: "dev-amd",
      peerPubkey: PEER_PUBKEY,
    });
  });

  it("④ 锁（今天已绿 ✓）：屏上仍没有「继续／自动通过」＋ ⭐ 确认仍是闸门（`trustDevice` 只在确认那一下）", () => {
    const code = pairScreenCode();
    expect(code, "⛔ 仍然不许有「继续」入口 ✗").not.toContain("继续");
    expect(code, "⛔ 仍然不许有「自动通过」✗").not.toContain("自动通过");
    const atConfirm = SYNC_PANEL_SRC.indexOf('data-testid="pair-confirm"');
    const atTrust = SYNC_PANEL_SRC.indexOf("void trustDevice([activeId], peer);");
    expect(atConfirm, "夹具前提：确认那颗在 ✓").toBeGreaterThan(-1);
    expect(atTrust, "夹具前提：那一次调用在 ✓").toBeGreaterThan(-1);
    expect(atConfirm, "⭐ 确认仍是**闸门**：调用必须排在确认那颗**之后** ✓（⛔ 不许提前 ✗）").toBeLessThan(atTrust);
  });
});
