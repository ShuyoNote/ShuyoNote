// `McpAccessPane` **跨空间支持矩阵改版（2026-10-31）** 的判据。
//
// 钉住设计稿落地的五块：
//   ① 档位从 tab 改成**单选卡**（radiogroup/radio/aria-checked ＋ 风险标签 ＋ 选中态）
//   ② 「当前允许」摘要**由后端读数推导**、随档位变化（⛔ 不按档位写死句子）
//   ③ `groupScopes` 纯函数（分组 / all-spaces 优先 / 未知前缀进「其它」/ 空数组）
//   ④ 能力分类**计数自洽**（分类之和 === 注册表条数；「其它」桶显式渲染，不再藏）
//   ⑤ 能力筛选（全部 / 支持跨空间 / 不支持）的数字与渲染都从数据算
//   ⑥ 跨空间徽章数量与注册表一致（读/写/不支持三态各有）
//   ⑦ 连接状态卡（监听地址/复制、令牌指纹、最近一次外部调用、刷新在卡头、快捷入口）
//   ⑧ 分段导航锚点可达 ＋ 窄屏单列（纯 CSS，读样式文件断言 media query）
//
// ⚠️ 数字一律**从数据推导**（生成物 JSON / AI_TOOL_META），⛔ 不写字面量 ——
//    写死数字的判据在下一批能力变更时会立刻变成假话。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "../i18n";
import { AI_TOOL_META } from "../lib/capabilities/aiTools.meta";
import MCP_TOOLS_READ from "../../capabilities/mcp-tools.json";
import MCP_TOOLS_WRITE from "../../capabilities/mcp-tools-write.json";
import { groupScopes } from "./McpAccessPane";

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

// ---- 数据侧（独立口径：测试自己从生成物算，不复用组件的映射） ----
type CrossSpace = "read" | "write" | "none";
function stateOf(description: string, isWrite: boolean): CrossSpace {
  if (description.includes("跨空间：不支持")) return "none";
  if (!description.includes("跨空间：支持")) return "none";
  return isWrite ? "write" : "read";
}
const CROSS = new Map<string, CrossSpace>();
for (const t of MCP_TOOLS_READ) CROSS.set(t.capabilityId, stateOf(t.description, false));
for (const t of MCP_TOOLS_WRITE) CROSS.set(t.capabilityId, stateOf(t.description, true));
const COUNTS = { read: 0, write: 0, none: 0 };
for (const s of CROSS.values()) COUNTS[s] += 1;
const SUPPORT = COUNTS.read + COUNTS.write;

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
const STATUS_WRITE_ALL = {
  ...STATUS_OFF,
  enabled: true,
  running: true,
  port: 51234,
  token: "deadbeefdeadbeef",
  granted: ["read:pages", "read:all-spaces", "write:all-spaces", "export:files"],
  level: "write_all" as const,
  allow_write: true,
};
const STATUS_READ = {
  ...STATUS_OFF,
  enabled: true,
  running: true,
  port: 51234,
  token: "0123456789ab",
  granted: ["read:pages", "read:files", "read:backlinks"],
  level: "read" as const,
};

let root: ReturnType<typeof createRoot> | null = null;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  mocks.mcpStatus.mockReset();
  mocks.mcpStatus.mockResolvedValue(STATUS_OFF);
  mocks.mcpSetLevel.mockReset();
  mocks.mcpSetLevel.mockResolvedValue(STATUS_WRITE_ALL);
  mocks.mcpRotateToken.mockReset();
  mocks.mcpRotateToken.mockResolvedValue({ ...STATUS_WRITE_ALL, token: "cafebabe" });
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
const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
const radio = (label: string) => radios().find((r) => (r.textContent || "").includes(label)) as HTMLElement;
const allowOf = (key: string) =>
  document.querySelector<HTMLElement>(`[data-testid="mcp-allow-summary"] [data-allow="${key}"]`)?.textContent ?? "";

describe("跨空间支持矩阵改版（2026-10-31）", () => {
  it("① 六个档位是单选卡：radiogroup ＋ radio ＋ aria-checked，风险标签齐全且只有一个选中", async () => {
    mount();
    await tick();
    await tick();
    const group = document.querySelector('[role="radiogroup"]');
    expect(group, "档位容器必须是 radiogroup（设计稿要求单选卡片语义）").toBeTruthy();
    expect(radios().length, "六个档位都要渲染成单选卡").toBe(6);
    // 恰有一个选中，且与后端 level 一致（默认 off）
    const checked = radios().filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.length, "只能有一个 aria-checked=true").toBe(1);
    expect(checked[0].dataset.level).toBe(STATUS_OFF.level);
    expect(checked[0].className).toContain("is-on");
    // 每张卡都有风险标签（关/低/中/高），四种风险都出现（数据侧固定，⛔ 不按档位写死选中句子）
    const risks = radios().map((r) => r.dataset.risk);
    expect(risks.filter(Boolean).length).toBe(6);
    for (const want of ["off", "low", "mid", "high"]) {
      expect(risks, `风险档「${want}」至少出现一次`).toContain(want);
    }
  });

  it("② 点卡仍走同一个 mcp_set_level，且选中态跟着后端回读写", async () => {
    mount();
    await tick();
    await tick();
    flushSync(() => radio("只读（全部空间）").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(mocks.mcpSetLevel).toHaveBeenCalledWith("read_all");
    // 后端回 write_all ⇒ 界面按**后端**读数选中（不是本地乐观改）
    await tick();
    const checked = radios().filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(1);
    expect(checked[0].dataset.level).toBe("write_all");
  });

  it("③ 「当前允许」摘要由读数推导：关档=不读/不写/不导出，写全部空间档=读全/写全/导出", async () => {
    mount();
    await tick();
    await tick();
    // 关档：哪怕 granted 里还留着 read:pages，也一律"不读/不写/不导出"（通道关着）
    expect(allowOf("read")).toBe("不读");
    expect(allowOf("write")).toBe("不写");
    expect(allowOf("export")).toBe("不导出");
    expect(allowOf("token")).toContain("（无）");
    expect(document.body.textContent || "").toContain("加密空间内容不可见");

    // 写全部空间档（granted 含 read:all-spaces / write:all-spaces / export:files）
    mocks.mcpStatus.mockResolvedValue(STATUS_WRITE_ALL);
    flushSync(() => root!.unmount());
    mount();
    await tick();
    await tick();
    expect(allowOf("read")).toBe("读全部空间");
    expect(allowOf("write")).toBe("写全部空间");
    expect(allowOf("export")).toBe("导出文件句柄");
    expect(allowOf("token")).toBe(`令牌：…${STATUS_WRITE_ALL.token.slice(-4)}`);

    // 只读档：读当前空间 / 不写 / 不导出
    mocks.mcpStatus.mockResolvedValue(STATUS_READ);
    flushSync(() => root!.unmount());
    mount();
    await tick();
    await tick();
    expect(allowOf("read")).toBe("读当前空间");
    expect(allowOf("write")).toBe("不写");
    expect(allowOf("export")).toBe("不导出");
  });

  it("④ groupScopes：空输入五个组都空（⛔ 不抛错）", () => {
    const empty = groupScopes([]);
    expect(empty).toEqual({ read: [], write: [], export: [], allSpaces: [], other: [] });
    expect(groupScopes(null)).toEqual(empty);
    expect(groupScopes(undefined)).toEqual(empty);
  });

  it("⑤ groupScopes：read/write/export 分组正确、保序去重", () => {
    const g = groupScopes(["write:pages", "read:pages", "export:files", "read:files", "read:pages"]);
    expect(g.read).toEqual(["read:pages", "read:files"]);
    expect(g.write).toEqual(["write:pages"]);
    expect(g.export).toEqual(["export:files"]);
    expect(g.allSpaces).toEqual([]);
    expect(g.other).toEqual([]);
  });

  it("⑥ groupScopes：*-all-spaces 优先（read:all-spaces 进全部空间组，不被 read: 吃掉）", () => {
    const g = groupScopes(["read:all-spaces", "write:all-spaces", "read:pages"]);
    expect(g.allSpaces).toEqual(["read:all-spaces", "write:all-spaces"]);
    expect(g.read).toEqual(["read:pages"]);
    expect(g.write).toEqual([]);
  });

  it("⑦ groupScopes：未知前缀进「其它」组（⛔ 不静默丢）", () => {
    const g = groupScopes(["kv:own", "audit:tail", "", "  "]);
    expect(g.other).toEqual(["kv:own", "audit:tail"]);
    expect(g.read).toEqual([]);
    expect(g.write).toEqual([]);
    expect(g.export).toEqual([]);
    expect(g.allSpaces).toEqual([]);
  });

  it("⑧ 能力分类计数自洽：分类之和 === 注册表条数；「其它」桶显式渲染（不再藏）", async () => {
    mount();
    await tick();
    await tick();
    const cats = Array.from(document.querySelectorAll<HTMLElement>("[data-count]"));
    expect(cats.length, "八类 ＋ 其它一行都要在").toBeGreaterThanOrEqual(9);
    const sum = cats.reduce((n, el) => n + Number(el.dataset.count ?? 0), 0);
    expect(sum, "分类之和必须等于能力清单条数（旧版 58≠61 的 bug）").toBe(AI_TOOL_META.length);
    // 「其它」是显式一行（用独立属性，避免与 8 个注册表域混为一谈）
    const catchAll = document.querySelector<HTMLElement>("[data-domain-catchall]");
    expect(catchAll, "「其它」桶必须显式渲染").toBeTruthy();
    const catchAllCount = Number(catchAll!.dataset.count ?? 0);
    expect(catchAllCount, "「其它」桶不是空的（旧版这 3 项没渲染）").toBeGreaterThan(0);
    // 它列出的条目数 === 它的计数（分类之和自洽的另一半）
    expect(catchAll!.querySelectorAll("[data-cap-id]").length).toBe(catchAllCount);
    // 页面上的 cap 条目总数 === 注册表条数（折叠只影响样式，不影响 DOM 读数）
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
    expect(document.querySelector<HTMLElement>('[data-testid="mcp-cap-category-sum"]')?.dataset.sum).toBe(
      String(AI_TOOL_META.length),
    );
  });

  it("⑨ 能力筛选：全部 / 支持跨空间 / 不支持——数字与渲染都从数据算", async () => {
    mount();
    await tick();
    await tick();
    const btn = (key: string) => document.querySelector<HTMLElement>(`[data-filter="${key}"]`)!;
    expect(btn("all").textContent).toContain("全部");
    expect(btn("support").textContent, "支持跨空间的数字来自生成物").toContain(String(SUPPORT));
    expect(btn("none").textContent).toContain(String(COUNTS.none));
    // 默认全部：渲染 AI 工具全量
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
    // 只看不支持
    flushSync(() => btn("none").click());
    await tick();
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(COUNTS.none);
    // 只看支持跨空间
    flushSync(() => btn("support").click());
    await tick();
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(SUPPORT);
    // 回到全部
    flushSync(() => btn("all").click());
    await tick();
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
  });

  it("⑩ 跨空间徽章：每类各至少一条，三态数量与生成物一致（两列网格）", async () => {
    mount();
    await tick();
    await tick();
    const badge = (s: CrossSpace) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-crossspace="${s}"]`));
    for (const s of ["read", "write", "none"] as const) {
      expect(badge(s).length, `「${s}」这一类至少一条`).toBeGreaterThan(0);
      expect(badge(s).length, `「${s}」数量必须等于生成物算出来的 ${COUNTS[s]}`).toBe(COUNTS[s]);
    }
    expect(badge("read").length + badge("write").length + badge("none").length).toBe(AI_TOOL_META.length);
    // 两列网格：每个分类一个 `.mcp-cap-grid`
    expect(document.querySelectorAll(".mcp-cap-grid").length).toBeGreaterThan(0);
  });

  it("⑪ 可展开分类：点标题切换 aria-expanded，内容仍在 DOM（机器读数不随折叠漂）", async () => {
    mount();
    await tick();
    await tick();
    const heads = Array.from(document.querySelectorAll<HTMLElement>(".mcp-cap-cat-head"));
    expect(heads.length, "每个分类都要有可点的标题行").toBeGreaterThanOrEqual(9);
    const writeCat = heads.find((h) => (h.textContent || "").includes("写页面"))!;
    expect(writeCat.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => writeCat.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(writeCat.getAttribute("aria-expanded")).toBe("true");
    // 折叠与否都还在 DOM 里（旧判据按 DOM 读数）
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
  });

  it("⑫ 连接状态卡：监听地址＋复制、令牌指纹（不回显明文）、最近一次外部调用、刷新在卡头", async () => {
    const calledAt = Date.now() - 2 * 60_000;
    mocks.mcpStatus.mockResolvedValue(STATUS_WRITE_ALL);
    mocks.mcpRecentAudit.mockResolvedValue([
      { at: calledAt, tool: "pages_list", capabilityId: "pages.list", ok: true, code: null },
    ]);
    mount();
    await tick();
    await tick();
    // 监听地址 + 复制
    const addr = document.querySelector('[data-testid="mcp-listen-addr"]');
    expect(addr?.textContent).toBe("127.0.0.1:51234");
    flushSync(() =>
      document.querySelector<HTMLElement>('[data-testid="copy-listen"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await tick();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("127.0.0.1:51234");
    // 令牌：只显示指纹末 4 位，不回显明文
    const tokenEl = document.querySelector<HTMLElement>('[data-testid="mcp-token"]');
    expect(tokenEl?.dataset.fingerprint).toBe(STATUS_WRITE_ALL.token.slice(-4));
    expect(document.body.textContent || "").not.toContain(STATUS_WRITE_ALL.token);
    // 最近一次外部调用：由审计读数推导（含工具名；相对时间是粗粒度）
    const last = document.querySelector('[data-testid="mcp-last-call"]');
    expect(last?.textContent).toContain("pages_list");
    // 刷新在状态卡（卡头）里
    const refresh = document.querySelector<HTMLElement>('[data-testid="mcp-refresh"]');
    expect(refresh, "刷新按钮要在状态卡卡头").toBeTruthy();
    expect(refresh!.closest('[data-testid="mcp-stat-card"]')).toBeNull();
    expect(refresh!.parentElement?.className || "").toContain("mcp-status-head");
    // 快捷入口：最近草稿 / 最近审计 / AI 隐藏空间
    const shortcuts = Array.from(document.querySelectorAll<HTMLElement>("[data-shortcut]")).map(
      (el) => el.dataset.shortcut,
    );
    expect(shortcuts).toEqual(expect.arrayContaining(["drafts", "audit", "hidden"]));
  });

  it("⑬ granted 权限串分组 chips：读/写/全部空间/导出四组；未知前缀进「其它」；全部空间高亮", async () => {
    mocks.mcpStatus.mockResolvedValue({
      ...STATUS_WRITE_ALL,
      // 这组断言把 4+1 组都喂到
      granted: ["read:pages", "write:pages", "export:files", "read:all-spaces", "kv:own"],
    });
    mount();
    await tick();
    await tick();
    const group = (label: string) =>
      document.querySelector<HTMLElement>(`[data-scope-group="${label}"]`)!;
    for (const label of ["读", "写", "全部空间", "导出", "其它"]) {
      expect(group(label), `缺「${label}」分组`).toBeTruthy();
    }
    expect(group("读").textContent).toContain("read:pages");
    expect(group("写").textContent).toContain("write:pages");
    expect(group("导出").textContent).toContain("export:files");
    expect(group("其它").textContent, "未知前缀不静默丢").toContain("kv:own");
    const allChip = group("全部空间").querySelector<HTMLElement>('[data-granted="read:all-spaces"]')!;
    expect(allChip.className).toContain("is-all");
  });

  it("⑭ 分段导航：五个锚点都指到真实存在的区块（⛔ 不新增浮层）", async () => {
    mount();
    await tick();
    await tick();
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-nav]"));
    expect(links.length).toBe(5);
    for (const a of links) {
      const id = (a.getAttribute("href") || "").replace(/^#/, "");
      expect(id, "锚点必须有 href=#id").not.toBe("");
      expect(document.getElementById(id), `导航「${a.textContent}」的锚点 #${id} 不存在`).toBeTruthy();
    }
  });

  it("⑮ 窄屏单列：类名钩子 ＋ 样式文件里的 media query（纯 CSS，不改结构）", async () => {
    mount();
    await tick();
    await tick();
    expect(document.querySelector(".mcp-levels-grid"), "档位网格类必须在").toBeTruthy();
    expect(document.querySelector('[data-testid="mcp-stat-card"]')).toBeTruthy();
    // 样式文件路径用 cwd 相对（vitest 里 `import.meta.url` 不保证是 file: 协议）
    const css = readFileSync(resolve(process.cwd(), "src/styles/mcp-panel.css"), "utf8");
    expect(css, "≤900px 档位必须单列").toMatch(/@media \(max-width: 900px\)[\s\S]*?\.mcp-levels-grid[\s\S]*?grid-template-columns: 1fr/);
    expect(css, "窄屏状态卡也要单列").toMatch(/@media \(max-width: 720px\)[\s\S]*?\.mcp-stat-grid[\s\S]*?grid-template-columns: 1fr/);
  });

  it("⑯ 首屏接入引导：区块在、三步齐、**不要求选客户端**（五条常见路径直接列出）", async () => {
    mount();
    await tick();
    await tick();
    const block = document.querySelector('[data-testid="mcp-onboard"]');
    expect(block, "分段导航之后要有「接入外部 AI」引导块").toBeTruthy();
    // 三个步骤（按 data-step 序号）
    const steps = Array.from(document.querySelectorAll("[data-step]")).map((el) => el.getAttribute("data-step"));
    expect(steps).toEqual(["1", "2", "3"]);
    // ⛔ 2026-10-31（owner）：顶栏「如何接入」按钮去掉（引导本来就是首屏第一块，重复）；
    //    状态卡里的「客户端配置说明」快捷入口（data-shortcut="onboard"）仍在，指向同一个锚点。
    expect(document.querySelector('[data-testid="mcp-howto"]'), "顶栏「如何接入」不许再出现").toBeNull();
    expect(document.getElementById("mcp-sec-onboard")).toBeTruthy();
    expect(
      document.querySelector('[data-shortcut="onboard"]'),
      "状态卡里的「客户端配置说明」快捷入口应保留",
    ).toBeTruthy();
    // ⭐ 精简版：**没有**客户端选择 chips（片段通用 ⇒ 不必先选一次）；路径直接列出
    //    （A 批补到 5 个；owner 2026-10-31 又把自家两个 WorkBuddy / DeepSeek Harness 放最前 ⇒ 共 7 个）
    expect(block!.querySelectorAll("[data-client]").length, "不再要求选择客户端").toBe(0);
    const paths = Array.from(block!.querySelectorAll('[data-testid="mcp-config-path"]')).map((el) => el.textContent ?? "");
    expect(paths.length, "常见客户端路径直接并列（7 个，自家两个在前）").toBe(7);
    expect(paths[0], "① WorkBuddy 放最前").toContain(".workbuddy/mcp.json");
    expect(paths[1], "② DeepSeek Harness 紧随其后").toContain("cordis.patch.yml");
    expect(paths[2]).toContain("claude_desktop_config.json");
    expect(paths[3]).toContain(".cursor/mcp.json");
    expect(paths[4], "Claude Code 的 ~/.claude.json").toContain(".claude.json");
    expect(paths[5], "Windsurf 的 mcp_config.json").toContain(".codeium/windsurf/mcp_config.json");
    expect(paths[6], "VS Code 的用户级 mcp.json").toContain("Code\\User\\mcp.json");
    // ⭐ A 批（2026-10-31）：第 3 步改成「重启客户端（只需首次）」＋ 说清"以后换档/换令牌不用重启"；
    //    按钮改叫「刷新状态」，并如实写"连接数不统计"（后端确实不统计连接）。
    const step3 = block!.querySelector('[data-step="3"]')?.textContent ?? "";
    expect(step3, "第 3 步要写明「只需首次」").toContain("只需首次");
    expect(step3, "要写清换档/换令牌不用重启").toContain("不用重启");
    expect(step3, "按钮改叫「刷新状态」").toContain("刷新状态");
    expect(step3, "⛔ 不许再写「检测连接」").not.toContain("检测连接");
    // 「不统计连接数」写在按钮 title 里（kv 那行只在通道开启时才渲染"本机回环（连接数不统计）"，
    // 判据不能依赖运行时状态 ⇒ 认 title 这句）
    const detectTitle = block!.querySelector('[data-testid="mcp-detect"]')?.getAttribute("title") ?? "";
    expect(detectTitle, "如实说明不统计连接数").toContain("不统计连接数");
    // ⭐ 2026-10-31（owner 选 B）：默认片段是**随包**（command = 安装包里的 Rust 桥，零依赖零网络）；
    //    可切「npx」拿 5 行常量（需 Node 20+ 且联网）。判据把两种形态都钉住。
    const BRIDGE = "C:\\Program Files\\ShuyoNote\\mcp\\shuyonote-mcp.exe";
    mocks.mcpStatus.mockResolvedValue({ ...STATUS_WRITE_ALL, bridge_path: BRIDGE });
    mount();
    await tick();
    await tick();
    const snippet = document.querySelector('[data-testid="mcp-snippet"]')?.textContent ?? "";
    const def = JSON.parse(snippet).mcpServers.shuyonote;
    expect(def.command, "默认必须是随包桥（不需要 Node）").toBe(BRIDGE);
    expect(def.env, "随包形态不需要 env").toBeUndefined();
    const npxBtn = document.querySelector<HTMLElement>('[data-testid="snippet-mode-npx"]');
    expect(npxBtn, "要有「npx」切换按钮").toBeTruthy();
    flushSync(() => npxBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    const npx = JSON.parse(document.querySelector('[data-testid="mcp-snippet"]')?.textContent ?? "").mcpServers.shuyonote;
    expect(npx.command, "npx 形态是 command=npx").toBe("npx");
    expect(npx.args.join(" "), "npx 形态拉的是 tarball").toContain("https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz");
    expect(JSON.stringify(npx), "npx 形态不许出现本机盘符路径").not.toContain("C:\\\\");
    // 切回随包，别把状态留给下一条用例
    flushSync(() => document.querySelector<HTMLElement>('[data-testid="snippet-mode-bundled"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
  });

  it("⑰ 配置片段只有一份（引导块里）：复制配置写剪贴板的内容 = 现有 snippet", async () => {
    const BRIDGE = "C:\\Program Files\\ShuyoNote\\mcp\\shuyonote-mcp.exe";
    mocks.mcpStatus.mockResolvedValue({ ...STATUS_WRITE_ALL, bridge_path: BRIDGE });
    mount();
    await tick();
    await tick();
    const snippets = document.querySelectorAll('[data-testid="mcp-snippet"]');
    expect(snippets.length, "配置片段只允许出现一份（状态区不许再有第二份）").toBe(1);
    expect(
      document.querySelectorAll('[data-testid="mcp-stat-card"] [data-testid="mcp-snippet"]').length,
      "状态卡里不许再有 snippet",
    ).toBe(0);
    const copyBtn = document.querySelector<HTMLElement>('[data-testid="copy-config"]')!;
    expect(copyBtn.className).toContain("is-primary");
    flushSync(() => copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    let calls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    let wrote = calls[calls.length - 1]?.[0] as string;
    // 默认（随包）：复制到的就是页面上那份
    expect(wrote, "复制的就是页面上那份 snippet").toBe(snippets[0].textContent);
    expect(wrote).toContain("mcpServers");
    expect(JSON.parse(wrote).mcpServers.shuyonote.command).toBe(BRIDGE);
    // 切「npx」后复制：拿到的是 5 行常量形态
    flushSync(() =>
      document.querySelector<HTMLElement>('[data-testid="snippet-mode-npx"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await tick();
    flushSync(() => copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    calls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    wrote = calls[calls.length - 1]?.[0] as string;
    expect(JSON.parse(wrote).mcpServers.shuyonote.command).toBe("npx");
    expect(JSON.parse(wrote).mcpServers.shuyonote.args.join(" ")).toContain("https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz");
  });

  it("⑱ 令牌的复制/显示/换新只在引导块出现（状态区无重复按钮）", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_WRITE_ALL);
    mount();
    await tick();
    await tick();
    const buttons = () => Array.from(document.querySelectorAll<HTMLElement>("button"));
    const countText = (needle: string) => buttons().filter((b) => (b.textContent || "").includes(needle)).length;
    expect(countText("复制令牌"), "「复制令牌」只该有一颗").toBe(1);
    expect(countText("换一枚新令牌"), "「换一枚新令牌」只该有一颗").toBe(1);
    expect(buttons().filter((b) => (b.textContent || "") === "显示").length, "「显示」只该有一颗").toBe(1);
    // 状态卡里没有令牌动作
    const stat = document.querySelector('[data-testid="mcp-stat-card"]')!;
    expect(stat.querySelector('[data-testid="copy-token"]'), "状态卡里不许再有复制令牌").toBeNull();
    expect(stat.textContent || "", "状态卡里不该出现令牌正文/掩码").not.toContain("••••");
    // 令牌本体只在引导块里，且默认掩码、可点「显示」展开
    const tokenEl = document.querySelector<HTMLElement>('[data-testid="mcp-token"]')!;
    expect(tokenEl.closest('[data-testid="mcp-onboard"]')).toBeTruthy();
    expect(tokenEl.textContent).toContain("••••");
    expect(document.body.textContent || "").not.toContain(STATUS_WRITE_ALL.token);
  });

  it("⑲ 「刷新状态」会重新拉一次状态（＝refresh，不是只改本地提示）", async () => {
    mocks.mcpStatus.mockResolvedValue(STATUS_WRITE_ALL);
    mount();
    await tick();
    await tick();
    const before = mocks.mcpStatus.mock.calls.length;
    flushSync(() =>
      document.querySelector<HTMLElement>('[data-testid="mcp-detect"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await tick();
    await tick();
    expect(mocks.mcpStatus.mock.calls.length, "刷新状态必须真的重新查一次状态").toBeGreaterThan(before);
  });

  it("⑳ off 档位时引导块仍显示（不整块藏掉），并提示「先选一档权限」", async () => {
    // 默认 STATUS_OFF
    mount();
    await tick();
    await tick();
    const block = document.querySelector('[data-testid="mcp-onboard"]');
    expect(block, "off 档位下引导块也必须还在").toBeTruthy();
    expect(block!.textContent || "").toContain("先选一档权限");
    expect(document.querySelector('[data-testid="mcp-onboard-tip"]')).toBeTruthy();
    // 三步与客户端选择仍然可用（但配置按钮在 st 为空时禁用是另一件事）
    expect(document.querySelectorAll("[data-step]").length).toBe(3);
  });

  it("㉑ 能力分类默认**全部折叠**：只露「分类＋计数＋占比条」，点标题才展开（内容始终在 DOM）", async () => {
    mount();
    await tick();
    await tick();
    const cats = Array.from(document.querySelectorAll<HTMLElement>(".mcp-cap-category"));
    expect(cats.length, "八类 ＋ 其它一行").toBeGreaterThanOrEqual(9);
    // 默认全折叠（旧版第一类默认展开 ⇒ 一进来就是文字墙）
    for (const c of cats) expect(c.dataset.open, `「${c.textContent?.slice(0, 6)}」默认必须折叠`).toBe("false");
    for (const h of Array.from(document.querySelectorAll<HTMLElement>(".mcp-cap-cat-head"))) {
      expect(h.getAttribute("aria-expanded"), "折叠态 aria-expanded=false").toBe("false");
    }
    // 折叠态也显示占比条（长度随分类条数变）
    const bars = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mcp-cap-bar"]'));
    expect(bars.length, "每个分类都要有占比条").toBe(cats.length);
    expect(bars.every((b) => Number(b.dataset.ratio) > 0), "占比条 width > 0").toBe(true);
    // 折叠只改样式，不改 DOM 读数
    expect(document.querySelectorAll("[data-cap-id]").length).toBe(AI_TOOL_META.length);
    // 点第一类标题 ⇒ 展开；再点 ⇒ 收回
    const head = document.querySelector<HTMLElement>(".mcp-cap-cat-head")!;
    flushSync(() => head.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.closest<HTMLElement>(".mcp-cap-category")!.dataset.open).toBe("true");
    flushSync(() => head.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await tick();
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("㉒ 展开后的工具条目：描述**单行 + ellipsis**、徽章**固定列宽**；窄屏标题副标题各占一行", async () => {
    mount();
    await tick();
    await tick();
    const items = Array.from(document.querySelectorAll<HTMLElement>(".mcp-cap-item"));
    expect(items.length).toBe(AI_TOOL_META.length);
    expect(
      items.every((it) => it.querySelector(".mcp-cap-brief") && it.querySelector("[data-crossspace]")),
      "每条工具都要有描述与徽章",
    ).toBe(true);
    const css = readFileSync(resolve(process.cwd(), "src/styles/mcp-panel.css"), "utf8");
    const rule = (sel: string) => {
      const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m?.[1] ?? "";
    };
    const brief = rule(".mcp-cap-brief");
    expect(brief, "描述必须单行").toContain("white-space: nowrap");
    expect(brief, "描述必须省略号截断").toContain("text-overflow: ellipsis");
    expect(brief, "描述必须可压缩").toContain("overflow: hidden");
    const badge = rule(".mcp-cap-item .set-badge");
    expect(badge, "徽章必须固定列宽（换行不齐的修法）").toMatch(/flex:\s*0 0 96px|width:\s*96px/);
    // 窄屏：区块标题允许换行、副标题单独一行（不再把「接入外部 AI」拆开）
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*?\.mcp-title-hint[\s\S]*?flex:\s*1 0 100%/);
    expect(rule(".mcp-section-title")).toContain("flex-wrap: wrap");
  });
});
