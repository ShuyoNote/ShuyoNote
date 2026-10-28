// ⭐ **2026-10-29（owner 拍）：团队功能冻结** 的**反面判据** ——
// 证明那一组隐藏是**门**（`lib/edition.ts` 的开关），⛔ 不是把代码删了 ✗：
// 把开关换成 `archived = false` 的同形 mock ⇒ 团队卡片的**配置入口必须全部回来** ✓。
//
// ⚠️ 为什么单独一个文件：`vi.mock` 是**文件级**的 ✓（同一文件里没法一会儿冻结一会儿解冻）。
// 两个文件合起来才叫"可逆的冻结"：
//   · `teamEditionFrozen.wiring.test.tsx`（真开关=true ⇒ 入口不渲染、旧配置仍显示/可同步 ✓）
//   · 本文件（开关=false ⇒ 入口真的回来 ⇒ 上面那些"不渲染"不是把代码删了 ✓）
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeSpy, lanStatusSpy, listProfilesSpy, secSpy } = vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
  };
  return { invokeSpy: vi.fn(), lanStatusSpy: vi.fn(), listProfilesSpy: vi.fn(), secSpy: vi.fn() };
});

vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      lanStatus: (id: string) => lanStatusSpy(id),
      listSyncProfiles: () => listProfilesSpy(),
      spaceSecurityOverview: () => secSpy(),
      meshSetConfig: async () => ({ paired: [] }),
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => null) },
  ),
}));

// ★ 解冻态：`archived = false` ⇒ `teamConfigEntryVisible()` 返回 true。
vi.mock("../lib/edition", () => ({
  TEAM_EDITION_ARCHIVED: false,
  TEAM_EDITION_ARCHIVED_NOTE: "（解冻态不该出现这句）",
  teamConfigEntryVisible: (archived = false) => !archived,
}));

import { platform } from "../lib/platform";
import { AUTO_SYNC_KEY } from "../lib/syncMode";
import { useSpaceStore } from "../store/space";
import { SyncPanel } from "./SyncPanel";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderUnconfiguredTeamPanel(): Promise<HTMLElement> {
  lanStatusSpy.mockResolvedValue({
    enabled: true,
    peers: 0,
    kind: "",
    line: "",
    mesh: {
      enabled: false,
      bind: null,
      tokenSet: false,
      window: null,
      served: [],
      paired: [],
      note: "",
      reach: "",
      announced: null,
    },
    nearby: [],
  });
  // 未配置的团队空间：空档案（老用户之外的新配置形状 ✓）
  listProfilesSpy.mockResolvedValue([
    { ws_id: "ws-team", server_url: "", token: "", space_id: "", last_pushed_seq: 0, last_pulled_seq: 0, sync_attachments: 1 },
  ]);
  secSpy.mockResolvedValue([{ space_id: "ws-team", kind: "team", encrypted_on_disk: false }]);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<SyncPanel contentOnly />));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    flushSync(() => {});
  }
  return host;
}

const buttonTexts = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());

describe("解冻态（同一个开关改成 false）⇒ 团队配置入口**真的回来**（证明是门、不是删代码）", () => {
  beforeEach(() => {
    localStorage.setItem(AUTO_SYNC_KEY, "300000");
    useSpaceStore.setState({ spaces: [{ id: "ws-team", name: "团队空间" }] as never, activeId: "ws-team" });
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async (cmd: string) =>
      cmd === "mesh_trust_state" ? { state: "idle", message: "还没开始", active: false, pending: 0 } : null,
    );
    vi.spyOn(platform.executor, "invoke").mockImplementation(invokeSpy as never);
    listProfilesSpy.mockReset();
    secSpy.mockReset();
  });

  it("① 解冻 ⇒ 账号登录/注册表单回来（⛔ 冻结时那些不是被删了 ✗）", async () => {
    const el = await renderUnconfiguredTeamPanel();
    const btns = buttonTexts(el);
    expect(btns, `解冻后必须能重新看到「登录/注册」（否则冻结就是删代码）：${JSON.stringify(btns)}`).toContain("登录");
    expect(btns).toContain("注册");
    expect(el.querySelector("#sync-srv-ws-team"), "服务器地址输入格必须回来").toBeTruthy();
    expect(el.querySelector('#sync-mail-ws-team'), "账号输入格必须回来").toBeTruthy();
  });

  it("② 解冻 ⇒ 「保存」与（有 token 时的）成员/创建空间入口回来", async () => {
    const el = await renderUnconfiguredTeamPanel();
    const btns = buttonTexts(el);
    expect(btns, `解冻后「保存」必须回来：${JSON.stringify(btns)}`).toContain("保存");
    // ⚠️ 成员管理要有 token+space 才出现 ⇒ 本夹具是空档案，不在此处断言（另一文件已钉冻结态隐藏 ✓）。
  });

  it("③ 解冻 ⇒ 那行「团队功能已冻结」注记**不出现**（它只属于冻结态）", async () => {
    const el = await renderUnconfiguredTeamPanel();
    expect(el.querySelector('[data-testid="team-frozen-note"]')).toBeNull();
    expect(el.textContent ?? "").not.toContain("团队功能已冻结");
  });
});
