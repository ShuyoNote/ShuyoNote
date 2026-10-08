// `McpAccessPane`（设置里的「外部 AI 接入」面）的判据 ✓
//
// ⭐ **R152（owner 2026-10-08 选 A）**：这里原来是**三颗开关**（接入／免确认／授权写 ✓），
//   现已换成**一个四档选择** ✓ —— 理由（结构问题 ✗）：②「免确认」与③「授权写入」不独立
//   （③ 关着 ⇒ 没有写工具 ⇒ ② 打开也毫无作用 ✗）、① 关着时 ②③ 是死 UI ✗ ⇒
//   真状态只有 4 个，却用 3 个布尔表达 ⇒ 一半组合是死的或骗人的 ✗。
// 这一节钉五件容易做错的事：
//   ① 档位初始必须反映**后端**读数（`st.level` ✓，界面不自己推断 ✗）；
//   ② 点档位必须真的调 `mcp_set_level`（不是只改本地 state ✗ —— 那会做出"看着切了、其实没切"的假控件 ✗）；
//   ③ **旧的三颗开关必须消失** ✗（`[role="switch"]` 与 `.ui-toggle` 一个都不许再有 ✓）；
//   ④ 「换一枚新令牌」必须调 `mcp_rotate_token` ✓；
//   ⑤ 给 agent 的配置片段里必须是**后端给的路径**（令牌/端口文件 ✓），且能被复制 ✓。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 面板只通过 `api` 与后端说话 ⇒ 这里给四个桩（并记录调用 ✓）。
const mocks = vi.hoisted(() => ({
  mcpStatus: vi.fn(),
  mcpSetEnabled: vi.fn(),
  mcpSetLevel: vi.fn(),
  mcpRotateToken: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  api: {
    mcpStatus: mocks.mcpStatus,
    mcpSetEnabled: mocks.mcpSetEnabled,
    mcpSetLevel: mocks.mcpSetLevel,
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
  level: "off" as const,
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
  granted: ["read:pages", "read:files", "read:backlinks", "write:pages"],
  level: "write_auto" as const,
};

let root: ReturnType<typeof createRoot> | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  mocks.mcpStatus.mockReset();
  mocks.mcpSetEnabled.mockReset();
  mocks.mcpSetLevel.mockReset();
  mocks.mcpRotateToken.mockReset();
  mocks.mcpStatus.mockResolvedValue(STATUS_OFF);
  mocks.mcpSetEnabled.mockResolvedValue(STATUS_ON);
  mocks.mcpSetLevel.mockResolvedValue(STATUS_ON);
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
const tabs = () => Array.from(document.querySelectorAll<HTMLElement>(".ai-settings-tab"));
const tab = (label: string) => tabs().find((t) => (t.textContent || "").includes(label)) as HTMLElement;

describe("McpAccessPane：外部 AI 接入的档位面", () => {
  it("★ 初始档位来自后端读数：默认「不接」⇒ 那颗选中、状态行说「已关闭」", async () => {
    mount();
    await tick();
    await tick();
    expect(mocks.mcpStatus).toHaveBeenCalled();
    expect(tabs().length, "四个档位都要在").toBe(4);
    const on = tabs().filter((t) => t.className.includes("is-on"));
    expect(on.length, "只能有一个选中").toBe(1);
    expect(on[0].textContent).toContain("不接");
    expect(document.body.textContent).toContain("已关闭");
  });

  it("★ 点档位真的调 `mcp_set_level`（不是只改本地 state ✗）", async () => {
    mount();
    await tick();
    await tick();
    flushSync(() => tab("只读").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpSetLevel).toHaveBeenCalledWith("read");
    // 后端回了新状态 ⇒ 界面必须跟着后端走（状态行说清"只绑本机 ＋ 端口" ✓）
    await tick();
    expect(document.body.textContent).toContain("127.0.0.1:51234");
  });

  // ⭐ R152：**旧的三颗开关必须消失** ✗ —— 这条判据专门钉住"别又长回开关形状" ✓。
  it("★ 旧的三颗开关消失 ✗，且选中档位与后端 `level` 一致 ✓", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_ON);
    mount();
    await tick();
    await tick();
    expect(document.querySelectorAll('[role="switch"]').length, "不许再有开关 ✗").toBe(0);
    expect(document.querySelectorAll(".ui-toggle").length, "不许再有 ui-toggle ✗").toBe(0);
    const on = tabs().filter((t) => t.className.includes("is-on"));
    expect(on.length, "只能有一个选中").toBe(1);
    expect(on[0].textContent, "`level=write_auto` ⇒ 选中的必须是「可写（免确认）」✓").toContain("免确认");
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

  it("★ 四档的文案必须说全（每档讲清「要不要问」＋ 免确认必留痕），⛔ 不许再说成只读", async () => {
    // 口径（R152）：**每个档位的说明只在它被选中时显示** ✓ ⇒ 判据要"逐档看"，
    // 而不是"整页搜关键词" ✗（那会漏掉"切过去之后文案对不对" ✓）。
    mount();
    await tick();
    await tick();
    // 默认「不接」那一档的说明：既不读也不写 ✓
    expect(document.body.textContent).toContain("既不读也不写");
    // 四档标签都在 ✓（这就是"用户看得见的全部选择" ✓）
    const labels = tabs().map((t) => t.textContent || "").join(" ｜ ");
    for (const l of ["不接", "只读", "可写（每次确认）", "可写（免确认）"]) {
      expect(labels, `缺档位「${l}」✗`).toContain(l);
    }
    // ⭐ 切到「可写（免确认）」⇒ 那一档的说明必须**立刻**说清：直接落库 ＋ 每一次写仍留一行审计 ✓
    mocks.mcpStatus.mockResolvedValue(STATUS_ON);
    flushSync(() => root!.unmount());
    mount();
    await tick();
    await tick();
    const text = document.body.textContent || "";
    expect(text).toContain("直接落库");
    expect(text).toContain("每一次写仍会留一行审计");
    // ⛔ 文案不许再说成"只读"（那是过期的那一版 ✗）
    expect(text).not.toContain("只读（列页面");
  });
});
