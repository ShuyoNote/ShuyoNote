// 第 4 招的判据：**MCP 接入要有命令面板入口**（owner 2026-10-08 拍板开工的 ④「只补独立入口」✓）。
//
// 背景（先核过的事实 ✓）：面板里**已经有**「管理插件」（`plugin.manage` ⇒ `setManagerOpen(true)` ✓）
//   与「AI 助手」（⇒ `openSettings("ai")` ✓）两条 ⇒ 本招真正缺的只有 **MCP** 那一条 ✗。
//
// 守两件事（都是"看起来没事、实际很坏"✓）：
//   ① 命令**在不在**（不在 ⇒ Ctrl+K 搜不到，用户以为没这个功能 ✗）；
//   ② ⛔ **Web 版不能把它开进一个空页** ✗ —— 「外部 AI 接入」那一格在 Web 版**整个不出现**
//      （`SettingsDialog.tsx` 按 `isDesktopPlatform()` 过滤 ✓）⇒ 命令若在 Web 版直接
//      `openSettings("mcp")`，用户会落到一个**空白页** ✗（这与浮层/返回键那类坑同源 ✓）。
//
// ⚠️ 断言只认"**调了哪个动作**"（mock 掉两个 store ✓），⛔ 不认文案细节（措辞会变 ✓）。

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  setManagerOpen: vi.fn(),
  desktop: vi.fn<() => boolean>(() => true),
}));

vi.mock("../store/editor", () => ({
  useEditorStore: { getState: () => ({ openSettings: mocks.openSettings }) },
}));
vi.mock("../store/plugins", () => ({
  usePlugins: { getState: () => ({ setManagerOpen: mocks.setManagerOpen }) },
}));
vi.mock("../lib/platform", () => ({
  platform: {},
  isDesktopPlatform: () => mocks.desktop(),
}));

import { getBuiltinCommands } from "./builtinCommands";

const find = (id: string) => getBuiltinCommands().find((c) => c.id === id);

beforeEach(() => {
  mocks.openSettings.mockClear();
  mocks.setManagerOpen.mockClear();
  mocks.desktop.mockReturnValue(true);
});

describe("命令面板里的「外部 AI 接入（MCP）」入口（第 4 招）", () => {
  it("★ 面板里有这一条，且标题里认得出 MCP", () => {
    const cmd = find("settings.mcp");
    expect(cmd, "命令面板里没有 MCP 这一条 ✗（Ctrl+K 搜不到 ⇒ 用户以为没这功能）").toBeTruthy();
    expect(cmd!.title).toMatch(/MCP/i);
  });

  it("★ 桌面版执行它 ⇒ 直接开到「外部 AI 接入」那一格", async () => {
    const cmd = find("settings.mcp")!;
    await cmd.run({ pages: [] } as never);
    expect(mocks.openSettings).toHaveBeenCalledWith("mcp");
  });

  it("★★ Web 版执行它 ⇒ **不许**开一个空页（那一格在 Web 版根本不存在 ✗）", async () => {
    mocks.desktop.mockReturnValue(false);
    const cmd = find("settings.mcp")!;
    const msg = await cmd.run({ pages: [] } as never);
    expect(mocks.openSettings, "Web 版被开进了一个空白设置页 ✗").not.toHaveBeenCalled();
    expect(String(msg).length).toBeGreaterThan(0); // 要**有一句话说清**为什么开不了 ✓
  });
});
