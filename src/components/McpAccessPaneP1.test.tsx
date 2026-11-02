// `McpAccessPane`（设置里的「外部 AI 接入」面）的 P1 判据。
//
// P1（2026-10-30）改版为「接入面板」六块。这里钉住：
//   ① 六档渲染（含「可写（全部空间）」）② 切 write_all 调的 level 值正确
//   ③ 能力清单条目数 = 注册表 ai:true 数（防文案再漂移）④ 草稿/审计空态
//   ⑤ token 默认脱敏（不完整显示），点「显示」才展开
//   另保留旧判据里仍成立的：档位来自后端读数、旧开关消失、配置片段用后端路径、
//   复制配置是主按钮、换令牌可用、界面不出现评审记号。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";
import { AI_TOOL_META } from "../lib/capabilities/aiTools.meta";

const mocks = vi.hoisted(() => ({
  mcpStatus: vi.fn(),
  mcpSetLevel: vi.fn(),
  mcpRotateToken: vi.fn(),
  mcpRecentDrafts: vi.fn(),
  mcpRecentAudit: vi.fn(),
  mcpHiddenSpacesGet: vi.fn(),
  mcpHiddenSpacesSet: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: mocks }));

import { McpAccessPane } from "./McpAccessPane";

const STATUS_OFF = {
  enabled: false,
  running: false,
  port: null as number | null,
  token: null as string | null,
  granted: ["read:pages"],
  level: "off" as const,
  allow_write: false,
  env_override: false,
  config_path: "/data/mcp/config.json",
  token_path: "/data/mcp/token",
  port_path: "/data/mcp/port",
  bridge_path: null as string | null,
};
const STATUS_ON = {
  ...STATUS_OFF,
  enabled: true,
  running: true,
  port: 51234,
  token: "deadbeefdeadbeef",
  granted: ["read:pages", "read:files", "read:backlinks", "write:pages"],
  level: "write_auto" as const,
};

let root: ReturnType<typeof createRoot> | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  mocks.mcpStatus.mockReset();
  mocks.mcpSetLevel.mockReset();
  mocks.mcpRotateToken.mockReset();
  mocks.mcpRecentDrafts.mockReset();
  mocks.mcpRecentAudit.mockReset();
  mocks.mcpStatus.mockResolvedValue(STATUS_OFF);
  mocks.mcpSetLevel.mockResolvedValue(STATUS_ON);
  mocks.mcpRotateToken.mockResolvedValue({ ...STATUS_ON, token: "cafebabe" });
  mocks.mcpRecentDrafts.mockResolvedValue([]);
  mocks.mcpRecentAudit.mockResolvedValue([]);
  mocks.mcpHiddenSpacesGet.mockResolvedValue({ spaceIds: [] });
  mocks.mcpHiddenSpacesSet.mockResolvedValue({ spaceIds: [] });
  mocks.listWorkspaces.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});
function mount() {
  root = createRoot(document.getElementById("host")!);
  flushSync(() => root!.render(React.createElement(McpAccessPane)));
}
// 2026-10-31（跨空间支持矩阵改版）：档位从横向 tab 改成**单选卡**（`role="radiogroup"` +
// `role="radio"` + `aria-checked`，见设计稿）；判据的**语义不变**（六个档位都在、只有一个选中、
// 选中项来自后端 `level`、点击走同一个 `mcp_set_level`）——只把取值钩子从 `role="tab"`
// 换成 `role="radio"`（`is-on` 类保留）。
const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
const tab = (label: string) => tabs().find((t) => (t.textContent || "").includes(label)) as HTMLElement;

describe("MCP 接入面板（P1）", () => {
  it("① 六档渲染（含「可写（全部空间）」），初始档位来自后端", async () => {
    mount();
    await tick();
    await tick();
    expect(tabs().length, "六个档位都要在").toBe(6);
    expect(tab("可写（全部空间）")).toBeTruthy();
    const on = tabs().filter((t) => t.className.includes("is-on"));
    expect(on.length).toBe(1);
    expect(on[0].textContent).toContain("不接");
    expect(document.body.textContent).toContain("已关闭");
    expect(document.querySelectorAll('[role="switch"]').length).toBe(0);
  });

  it("② 切「可写（全部空间）」⇒ 调 mcp_set_level('write_all')", async () => {
    mount();
    await tick();
    await tick();
    flushSync(() => tab("可写（全部空间）").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpSetLevel).toHaveBeenCalledWith("write_all");
  });

  it("③ 能力清单条目数 = 注册表 ai:true 数（能力清单来自注册表，不手写）", async () => {
    mount();
    await tick();
    await tick();
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
    expect(document.querySelectorAll("[data-domain]").length).toBe(8);
  });

  it("④ 草稿/审计空态", async () => {
    mount();
    await tick();
    await tick();
    expect(document.querySelector('[data-testid="mcp-drafts"]')?.textContent).toContain("暂无草稿");
    expect(document.querySelector('[data-testid="mcp-audit"]')?.textContent).toContain("暂无审计");
  });

  it("⑤ token 默认脱敏（不完整显示），点「显示」才展开", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_ON);
    mount();
    await tick();
    await tick();
    const text = () => document.body.textContent || "";
    expect(text()).not.toContain("deadbeefdeadbeef");
    expect(text()).toContain("••••");
    const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "") === "显示") as HTMLElement;
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(text()).toContain("deadbeefdeadbeef");
  });

  it("保留：默认配置片段用后端给的桥路径（随包形态）、复制配置是主按钮、换令牌仍可用", async () => {
    mocks.mcpStatus.mockResolvedValue({ ...STATUS_ON, bridge_path: "C:\\Program Files\\ShuyoNote\\mcp\\shuyonote-mcp.exe" });
    mount();
    await tick();
    await tick();
    // C1/B 之后默认是「随包」：command 就是安装包里的桥，**没有 env/args**
    const snippet = document.querySelector(".mcp-access-snippet")?.textContent || "";
    const cfg = JSON.parse(snippet);
    expect(cfg.mcpServers.shuyonote.command, "默认片段要用后端给的桥路径").toContain("shuyonote-mcp.exe");
    expect(cfg.mcpServers.shuyonote.env, "随包形态不需要 env").toBeUndefined();
    const primary = document.querySelector('[data-testid="copy-config"]') as HTMLElement;
    expect(primary.className).toContain("is-primary");
    expect(primary.textContent).toContain("复制配置");
    const rotate = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("换一枚新令牌")) as HTMLElement;
    flushSync(() => rotate.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpRotateToken).toHaveBeenCalled();
  });

  it("界面文本里不出现评审记号（** / ✓ / ✗ / ⛔）", async () => {
    mount();
    await tick();
    await tick();
    const text = document.body.textContent || "";
    for (const mark of ["**", "✓", "✗", "⛔"]) expect(text.includes(mark)).toBe(false);
  });

  it("隐藏清单：回读勾选、保存后回读仍勾选", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_ON);
    mocks.listWorkspaces.mockResolvedValue([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    mocks.mcpHiddenSpacesGet.mockResolvedValue({ spaceIds: ["a"] });
    mount();
    await tick();
    const box = (label: string) =>
      document.querySelector('input[aria-label="隐藏空间 ' + label + '"]') as HTMLInputElement;
    await vi.waitFor(() => {
      expect(box("A")?.checked).toBe(true);
      expect(box("B")?.checked).toBe(false);
    });
    flushSync(() => box("B").click());
    mocks.mcpHiddenSpacesSet.mockResolvedValue({ spaceIds: ["a", "b"] });
    mocks.mcpHiddenSpacesGet.mockResolvedValue({ spaceIds: ["a", "b"] });
    const save = document.querySelector('[data-testid="mcp-hidden-save"]') as HTMLElement;
    flushSync(() => save.click());
    await vi.waitFor(() => expect(mocks.mcpHiddenSpacesSet).toHaveBeenCalledWith(["a", "b"]));
    flushSync(() => root!.unmount());
    root = createRoot(document.getElementById("host")!);
    flushSync(() => root!.render(React.createElement(McpAccessPane)));
    await vi.waitFor(() => {
      expect(box("A")?.checked).toBe(true);
      expect(box("B")?.checked).toBe(true);
    });
  });
});
