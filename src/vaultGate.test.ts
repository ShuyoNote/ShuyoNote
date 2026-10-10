// 口令锁闸门的回归测试。这条测试钉的是一个**真事故**（2026-09-16 发现并修）：
//
//   加密开启后重启应用 = 用户看到崩溃屏，而不是锁定屏。
//
// 原因是 `App` 里的闸门写成一句早退，而它排在七八个 hooks **之前**：
//   首帧 `enc === null` → 不算锁定 → 这一帧跑了 N 个 hooks；
//   状态回来后的第二帧早退 → 只跑 N-3 个 → React 抛
//   `Rendered fewer hooks than expected.`
// 根部 ErrorBoundary 把它接住 → 崩溃屏。于是 E1 的锁定屏在这条路径上**永远没机会出现**
// （真机没验过重启，所以一直没暴露）。
//
// 所以这里的判据是**用户看得见的结果**：锁定安装启动后 DOM 里是锁定屏、外壳不挂载、
// 渲染过程一声不响；运行中锁定要立刻切屏；解锁后要回来。修复前的代码会让本文件红。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { __resetVaultForTests, lockVault, unlockVault, vaultState } from "./lib/vault";
import "./i18n"; // 外壳里的组件用 useTranslation；先初始化，免得刷一屏 NO_I18NEXT_INSTANCE

const mocks = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ enabled: boolean; locked: boolean }>>(),
  lockEncryption: vi.fn<() => Promise<void>>(),
  unlockEncryption: vi.fn<(p: string) => Promise<void>>(),
  // ⭐ 2026-10-10：锁定屏的**出路**要读"本机哪些空间是明文" ⇒ 两条命令都得给桩。
  overview: vi.fn<() => Promise<unknown[]>>(async () => []),
  workspaces: vi.fn<() => Promise<{ id: string; name: string }[]>>(async () => []),
  setActive: vi.fn<(id: string) => Promise<void>>(async () => undefined),
}));

// 只替换加密那几个命令；外壳里的其它命令一律给空数组，够它安静地渲染。
// ★ owner 第三轮拍板（2026-09-24）：`set_encryption` / `disable_encryption`（应用级）已删 ⇒
// 这里也不再桩它们（`enableVault` / `disableVault` 随命令一起没了）。
vi.mock("./lib/api", () => ({
  api: new Proxy(
    {
      encryptionStatus: mocks.status,
      lockEncryption: mocks.lockEncryption,
      unlockEncryption: mocks.unlockEncryption,
      spaceSecurityOverview: mocks.overview,
      listWorkspaces: mocks.workspaces,
      setActiveWorkspaceId: mocks.setActive,
    },
    {
      get: (target: Record<string, unknown>, name: string) =>
        name in target ? target[name] : async () => [],
    },
  ),
}));

const { default: App } = await import("./App");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let consoleErrors: string[];

// 不桩掉 fetch 的话，happy-dom 会真的去连 http://localhost:3000（相对 URL 的落点），
// 留下一个没人处理的 `AggregateError: ECONNREFUSED`——结果是**用例全过、退出码却是 1**。
// 这是本机（Windows）实测过的坑，见 aboutDialog.test.ts 的同一段注释。
const fetchStub = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));

beforeEach(() => {
  __resetVaultForTests();
  consoleErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
  vi.stubGlobal("fetch", fetchStub);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 状态回执与订阅通知都发生在 React 之外（promise 里），所以要真正跑完一轮：
// act 会把这些更新连同 effect 一起冲干净，再断言。
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render() {
  flushSync(() => root.render(React.createElement(App)));
  await settle();
}

function hookOrderErrors() {
  return consoleErrors.filter((e) => /Rendered (fewer|more) hooks/.test(e));
}

describe("加密锁定的启动闸门", () => {
  it("已开启加密且锁定：启动后是锁定屏，外壳不挂载，且没有任何 hooks 顺序报错", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen"), "锁定态必须给出锁定屏").not.toBeNull();
    expect(host.querySelector(".app"), "锁定态不应挂载应用外壳").toBeNull();
    expect(hookOrderErrors(), "渲染期不许出现 hooks 顺序报错").toEqual([]);
  });

  it("未开启加密：直接进应用外壳（不许卡在锁定屏上）", async () => {
    mocks.status.mockResolvedValue({ enabled: false, locked: false });

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app"), "正常启动应当渲染外壳").not.toBeNull();
    expect(hookOrderErrors()).toEqual([]);
  });

  it("运行中锁定（设置页点「立即锁定」）：界面立刻切回锁定屏", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: false });
    mocks.lockEncryption.mockResolvedValue(undefined);
    await render();
    expect(host.querySelector(".app"), "先确认已解锁时渲染的是外壳").not.toBeNull();

    // 模拟设置页里的「立即锁定」：走同一个状态中枢，不经过 App 自己的 state。
    await act(async () => {
      await lockVault();
    });

    expect(host.querySelector(".lock-screen"), "锁定后必须马上切屏，不能继续展示读不出来的内容").not.toBeNull();
    expect(host.querySelector(".app")).toBeNull();
    expect(vaultState().locked).toBe(true);
  });

  it("解锁成功后回到外壳（锁定屏不能把人关在外面）", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    mocks.unlockEncryption.mockResolvedValue(undefined);
    await render();
    expect(host.querySelector(".lock-screen")).not.toBeNull();

    await act(async () => {
      await unlockVault("正确口令");
    });
    await settle();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app")).not.toBeNull();
  });

  it("解锁失败不改变状态：仍然锁定，错误照常抛出给界面显示", async () => {
    mocks.status.mockResolvedValue({ enabled: true, locked: true });
    // ★ 内核文案（owner 第三轮拍板后）：口令对不对由**解盒子**回答
    mocks.unlockEncryption.mockRejectedValue(new Error("打不开（口令不对或盒子被改过）"));
    await render();

    await act(async () => {
      await expect(unlockVault("错的")).rejects.toThrow("打不开");
    });

    expect(vaultState().locked, "口令不对就不能变成已解锁").toBe(true);
    expect(host.querySelector(".lock-screen")).not.toBeNull();
  });

  it("问不到内核状态时按「未开启」处理：宁可让人用，也不要卡在锁定屏", async () => {
    mocks.status.mockRejectedValue(new Error("no such command"));

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app")).not.toBeNull();
    expect(vaultState()).toMatchObject({ enabled: false, locked: false, ready: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-10：owner 亲口报的缺陷 ——「**一个空间加密，其它空间怎么还需要密码？**」
//
// 量到的机制（⛔ 不是猜 ✗）：
//   · 闸门 = `vault.activeSpaceEncrypted && vault.locked`，判的是**当前活动空间**
//     （内核 `encryption_status.enabled` 按活动空间算；启动时的 `LOCKED` 也只看活动空间的文件头 ✓）
//     ⇒ ⭐ **这一半原先就是对的** ✓；
//   · ✗ 出事的是下一层：闸门一为真，`AppShell` **整块不挂载**，而**空间切换器就在 AppShell 里**
//     ⇒ 用户**出不去**，只能先输那个加密空间的口令 ⇒ 「一个空间的口令」事实上成了「整个应用的开关」✗。
// ⇒ 所以这四条判据守的不是"把闸门放开"✗，而是：**闸门照挡 ＋ 明文空间有一条直接进去的路** ✓。
// ══════════════════════════════════════════════════════════════════════════

/** 一个加密空间的读数（与 `SpaceSecurityView` 同形 ✓）。 */
function encView(id: string) {
  return {
    space_id: id,
    kind: "personal",
    encrypted_on_disk: true,
    in_keyring: true,
    key_available: false,
    gate: { allow: true, unclassified: false, reason: "" },
  };
}
/** 一个**明文**空间的读数。 */
function plainView(id: string) {
  return {
    space_id: id,
    kind: "personal",
    encrypted_on_disk: false,
    in_keyring: false,
    key_available: false,
    gate: { allow: true, unclassified: false, reason: "" },
  };
}

/** 夹具：本机**一个加密空间（未解锁）＋ 一个明文空间** ✓（就是 owner 那个现场 ✓）。 */
function fixture() {
  mocks.overview.mockResolvedValue([encView("enc"), plainView("plain")]);
  mocks.workspaces.mockResolvedValue([
    { id: "enc", name: "加密空间" },
    { id: "plain", name: "明文空间" },
  ]);
  // 活动空间是**加密**那个，且会话锁着 ⇒ 闸门该出来 ✓
  mocks.status.mockResolvedValue({ enabled: true, locked: true });
}

const escapeBox = () => host.querySelector('[data-testid="lock-other-spaces"]');

describe("一个空间加密，⛔ 不锁住其它空间（owner 拍 B：明文空间直接可用）", () => {
  it("⭐ a) 正面：本机有明文空间 ⇒ 锁定屏上**必须有一条直接进去的路**（旧行为必红）", async () => {
    fixture();
    await render();

    // 闸门**照旧挡着**（不是在"放开"✗）
    expect(host.querySelector(".lock-screen"), "加密空间未解锁 ⇒ 仍然要口令").not.toBeNull();
    expect(host.querySelector(".app"), "那一个空间锁着时，外壳不挂载").toBeNull();

    // ⭐ 但**出口必须在**：旧代码在这一步是**死路** ⇒ 本用例红 ✓
    expect(escapeBox(), "锁定屏上必须有「其它空间不用口令」那一段").not.toBeNull();
    const box = escapeBox()!.textContent ?? "";
    expect(box, "要把那个明文空间的名字摆出来").toContain("明文空间");
    // ⛔ 加密的那个**不许**混进"直接进去"的清单里 ✗
    expect(box).not.toContain("加密空间");
  });

  it("⭐ a2) 点一下就换过去：闸门随之放开，明文空间**直接可用**", async () => {
    fixture();
    await render();

    // 换过去之后内核会这么报：**活动空间**不再加密，而会话**仍然锁着** ✓（锁定是会话级 ✓）
    mocks.status.mockResolvedValue({ enabled: false, locked: true });

    await act(async () => {
      (host.querySelector('[data-testid="lock-go-plain"]') as HTMLButtonElement).click();
    });
    await settle();

    expect(mocks.setActive, "要走内核那条换空间的路").toHaveBeenCalledWith("plain");
    expect(host.querySelector(".lock-screen"), "明文空间不该再被拦").toBeNull();
    expect(host.querySelector(".app"), "明文空间必须能直接用").not.toBeNull();
  });

  it("⭐ b) 反向：加密空间未解锁 ⇒ 仍然读不出来（⛔ 不许修成「谁都能开」）", async () => {
    // 只有加密空间、**没有**明文出路 ⇒ 一个字节都不许松
    mocks.overview.mockResolvedValue([encView("enc")]);
    mocks.workspaces.mockResolvedValue([{ id: "enc", name: "加密空间" }]);
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen")).not.toBeNull();
    expect(host.querySelector(".app"), "没有出路时就该老实挡着").toBeNull();
    expect(escapeBox(), "没有明文空间时不许摆那个空盒子").toBeNull();
    expect(vaultState().locked, "仍然锁着").toBe(true);
  });

  it("⭐ c) 反向：换到明文空间**不是**「偷偷解锁」（会话仍然锁着）", async () => {
    fixture();
    await render();
    // ⚠️ 用**增量**判，不用"从没调过"：同一个文件里前面的用例已经调解锁过 ✓。
    const before = mocks.unlockEncryption.mock.calls.length;
    mocks.status.mockResolvedValue({ enabled: false, locked: true });

    await act(async () => {
      (host.querySelector('[data-testid="lock-go-plain"]') as HTMLButtonElement).click();
    });
    await settle();

    // ⭐ 出路是"换空间"，⛔ 不是"解锁"✗ —— 锁还在，主密钥没被放出来 ✓
    expect(vaultState().locked, "换空间不许顺手把会话解锁").toBe(true);
    expect(mocks.unlockEncryption.mock.calls.length, "⛔ 不许在背后调解锁").toBe(before);
  });

  it("⭐ d) 回归：本机**没有**加密空间 ⇒ 一个字节都不变（不出现锁定屏、也不出现那一段）", async () => {
    mocks.overview.mockResolvedValue([plainView("plain")]);
    mocks.workspaces.mockResolvedValue([{ id: "plain", name: "明文空间" }]);
    mocks.status.mockResolvedValue({ enabled: false, locked: false });

    await render();

    expect(host.querySelector(".lock-screen")).toBeNull();
    expect(host.querySelector(".app"), "没有加密空间 ⇒ 直接进外壳（同旧行为）").not.toBeNull();
    expect(escapeBox(), "没锁就不该有那一段").toBeNull();
    expect(vaultState()).toMatchObject({ enabled: false, locked: false, ready: true });
  });

  it("⭐ 出路读不到时**如实不给**（⛔ 不摆一个点不动的空间名）", async () => {
    mocks.overview.mockRejectedValue(new Error("no such command"));
    mocks.status.mockResolvedValue({ enabled: true, locked: true });

    await render();

    expect(host.querySelector(".lock-screen"), "闸门照旧").not.toBeNull();
    expect(escapeBox(), "读不到就不给路，但也不假报有一个").toBeNull();
  });
});
