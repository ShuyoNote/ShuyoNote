// `McpAccessPane`（设置里的「外部 AI 接入」开关面）的判据 ✓
//
// 为什么要有它：owner 2026-10-06 拍板「**设置里必须有开关 ＋ 可见状态**」（R89 ✓）——
// 这一节是那个开关面，界面**不自己推断**状态（一切来自后端 `mcp_status` ✓）。
// 这里钉四件容易做错的事：
//   ① 开关初始必须反映**后端**的读数（默认关 ⇒ `aria-checked=false` ✓）；
//   ② 点开关必须真的调 `mcp_set_enabled`（不是只改本地 state ✗ —— 那会做出一个"看着开了、其实没开"的假开关 ✗）；
//   ③ 「换一枚新令牌」必须调 `mcp_rotate_token` ✓；
//   ④ 给 agent 的配置片段里必须是**后端给的路径**（令牌/端口文件 ✓），且能被复制 ✓。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 面板只通过 `api` 与后端说话 ⇒ 这里给三个桩（并记录调用 ✓）。
const mocks = vi.hoisted(() => ({
  mcpStatus: vi.fn(),
  mcpSetEnabled: vi.fn(),
  mcpRotateToken: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  api: {
    mcpStatus: mocks.mcpStatus,
    mcpSetEnabled: mocks.mcpSetEnabled,
    mcpRotateToken: mocks.mcpRotateToken,
  },
}));

import { McpAccessPane } from "./McpAccessPane";

const STATUS_OFF = {
  enabled: false,
  running: false,
  port: null as number | null,
  token: null as string | null,
  granted: ["read:pages"],
  env_override: false,
  config_path: "/data/mcp/config.json",
  token_path: "/data/mcp/token",
  port_path: "/data/mcp/port",
};
const STATUS_ON = {
  ...STATUS_OFF,
  enabled: true,
  running: true,
  port: 51234,
  token: "deadbeefdeadbeef",
};

let root: ReturnType<typeof createRoot> | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  mocks.mcpStatus.mockReset();
  mocks.mcpSetEnabled.mockReset();
  mocks.mcpRotateToken.mockReset();
  mocks.mcpStatus.mockResolvedValue(STATUS_OFF);
  mocks.mcpSetEnabled.mockResolvedValue(STATUS_ON);
  mocks.mcpRotateToken.mockResolvedValue({ ...STATUS_ON, token: "cafebabe" });
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
  const host = document.getElementById("host")!;
  root = createRoot(host);
  flushSync(() => root!.render(React.createElement(McpAccessPane)));
}

describe("McpAccessPane：外部 AI 接入的开关面", () => {
  it("★ 初始状态来自后端读数：默认关 ⇒ 开关是关的、状态行说「已关闭」", async () => {
    mount();
    await tick();
    await tick();
    const sw = document.querySelector('[role="switch"]') as HTMLElement;
    expect(sw, "要有那个开关").not.toBeNull();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("已关闭");
    expect(mocks.mcpStatus).toHaveBeenCalled();
  });

  it("★ 点开关真的调 `mcp_set_enabled(true)`（不是只改本地 state ✗）", async () => {
    mount();
    await tick();
    await tick();
    const sw = document.querySelector('[role="switch"]') as HTMLElement;
    flushSync(() => sw.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpSetEnabled).toHaveBeenCalledWith(true);
    // 打开之后状态行必须说清"只绑本机 ＋ 端口" ✓
    await tick();
    expect(document.body.textContent).toContain("127.0.0.1:51234");
  });

  it("★ 「换一枚新令牌」调 `mcp_rotate_token` ✓", async () => {
    mount();
    await tick();
    await tick();
    const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("换一枚新令牌")) as HTMLElement;
    expect(btn, "要有换令牌那颗按钮").toBeTruthy();
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpRotateToken).toHaveBeenCalled();
  });

  it("★ 配置片段里是**后端给的**两个文件路径（令牌/端口 ✓），复制按钮真的复制", async () => {
    mount();
    await tick();
    await tick();
    const snippet = document.querySelector(".mcp-access-snippet")?.textContent || "";
    expect(snippet).toContain("SHUYONOTE_MCP_TOKEN_FILE");
    expect(snippet).toContain("SHUYONOTE_MCP_PORT_FILE");
    expect(snippet).toContain("/data/mcp/token");
    expect(snippet).toContain("/data/mcp/port");
    const copyBtn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("复制配置")) as HTMLElement;
    flushSync(() => copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("SHUYONOTE_MCP_TOKEN_FILE"));
  });
});
