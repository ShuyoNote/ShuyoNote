// 「启动时的更新提醒」在 Android 上的**真实口径** —— 这条路径已经被（差点）写反过一次，所以钉住。
//
// 差点写进文档的说法是"**Android 没有红点**／不主动提醒：红点只走桌面的 in-app updater"。
// 代码不是这样：
//   · `useUpdateChecker()` 在 `App.tsx` 里**无条件**调用（红点 = `ActivityBar` 读同一个 store 标志，
//     横幅 = `UpdateBanner`），移动端并没有把它关掉；
//   · `isDesktop()` 的真实语义是"**有没有 Rust 内核**"（见 `src/lib/platform/capabilities.ts` 顶部的
//     边界说明，以及 `src/components/aboutDialog.test.ts` 里同一句），Android 壳**为真**
//     ⇒ 走的是桌面那一支 `checkDesktopUpdate()`；
//   · 而 `tauri-plugin-updater` 只在桌面注册（`src-tauri/src/lib.rs`，`#[cfg(desktop)]`）
//     ⇒ 这一步在 Android 上**必然失败**；
//   · 失败之后代码**降级**到 gitcode 发布渠道清单（`useUpdateChecker.ts` 的 `detectFromGitcode()`），
//     走 `updates::fetch_update_manifest` —— 这个命令在 `lib.rs` 的 `generate_handler!` 里
//     **没有** `#[cfg(desktop)]`，全平台注册，Android 上可用（「关于」的 Android 分支取 APK 地址也靠它）。
// ⇒ 结论：线上 `latest` 渠道版本比已装版本新时，**Android 启动就会出现红点 + 顶部横幅**，与桌面同一套 UI。
//    真正的边界只在"**装**"这一步：横幅只是提醒（入口只到「关于」），应用内不下载、不唤起安装器。
//
// 本文件钉的就是这条降级链路：把 Android 壳模拟成"有 `__TAURI_INTERNALS__`（⇒ `isDesktop()` 为真）
// + updater 命令一调就失败"，断言**只**发生了清单请求、且 store 变成"有新版"（红点/横幅的判据）。
//
// 覆盖到哪一步：只覆盖**前端**这条启动检查路径与其降级判据（走了哪条通道、store 标志变成什么）。
// **不**覆盖 Rust 侧 `fetch_update_manifest` 在真机 Android 上能否跑通（那要真机，见
// `docs/RELEASING.md` §9.6 的清单项），也不覆盖红点/横幅的渲染本身（那两条各自读同一个 store 标志）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  checkUpdater: vi.fn<() => Promise<unknown>>(),
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

// 桌面专属插件：Android 的壳里**没有**注册它，命令一调就以 "Command … not found" 失败。
// 这条拒绝是这个用例的**输入条件**（不是被测逻辑），所以直接桩掉、不引入真的 plugin-updater。
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.checkUpdater }));
// 清单/其它命令走 `invoke`：这里只关心"启动这条路上调了哪个命令"。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {},
  Resource: class {},
}));

import { useUpdateChecker } from "./useUpdateChecker";
import { useEditorStore } from "../store/editor";
import { APP_VERSION } from "./links";

/** 比当前构建版本严格更新的一版（避免用例随版本号发版而腐烂）。 */
function newerThan(version: string): string {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`版本号形状不认识：${version}`);
  return `${Number(m[1]) + 1}.0.0`;
}

/** 挂载一个只跑 `useUpdateChecker()` 的探针（不依赖 App 的其它初始化）。 */
function mountProbe() {
  function Probe() {
    useUpdateChecker();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Probe)));
  return root;
}

const manifest = (version: string) => ({
  version,
  notes: "本轮更新说明",
  pub_date: "2026-09-15T02:00:00Z",
  android_url: "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v9.9.9/x_android-arm64-release.apk",
  android_sha256: "a".repeat(64),
});

describe("启动时的更新检查：Android 壳（有 Rust 内核、没有 updater 插件）", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    // Android = 带 Rust 内核的壳：`__TAURI_INTERNALS__` 在（⇒ isDesktop() 为真）。
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    useEditorStore.setState({ updateAvailable: false, latestVersion: null });
    mocks.checkUpdater.mockReset();
    mocks.invoke.mockReset();
    // Android 上的必然结果：桌面专属的 updater 命令不存在。
    mocks.checkUpdater.mockRejectedValue(new Error("Command plugin:updater|check not found"));
  });

  afterEach(() => {
    const mounted = root;
    root = null;
    if (mounted) flushSync(() => mounted.unmount());
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it("in-app updater 不可用 ⇒ 降级到发布渠道清单，有新版就该出红点/横幅（这条挡的是「Android 没有红点」那个回归）", async () => {
    const next = newerThan(APP_VERSION);
    mocks.invoke.mockResolvedValue(manifest(next));

    root = mountProbe();

    await vi.waitFor(() => expect(useEditorStore.getState().updateAvailable).toBe(true));
    expect(useEditorStore.getState().latestVersion).toBe(next);
    // 判据：启动这条路上**只**有清单请求（没有第二条通道、也没有 Web 那条 version.json）。
    expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual(["fetch_update_manifest"]);
  });

  it("同一个壳、但线上不比已装的新 ⇒ 不打扰（红点/横幅不出现）", async () => {
    mocks.invoke.mockResolvedValue(manifest(APP_VERSION));

    root = mountProbe();

    // 先等清单那一步真的跑完，否则"还没跑"和"跑完判定为无新版"会看起来一样。
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    // 红点/横幅的判据就是这个标志（`ActivityBar` 与 `UpdateBanner` 都只认它）；
    // 注意 `latestVersion` 这里仍会被写成清单版本（`detectFromGitcode` 两个分支都回传它），
    // 两个 UI 都先看 `updateAvailable` ⇒ 不影响"不打扰"。
    expect(useEditorStore.getState().updateAvailable).toBe(false);
    expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual(["fetch_update_manifest"]);
  });

  it("清单拉不到（离线/失败）⇒ 静默当作无更新，不崩", async () => {
    mocks.invoke.mockRejectedValue(new Error("无法连接到 …"));
    // 离线时 `fetch_update_manifest` 自己会 console.warn 一句（这是**设计**：降级不抛给 UI）。
    // 这里挡掉它的输出，避免 CI 日志里出现一条看着像失败的栈。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    root = mountProbe();

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(useEditorStore.getState().updateAvailable).toBe(false);
    warn.mockRestore();
  });
});

describe("启动时的更新检查：Web（没有 Rust 内核）", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    useEditorStore.setState({ updateAvailable: false, latestVersion: null });
    mocks.checkUpdater.mockReset();
    mocks.invoke.mockReset();
  });

  afterEach(() => {
    const mounted = root;
    root = null;
    if (mounted) flushSync(() => mounted.unmount());
    vi.unstubAllGlobals();
  });

  it("对比服务器部署版本，且**不碰** native 命令（updater / 清单都不调）", async () => {
    const next = newerThan(APP_VERSION);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version: next }) })));

    root = mountProbe();

    await vi.waitFor(() => expect(useEditorStore.getState().updateAvailable).toBe(true));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.checkUpdater).not.toHaveBeenCalled();
  });
});
