// `McpAccessPane` 的**跨空间支持矩阵**判据（2026-10-30，B1d）。
//
// 钉住三件事：
//   ① 能力清单每一条都有一个跨空间徽章，且**三态口径与生成物一致**（逐条比对，不信组件自己说的）；
//   ② 顶部统计行的三个数字 = 从生成物算出来的数（⛔ 组件里不许硬编码；这里也不写字面量）；
//   ③ 三类各至少渲染一条，且类名映射是「读=绿(is-ok)／写=橙(is-warn)／不支持=灰(不带颜色 modifier)」。
//
// ⚠️ 数据的"独立口径"：本测试**自己**从 `capabilities/mcp-tools*.json` 的 `description` 里
//    解析 `跨空间：` 那一行（不复用组件的解析函数）—— 复用同一个函数只能证明它自洽，
//    证明不了它把"读/写/不支持"分对了。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";
import { AI_TOOL_META } from "../lib/capabilities/aiTools.meta";
import MCP_TOOLS_READ from "../../capabilities/mcp-tools.json";
import MCP_TOOLS_WRITE from "../../capabilities/mcp-tools-write.json";

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

type CrossSpace = "read" | "write" | "none";

/** 独立解析：只认生成物那行统一文案；没有那行 ⇒ 不支持（与组件同一条防呆口径）。 */
function expectedStateOf(description: string, isWrite: boolean): CrossSpace {
  if (description.includes("跨空间：不支持")) return "none";
  if (!description.includes("跨空间：支持")) return "none";
  return isWrite ? "write" : "read";
}

const EXPECTED = new Map<string, CrossSpace>();
for (const t of MCP_TOOLS_READ) EXPECTED.set(t.capabilityId, expectedStateOf(t.description, false));
for (const t of MCP_TOOLS_WRITE) EXPECTED.set(t.capabilityId, expectedStateOf(t.description, true));

const EXPECTED_COUNTS: Record<CrossSpace, number> = { read: 0, write: 0, none: 0 };
for (const s of EXPECTED.values()) EXPECTED_COUNTS[s] += 1;

const STATUS = {
  enabled: true,
  running: true,
  port: 51234,
  token: "deadbeef",
  granted: ["read:pages", "write:pages"],
  level: "write_auto" as const,
  allow_write: true,
  env_override: false,
  config_path: "/data/mcp/config.json",
  token_path: "/data/mcp/token",
  port_path: "/data/mcp/port",
  bridge_path: null as string | null,
};

let root: ReturnType<typeof createRoot> | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  mocks.mcpStatus.mockReset();
  mocks.mcpStatus.mockResolvedValue(STATUS);
  mocks.mcpSetLevel.mockReset();
  mocks.mcpRotateToken.mockReset();
  mocks.mcpRecentDrafts.mockReset();
  mocks.mcpRecentDrafts.mockResolvedValue([]);
  mocks.mcpRecentAudit.mockReset();
  mocks.mcpRecentAudit.mockResolvedValue([]);
  mocks.mcpHiddenSpacesGet.mockReset();
  mocks.mcpHiddenSpacesGet.mockResolvedValue({ spaceIds: [] });
  mocks.mcpHiddenSpacesSet.mockReset();
  mocks.mcpHiddenSpacesSet.mockResolvedValue({ spaceIds: [] });
  mocks.listWorkspaces.mockReset();
  mocks.listWorkspaces.mockResolvedValue([]);
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

describe("MCP 接入面板 · 跨空间支持矩阵", () => {
  it("① 每条工具一个徽章，三态与生成物逐条一致（⛔ 不是组件自说自话）", async () => {
    mount();
    await tick();
    await tick();
    // 数据前提：两份生成物的 id 集合合起来正好是能力清单那 61 条（否则下面的逐条比对会漏）
    expect(EXPECTED.size, "两份 MCP 生成物合起来必须与 AI 工具清单逐一对上").toBe(
      AI_TOOL_META.length,
    );
    expect(MCP_TOOLS_READ.length + MCP_TOOLS_WRITE.length).toBe(EXPECTED.size);

    const badges = Array.from(document.querySelectorAll<HTMLElement>("[data-crossspace]"));
    expect(badges.length, "每条能力都要有一个跨空间徽章").toBe(AI_TOOL_META.length);

    // 逐条：条目 data-cap-id 上的徽章 = 独立解析出来的那个态
    const mismatched: string[] = [];
    for (const li of Array.from(document.querySelectorAll<HTMLElement>("[data-cap-id]"))) {
      const id = li.dataset.capId ?? "";
      const badge = li.querySelector<HTMLElement>("[data-crossspace]");
      const got = badge?.dataset.crossspace;
      const want = EXPECTED.get(id);
      if (want === undefined || got !== want) mismatched.push(`${id}: 显示 ${got} / 数据 ${want}`);
    }
    expect(mismatched, "这些条目的徽章与生成物不一致：\n" + mismatched.join("\n")).toEqual([]);
  });

  it("② 顶部统计行的三个数字由数据算（读/写/不支持），且总数 = 清单条数", async () => {
    mount();
    await tick();
    await tick();
    const el = document.querySelector<HTMLElement>('[data-testid="mcp-crossspace-stats"]');
    expect(el, "能力清单块顶部要有跨空间统计行").toBeTruthy();

    // 三个数都==从生成物算出来的；⛔ 组件里写死的话这里会红
    expect(el!.dataset.read).toBe(String(EXPECTED_COUNTS.read));
    expect(el!.dataset.write).toBe(String(EXPECTED_COUNTS.write));
    expect(el!.dataset.none).toBe(String(EXPECTED_COUNTS.none));
    expect(el!.textContent).toContain(
      `跨空间：读 ${EXPECTED_COUNTS.read} · 写 ${EXPECTED_COUNTS.write} · 不支持 ${EXPECTED_COUNTS.none}`,
    );
    expect(EXPECTED_COUNTS.read + EXPECTED_COUNTS.write + EXPECTED_COUNTS.none).toBe(
      AI_TOOL_META.length,
    );
  });

  it("③ 三类徽章各至少一条；类名映射＝读绿(is-ok)／写橙(is-warn)／不支持灰", async () => {
    mount();
    await tick();
    await tick();
    const byState = (s: CrossSpace) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-crossspace="${s}"]`));
    for (const s of ["read", "write", "none"] as const) {
      expect(byState(s).length, `「${s}」这一类至少要渲染出一条`).toBeGreaterThan(0);
    }
    for (const b of byState("read")) {
      expect(b.className).toContain("set-badge");
      expect(b.className).toContain("is-ok");
      expect(b.textContent).toBe("跨空间·读");
    }
    for (const b of byState("write")) {
      expect(b.className).toContain("set-badge");
      expect(b.className).toContain("is-warn");
      expect(b.textContent).toBe("跨空间·写");
    }
    for (const b of byState("none")) {
      expect(b.className).toContain("set-badge");
      expect(b.className, "不支持的徽章不带任何颜色 modifier（灰）").not.toContain("is-ok");
      expect(b.className).not.toContain("is-warn");
      expect(b.textContent).toBe("跨空间·不支持");
    }
  });
});
