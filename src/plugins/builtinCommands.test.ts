// **命令面板里不该出现"必然失败"的入口。**
//
// 背景（2026-09 发布 1.86.0 时发现的）：`CommandMap` / `api` / 命令面板都声明了
// `export_wiki`，而桌面 Rust 侧**根本没有这条命令**——静态 HTML wiki 导出只有在 web 平台
// 实现。结果：桌面用户在命令面板点「导出当前空间为 wiki」只会得到
// `command export_wiki not found`。同类问题还有一个 `approve_plugin`（插件被暂停后的
// 「重新确认」按钮），那条是补上 Rust 命令修掉的。
//
// `scripts/check-web-commands.mjs` 现在会拦"CommandMap 有、Rust 没注册"（web 专属的必须
// 显式登记并说明理由），这个测试则钉住**调用点真的按平台收口了**——门禁只能证明"我们知道
// 它是 web 专属"，证明不了"界面上不会露出来"。
import { describe, expect, it, afterEach } from "vitest";
import { getBuiltinCommands } from "./builtinCommands";

const WIKI = "export.workspace-wiki";

/** 模拟运行平台：`isDesktopPlatform()` 看的就是 window 上有没有 Tauri 注入的标记。 */
function pretend(platform: "desktop" | "web") {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (platform === "desktop") w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe("内置命令的平台收口", () => {
  afterEach(() => pretend("web"));

  it("web 平台：wiki 导出在（那边真有这条命令）", () => {
    pretend("web");
    expect(getBuiltinCommands().some((c) => c.id === WIKI)).toBe(true);
  });

  it("桌面平台：wiki 导出不出现（Rust 侧没有这条命令，露出来就是一条必然失败的入口）", () => {
    pretend("desktop");
    expect(getBuiltinCommands().some((c) => c.id === WIKI)).toBe(false);
  });

  it("两端都有的命令不受影响", () => {
    pretend("desktop");
    const desktop = getBuiltinCommands().map((c) => c.id);
    pretend("web");
    const web = getBuiltinCommands().map((c) => c.id);
    // 桌面端应有实际内容（不是"整组都被 when 关掉"这种假绿）
    expect(desktop.length).toBeGreaterThan(10);
    expect(desktop.filter((id) => id !== WIKI)).toEqual(web.filter((id) => id !== WIKI));
  });
});
