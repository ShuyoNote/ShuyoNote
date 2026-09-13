// 「关于」弹窗的**结构与版面**回归测试 —— 外加**更新入口的两条腿**（桌面 / Android）。
//
// 为什么值得钉：这个弹窗被减过两次内容（去掉中文名、去掉产品说明），而"去掉之后还协不协调"
// 是纯视觉判断——没有测试的话，下一次有人顺手加回一句说明、或者名称那行再多一个元素，
// 版面又会被撑歪，而且没人会发现。这里钉的是**结构**（剩下什么、各块的层次），不是像素。
//
// 下半部分（Android 更新入口）是后来补的：Android 的「下载 APK」与桌面的「下载并安装」只差
// 一个 `isMobileUserAgent(navigator.userAgent)` 分支，分支写错时症状是**静默**的（摆出一个
// 点了没反应的按钮，或者老清单时连退路都没有），所以在同一条挂载链路上把两条腿都点一遍。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  fetchUpdateManifestNative: vi.fn<() => Promise<unknown>>(),
  checkDesktopUpdate: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../lib/platform", () => ({
  platform: { opener: { openUrl: mocks.openUrl } },
  isDesktopPlatform: () => false,
  // 这条腿由「有 Rust 内核的壳 + 移动端 UA」两个条件共同决定；Web 形态下 `isWeb` 短路，
  // 所以上面那两条版面用例根本不会调用它（真机上的 UA 在 happy-dom 里造不出来）。
  isMobileUserAgent: () => true,
}));

// 清单不再走浏览器 fetch（会被 gitcode 的跨域 302 拦），而是走 Rust 命令；
// 这里连 `checkDesktopUpdate` 一起桩掉，既避免真的去 import `@tauri-apps/plugin-updater`，
// 也让"Android 这条腿**没有**调用桌面 in-app 通道"变成一条可断言的判据。
vi.mock("../lib/updater", () => ({
  fetchUpdateManifestNative: mocks.fetchUpdateManifestNative,
  checkDesktopUpdate: mocks.checkDesktopUpdate,
}));

import { AboutDialog } from "./AboutDialog";
import { useEditorStore } from "../store/editor";
import { APP_NAME } from "../lib/links";
import { RELEASES_URL } from "../lib/updates";

// 弹窗在 Web 形态下会去取 `version.json`（`detectFromDeployed`）。不桩掉的话 happy-dom 会真的
// 去连 http://localhost:3000：本机上它留下一个没人处理的 `AggregateError: ECONNREFUSED`，
// 结果是**全部用例都通过、`npx vitest run` 却以 1 退出**（CI 的 `pnpm test` 就是这条命令，
// 于是"测试全绿"和"流水线红"会同时成立）。桩成"未部署"既挡掉真实网络，也钉住降级路径。
const fetchStub = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));

beforeEach(() => {
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 注意：这个弹窗走 createPortal 渲染到 document.body，所以断言要查 document 而不是容器节点。
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    root,
    render: () => flushSync(() => root.render(React.createElement(AboutDialog))),
  };
}

describe("「关于」弹窗的版面", () => {
  it("头部只留 logo + 名称 + 版本/许可两枚胶囊（没有中文名、没有产品说明）", () => {
    useEditorStore.setState({ aboutOpen: true });
    const { render, root } = mount();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render();

    const hero = document.querySelector(".about-hero");
    expect(hero, "头部应当在").not.toBeNull();
    expect(hero?.querySelector(".about-logo"), "logo 在").not.toBeNull();

    // 名称：只有 ShuyoNote（中文名已按要求去掉）
    const name = document.querySelector(".about-name");
    expect(name?.textContent).toBe(APP_NAME);
    expect(name?.textContent).not.toContain("数友笔记");
    // 名称行里不该再有别的元素（"再多一个 span"正是当初把它撑歪的做法）
    expect(name?.querySelectorAll("*").length).toBe(0);

    // 产品说明整行不再存在（连带 .about-desc 样式也已删除）
    expect(document.querySelector(".about-desc")).toBeNull();
    expect(document.querySelector(".about-name-en"), "只服务中文名那个 span 的样式也别再回来").toBeNull();

    // 两枚胶囊（版本 + 许可）仍在，且就在头部里
    expect(hero?.querySelectorAll(".about-pill").length).toBe(2);

    // 段落依次是：检查更新 / 开源与反馈 / 外链开关；最后是操作区
    const sections = [...document.querySelectorAll(".about-section")];
    expect(sections.length).toBe(3);
    expect(sections[0].className).toContain("about-update-row");
    expect(document.querySelector(".about-links")?.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".about-actions .about-close"), "关闭按钮在").not.toBeNull();

    flushSync(() => root.unmount());
    spy.mockRestore();
  });

  it("没打开时什么都不渲染（弹窗由 store 控制）", () => {
    useEditorStore.setState({ aboutOpen: false });
    const { render, root } = mount();
    render();
    expect(document.querySelector(".about")).toBeNull();
    flushSync(() => root.unmount());
  });
});

// ── 更新入口的两条腿：Android 下载 APK vs 桌面 in-app 安装 ────────────────────────────
//
// Android 上不接桌面那套 in-app 下载安装（`tauri-plugin-updater` 只在桌面可用，移动端装包要经
// 系统安装器）：装上 Rust 内核的壳 + 移动端 UA，弹窗就该只做两件事——比对清单版本号、把 APK 地址
// 交给系统。这里钉四件事，四件都是"错了会静默"的：
//   ① 有新版且清单带 android 条目 → 出「下载 APK」，点击打开的是**清单里的那个地址**；
//   ② 同一屏**没有**桌面那条腿（没有「下载并安装」，也没调 `checkDesktopUpdate`）；
//   ③ 老清单（没有 android 条目）→ 退回「前往发布页」，而不是什么都不给；
//   ④ 有 notes 就显示发行说明（此前显示条件里含桌面的 download 句柄，Android 上永远为空 ⇒
//      "拿到了 notes 却不显示"，本提交顺带修掉）。
const APK_URL =
  "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.91.0/ShuyoNote_1.91.0_android-arm64-release.apk";

describe("「关于」弹窗的 Android 更新入口", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    // Android = 带 Rust 内核的壳：`isDesktop()` 为真（清单走 native 命令，绕 CORS），
    // 同时 UA 判为移动端 ⇒ 走 Android 那条腿。两条件缺一个都会掉回桌面/Web 形态。
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    document.body.innerHTML = "";
    mocks.openUrl.mockReset();
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.fetchUpdateManifestNative.mockReset();
    mocks.checkDesktopUpdate.mockReset();
    mocks.checkDesktopUpdate.mockResolvedValue({ state: "unavailable" });
  });

  afterEach(() => {
    const mounted = root;
    root = null;
    if (mounted) flushSync(() => mounted.unmount());
    document.body.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  /** 打开「关于」并让自动那次检查拿到给定清单。 */
  const openAboutWith = (manifest: unknown) => {
    mocks.fetchUpdateManifestNative.mockResolvedValue(manifest);
    useEditorStore.setState({ aboutOpen: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mounted = createRoot(host);
    root = mounted;
    flushSync(() => mounted.render(React.createElement(AboutDialog)));
  };

  const buttonByText = (label: string): HTMLButtonElement | null =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    ) ?? null;

  it("有新版 + 清单带 android 条目 → 「下载 APK」点击后打开的是清单里的地址（且不走桌面 in-app 通道）", async () => {
    openAboutWith({
      version: "9.9.9",
      notes: "修了几个 bug",
      pub_date: "2026-09-14T00:00:00Z",
      android_url: APK_URL,
      android_sha256: "a".repeat(64),
    });

    await vi.waitFor(() => expect(buttonByText("下载 APK"), "有 apk 地址就该出下载入口").not.toBeNull());
    // 桌面那条腿在这台设备上必须完全不存在：移动端没有 updater 插件，真摆出来点了只会失败
    expect(buttonByText("下载并安装")).toBeNull();
    expect(mocks.checkDesktopUpdate).not.toHaveBeenCalled();

    flushSync(() => buttonByText("下载 APK")!.click());
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledTimes(1));
    expect(mocks.openUrl).toHaveBeenCalledWith(APK_URL);
  });

  it("有新版但清单是**老清单**（没有 android 条目）→ 退回「前往发布页」，点和开的是发布页", async () => {
    openAboutWith({ version: "9.9.9", notes: null, pub_date: null, android_url: null, android_sha256: null });

    await vi.waitFor(() => expect(buttonByText("前往发布页"), "没有 apk 地址就得留一条退路").not.toBeNull());
    expect(buttonByText("下载 APK")).toBeNull();
    expect(buttonByText("下载并安装")).toBeNull();

    flushSync(() => buttonByText("前往发布页")!.click());
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(RELEASES_URL));
  });

  it("清单版本不比当前新 → 不摆任何更新入口（也不打扰）", async () => {
    openAboutWith({ version: "0.0.1", notes: "旧说明", pub_date: null, android_url: APK_URL, android_sha256: "a".repeat(64) });

    await vi.waitFor(() => expect(document.body.textContent).toContain("已是最新"));
    // 地址拿到了也不该显示：没有新版就没有下载入口（"有地址就摆按钮"是很容易写错的一处）
    expect(buttonByText("下载 APK")).toBeNull();
    expect(buttonByText("前往发布页")).toBeNull();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("Android 上发行说明要显示（此前只有桌面拿得到 download 句柄才显示）", async () => {
    openAboutWith({
      version: "9.9.9",
      notes: "块操作体系重构 + 文字选中优先",
      pub_date: "2026-09-14T00:00:00Z",
      android_url: APK_URL,
      android_sha256: "a".repeat(64),
    });

    await vi.waitFor(() => expect(document.querySelector(".about-release-notes")).not.toBeNull());
    expect(document.querySelector(".about-release-notes-body")?.textContent).toContain("块操作体系重构");
  });
});
