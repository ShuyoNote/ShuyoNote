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

  // ⭐ 2026-10-06（owner 截图问「开关按钮不对劲吧？」✓）：这颗开关有**两条视觉契约**，
  //    我两条都没照做 ✗ —— ① "开"的类名是 **`on`**（`is-on` 这个类名**不存在** ✗）；
  //    ② 必须带 `.ui-toggle-knob` 子元素（那个圆钮 ✓，没有它就只剩一颗空胶囊 ✗）。
  //    ⇒ 这条判据专门钉住它（以后谁再改回 `is-on`／丢了 knob ⇒ 当场红 ✓）。
  it("★ 开关必须用本仓那套契约：开 ⇒ 类名 `on`，并且真的带一个圆钮子元素", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_ON);
    mount();
    await tick();
    await tick();
    const sw = document.querySelector('[role="switch"]') as HTMLElement;
    expect(sw, "要有那个开关").not.toBeNull();
    expect(sw.className, "开着的开关必须有 `on` 类（不是 is-on ✗）").toContain("on");
    expect(sw.className, "`is-on` 这个类名在本仓不存在 ⇒ 用了它开关就没有「开着」的样子").not.toContain("is-on");
    expect(sw.querySelector(".ui-toggle-knob"), "开关里必须有圆钮 `.ui-toggle-knob`（少了它就是一颗空胶囊 ✗）").not.toBeNull();
    // 第二颗（免确认）同一套契约 ✓
    const all = Array.from(document.querySelectorAll('[role="switch"]')) as HTMLElement[];
    expect(all.length, "面板里有两颗开关").toBe(2);
    for (const t of all) expect(t.querySelector(".ui-toggle-knob")).not.toBeNull();
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

  it("★ 面板必须把「写」这件事说全（默认要确认 ＋ 免确认必留痕），⛔ 不许再说成只读", async () => {
    mount();
    await tick();
    await tick();
    const text = document.body.textContent || "";
    // 这一条是防"文案过期"的：M2 之后外部 AI 也能提改动 ⇒ 面板说"只读"就是骗人 ✗
    expect(text).toContain("待你确认");
    expect(text).toContain("每一次写都会留一行审计");
    expect(text).toContain("免确认");
    expect(text).not.toContain("只读（列页面");
  });
});
