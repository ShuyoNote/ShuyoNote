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
