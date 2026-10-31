// MCP 接入面板（P2 改版 —— 「跨空间支持矩阵」设计稿，2026-10-31）。
//
// 结构（对应设计稿的五块）：
//   ① 权限档位：六张**单选卡**（`role="radiogroup"` + `role="radio"`，风险标签、选中卡下方「当前允许」摘要）
//   ② 能力：分类可展开（两列网格：工具名 ＋ 跨空间徽章）、筛选（全部 / 支持跨空间 / 不支持）、
//      分类计数**必须自洽**（分类之和 === 注册表条数；没有域归属的显式进「其它」）
//   ③ 状态：连接状态卡（监听地址／令牌指纹／最近一次外部调用／连接、刷新在卡头、快捷入口）
//   ④ 审计：最近草稿 / 最近审计（原样两块，快捷入口滚动定位）
//   ⑤ 隐藏空间：AI 不可见空间清单（原样）
// 另：面板顶部分段导航（锚点滚动，⛔ 不新增浮层）；窄屏纵向堆叠。
//
// ⚠️ 样式纪律（本版）：**不改 `src/App.css`** —— 新样式全部写在 `src/styles/mcp-panel.css`
//   （使用既有 CSS 变量 `--text/--border/--hover/--surface/--card-bg/--accent/--warning/…`）。
//   既有类（`set-section` / `set-row-sub` / `set-hint` / `set-btn` / `set-badge` /
//   `mcp-access-token` / `mcp-access-snippet` / `ai-settings-tab`）继续复用（后者只作为测试/兼容钩子，
//   视觉由新文件里的 `.mcp-level-card` 覆盖）。
//
// ⚠️ 数据纪律：能力清单、跨空间三态、`granted` 分组**全部由生成物/后端读数推导**，
//   ⛔ 不在组件里写死"哪些工具支持跨空间"或"这一档能做什么"。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { AI_TOOL_META } from "../lib/capabilities/aiTools.meta";
import { toast } from "../store/toast";
import type { McpStatus } from "../types";
// ⭐ 跨空间徽章的**数据源**：MCP 面两份生成物（`gen-capabilities.mjs` 从同一份
//   `capabilities/capabilities.json` 生成，与 `AI_TOOL_META` 同源）。每条 `description`
//   末尾有一行统一的 `跨空间：支持（带 spaceId 读/写到指定空间）` 或 `跨空间：不支持（…）`。
//   ⛔ 本文件**不另写"哪些工具支持跨空间"的清单**（那会漂）；只解析这一行。
//   ⚠️ `AI_TOOL_META` 的 desc 没有这行（它给的是插件作者视角的能力说明）⇒ 必须读这两份。
import MCP_TOOLS_READ from "../../capabilities/mcp-tools.json";
import MCP_TOOLS_WRITE from "../../capabilities/mcp-tools-write.json";

interface DraftRow {
  draftId: string;
  tool: string;
  capabilityId: string;
  state: "pending" | "applied" | "rejected" | "expired";
  at: number;
}
interface AuditRow {
  at: number;
  tool: string;
  capabilityId: string;
  ok: boolean;
  code: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 纯函数 / 纯数据（可单测；组件只负责渲染）
// ═══════════════════════════════════════════════════════════════════════════════

/** `granted` 权限串的分组（`read:*` / `write:*` / `export:*` / `*-all-spaces`；其余进 `other`）。 */
export interface ScopeGroups {
  read: string[];
  write: string[];
  export: string[];
  allSpaces: string[];
  /** 认不出的前缀（例如将来新增的 `kv:` / `audit:`）—— ⛔ 不许静默丢：进"其它"组显式渲染。 */
  other: string[];
}

/**
 * 把一串权限 id 分成四组（＋ 其它）。
 *
 * 规则（顺序重要）：`*-all-spaces` 先判（否则 `read:all-spaces` 会被 `read:*` 吃掉），
 * 再按 `read:` / `write:` / `export:` 前缀；其余进 `other`。
 * 空数组 / `null` ⇒ 五组都是空数组（⛔ 不抛错 —— 面板在"通道还没起"时就是空）。
 * 组内保序、去重（同一权限出现两次不会画两个 chip）。
 */
export function groupScopes(scopes: string[] | null | undefined): ScopeGroups {
  const out: ScopeGroups = { read: [], write: [], export: [], allSpaces: [], other: [] };
  const seen = new Set<string>();
  for (const raw of scopes ?? []) {
    const s = String(raw ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (s.endsWith("all-spaces")) out.allSpaces.push(s);
    else if (s.startsWith("read:")) out.read.push(s);
    else if (s.startsWith("write:")) out.write.push(s);
    else if (s.startsWith("export:")) out.export.push(s);
    else out.other.push(s);
  }
  return out;
}

/** 跨空间三态（能力清单徽章）。 */
export type CrossSpace = "read" | "write" | "none";

/**
 * 从生成物那行统一文案解析三态：
 * 读 `跨空间：支持（带 spaceId 读指定空间）`；写 `…支持（带 spaceId 写到指定空间，不是搬移）`；
 * 不支持 `跨空间：不支持（带 spaceId ⇒ bad_args）`。
 * 没有那一行 ⇒ `none`（⛔ 不猜成"支持"：对 agent 说有、实际会 bad_args 更糟）。
 */
function crossSpaceOf(description: string, isWrite: boolean): CrossSpace {
  const hit = /跨空间：\s*(支持|不支持)/.exec(description);
  if (!hit) return "none";
  if (hit[1] === "不支持") return "none";
  if (description.includes("读指定空间")) return "read";
  if (description.includes("写到指定空间")) return "write";
  return isWrite ? "write" : "read";
}

/** 能力 id → 跨空间三态（来自两份生成物；id 集合与 `AI_TOOL_META` 逐一对应）。 */
const CROSS_SPACE_META: Map<string, CrossSpace> = new Map([
  ...MCP_TOOLS_READ.map((t) => [t.capabilityId, crossSpaceOf(t.description, false)] as const),
  ...MCP_TOOLS_WRITE.map((t) => [t.capabilityId, crossSpaceOf(t.description, true)] as const),
]);

/** 三态各自的徽章文案与类（读=绿/中性、写=橙、不支持=灰；`set-badge` 是设置页既有行内徽章类）。 */
const CROSS_SPACE_BADGE: Record<CrossSpace, { label: string; cls: string }> = {
  read: { label: "跨空间·读", cls: "set-badge is-ok" },
  write: { label: "跨空间·写", cls: "set-badge is-warn" },
  none: { label: "跨空间·不支持", cls: "set-badge" },
};

/** 档位风险标签（设计稿：关／低／中／高）。 */
type Risk = "off" | "low" | "mid" | "high";
const RISK_LABEL: Record<Risk, string> = { off: "关", low: "低", mid: "中", high: "高" };

/** 六个档位（说明文案里的「既不读也不写 / 直接写入 / 每一次写都会留一行审计」是既有判据钉住的措辞）。 */
const LEVELS: Array<{
  id: McpStatus["level"];
  label: string;
  desc: string;
  risk: Risk;
}> = [
  { id: "off", label: "不接", desc: "完全不对外监听（既不读也不写），任何客户端都连不上。", risk: "off" },
  { id: "read", label: "只读", desc: "只读当前空间；不能写、不能导出文件句柄。", risk: "low" },
  { id: "read_all", label: "只读（全部空间）", desc: "可读所有空间，包含你不在看的那些。", risk: "mid" },
  { id: "write_confirm", label: "可写（每次确认）", desc: "每次写都先生成草稿，等你在应用里确认。", risk: "mid" },
  { id: "write_auto", label: "可写（免确认）", desc: "直接写入（草稿自动应用），但每一次写都会留一行审计。", risk: "high" },
  { id: "write_all", label: "可写（全部空间）", desc: "可读写所有空间；跨空间写需要 write:all-spaces。", risk: "high" },
];

/** 能力清单的域分组（顺序即展示顺序）。每条能力只落一个域；落不进的进「其它」（显式渲染）。 */
const DOMAINS: Array<[string, (id: string, isWrite: boolean) => boolean]> = [
  ["读页面", (id, w) => !w && /^(pages|search|tags|properties|backlinks|space|spaces)\./.test(id)],
  ["写页面", (id, w) => w && /^(pages|templates|import|tags|properties)\./.test(id)],
  ["块", (id) => /^blocks\./.test(id)],
  ["结构 / 回收站", (id, w) => w && /^(folders|nodes|trash|spaces)\./.test(id)],
  ["附件", (id) => /^(files|attachments|blobs)\./.test(id)],
  ["数据库", (id) => /^db\./.test(id)],
  ["导出", (id) => /^(export|coverage)\./.test(id)],
  ["审计", (id) => /^(audit|drafts|versions|version)\./.test(id)],
];

/** 未归属任何域的能力桶（设计稿：显式渲染，⛔ 不再藏在"未渲染的其它"里导致合计对不上）。 */
const CATCH_ALL = "其它";

function domainOf(id: string, isWrite: boolean): string {
  for (const [name, hit] of DOMAINS) if (hit(id, isWrite)) return name;
  return CATCH_ALL;
}

/** 一句人话的中间态（"开着但没在听"必须说出来 —— 那通常是端口被占）。 */
function stateLine(st: McpStatus): string {
  if (!st.enabled) return "已关闭（默认）";
  if (st.running) return `已打开 · 正在听 127.0.0.1:${st.port ?? "?"}`;
  return "开关开着，但监听没起来（端口可能被占）—— 这一刻连不上";
}

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

/** 相对时间（状态卡里的「最近一次外部调用」）：只给粗粒度，⛔ 不假装精确。 */
function relTime(ms: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 「当前允许」摘要 —— 由**后端读数**推导（⛔ 不按档位写死句子）：
 *   · 通道关着（`level=off`）⇒ 一律"不读/不写/不导出"（哪怕 granted 里还留着旧串）；
 *   · 其它档：读/写看 `granted` 里有没有对应前缀，`*-all-spaces` 决定"当前空间 / 全部空间"；
 *   · 导出看 `export:*`；令牌指纹取**令牌末 4 位**（面板从不回显完整令牌，除非点「显示」）。
 *
 * 唯一一条**不来自读数**的是"加密空间内容不可见（未解锁）"—— 那是产品不变式（E2EE），
 * 面板把它作为**不变式**展示（`data-invariant="encrypted-spaces"`），不与读数混为一谈。
 */
function allowanceOf(
  level: McpStatus["level"],
  granted: string[],
  token: string,
): { read: string; write: string; export: string; encrypted: string; token: string } {
  const g = groupScopes(granted);
  const off = level === "off";
  const hasRead = g.read.length > 0 || g.allSpaces.some((s) => s.startsWith("read:"));
  const hasWrite =
    g.write.length > 0 || g.allSpaces.some((s) => s.startsWith("write:")) || granted.includes("write:pages");
  const readAll = g.allSpaces.some((s) => s.startsWith("read:"));
  const writeAll = g.allSpaces.some((s) => s.startsWith("write:"));
  return {
    read: off || !hasRead ? "不读" : readAll ? "读全部空间" : "读当前空间",
    write: off || !hasWrite ? "不写" : writeAll ? "写全部空间" : "写当前空间",
    export: !off && g.export.length > 0 ? "导出文件句柄" : "不导出",
    encrypted: "加密空间内容不可见（未解锁）",
    token: token ? `令牌：…${token.slice(-4)}` : "令牌：（无）",
  };
}

/** 掩码形态：24 个圆点 ＋ 末 4 位（末 4 位是**指纹**，设计稿要求看得出是哪一枚）。 */
function maskToken(token: string): string {
  return `${"•".repeat(24)}${token.slice(-4)}`;
}

/** 面板顶部的分段导航（锚点到下面各区块，⛔ 不新增浮层）。 */
const NAV: Array<[string, string]> = [
  ["权限", "mcp-sec-levels"],
  ["能力", "mcp-sec-caps"],
  ["状态", "mcp-sec-status"],
  ["审计", "mcp-sec-audit"],
  ["AI 隐藏空间", "mcp-sec-hidden"],
];

/**
 * 「接入外部 AI」引导里的客户端选择（设计稿 v3）：切换只改**配置文件路径那一行**，
 * 配置片段本身相同（同一段 `mcpServers.shuyonote`）。
 * ⚠️ 这里的路径是**各客户端自己的约定**（不是本产品的事实，也不是 Tauri 后端读数）——
 * 面板只给"该粘到哪个文件"的提示，⛔ 不写死本机路径、也不假装能替用户写那个文件。
 */
/**
 * 常见客户端的配置文件位置（**不要求用户先"选择客户端"** —— 片段本身完全相同，
 * 选一次只是多一步交互；这里把最常见的路径直接列出来，其余一句话带过）。
 *
 * ⚠️ 2026-10-31（A 批）：原来只有 2 个（Claude Desktop / Cursor）。补上 Claude Code /
 * Windsurf / VS Code —— 后三者是"外部 AI 接入"里问得最多的（见 WorkBuddy 那份实测建议）。
 * ⚠️ **VS Code 的键名不是 `mcpServers` 而是 `servers`**（还有 JSONC 注释问题）⇒ 步骤 2 里单独加一句说明，
 * ⛔ 别让用户照着 mcpServers 贴进 VS Code 后一脸问号。
 * ⚠️ 2026-10-31（owner）：**自家两个放最前面** —— WorkBuddy（`~/.workbuddy/mcp.json`，标准
 * mcpServers JSON）与 DeepSeek Harness（profile 的 `cordis.patch.yml`，**YAML 的 insert 一节**，
 * 键名不是 mcpServers ⇒ 下面单独一句说明，⛔ 别让用户把 JSON 直接糊进 YAML）。
 */
const CONFIG_PATHS: Array<{ label: string; configPath: string; note?: string }> = [
  {
    label: "WorkBuddy",
    configPath: "~/.workbuddy/mcp.json",
    // ⭐ M9（2026-10-31）：WorkBuddy 有**自己的客户端准入** —— 不写这一句，用户会以为
    // "文件写对了 = 接上了"，然后在 WB 里一直看不到服务器（面板侧没有任何读数能解释这件事）。
    note: "首次配置后还需在 WorkBuddy 的「连接器管理 → 自定义连接器」里点「信任」，否则不会加载 MCP 服务器。",
  },
  { label: "DeepSeek Harness", configPath: "~/.dsh/profiles/<profile>/cordis.patch.yml" },
  { label: "Claude Desktop", configPath: "%APPDATA%\\Claude\\claude_desktop_config.json" },
  { label: "Cursor", configPath: "~/.cursor/mcp.json" },
  { label: "Claude Code", configPath: "~/.claude.json" },
  { label: "Windsurf", configPath: "~/.codeium/windsurf/mcp_config.json" },
  { label: "VS Code", configPath: "%APPDATA%\\Code\\User\\mcp.json" },
];

/** 「标准（npx）」片段拉的是哪个包：与连接器商店 `connectors/shuyonote/mcp.json` 同一个 tarball。 */
const NPX_TARBALL = "https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz";

export function McpAccessPane() {
  const [st, setSt] = useState<McpStatus | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [lastCall, setLastCall] = useState<AuditRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [hiddenSaving, setHiddenSaving] = useState(false);
  const [capFilter, setCapFilter] = useState<"all" | "support" | "none">("all");
  // 展开的分类：**默认全部折叠**（设计稿要求：能力区首屏只显示「分类＋计数＋占比条」，
  // 避免一进来就是文字墙；375 下尤其明显）。**内容始终留在 DOM 里**，用 CSS 折叠 ——
  // 这样能力清单的机器读数（`[data-cap-id]` 条数）不受展开状态影响，判据才不会因为折叠而漂。
  const [openCats, setOpenCats] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setSt(await api.mcpStatus());
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
    // 草稿/审计/最近一次调用是面板的旁路读数：拿不到就空着（⛔ 不因此挡住档位/令牌操作）
    await Promise.all([
      api
        .mcpRecentDrafts(5)
        .then((r) => setDrafts((r as DraftRow[]) ?? []))
        .catch(() => setDrafts([])),
      api
        .mcpRecentAudit(20, true)
        .then((r) => setAudit((r as AuditRow[]) ?? []))
        .catch(() => setAudit([])),
      // 「最近一次外部调用」用**不限写**的那一条读数（审计列表本身只看写，别拿它冒充"最近一次调用"）
      api
        .mcpRecentAudit(1)
        .then((r) => setLastCall(((r as AuditRow[]) ?? [])[0] ?? null))
        .catch(() => setLastCall(null)),
    ]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ⭐ AI 不可见空间清单：回读已保存清单（重开面板仍勾选）
  useEffect(() => {
    void api.mcpHiddenSpacesGet().then((r) => setHidden(r.spaceIds ?? [])).catch(() => setHidden([]));
  }, []);

  // ⭐ AI 不可见空间清单：空间列表（勾选列表用）
  useEffect(() => {
    void api.listWorkspaces().then((ws) => setSpaces(ws.map((w) => ({ id: w.id, name: w.name })))).catch(() => setSpaces([]));
  }, []);

  const level: McpStatus["level"] = st?.level ?? "off";
  const granted = st?.granted ?? [];
  const token = st?.token ?? "";
  const emptyToken = !token;

  const setLevel = async (next: McpStatus["level"]) => {
    if (!st) return;
    setBusy(true);
    try {
      setSt(await api.mcpSetLevel(next));
      const label = LEVELS.find((l) => l.id === next)?.label ?? next;
      toast(`权限已切到「${label}」——旧令牌同时失效`, "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      setSt(await api.mcpRotateToken());
      toast("已换一枚新令牌 —— 旧令牌立刻作废", "success");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveHidden = async () => {
    setHiddenSaving(true);
    try {
      const r = await api.mcpHiddenSpacesSet(hidden);
      setHidden(r.spaceIds ?? hidden);
      toast("AI 不可见空间清单已保存", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setHiddenSaving(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what}已复制`, "success");
    } catch {
      toast("复制失败 —— 请手动选中复制", "error");
    }
  };

  // ⭐ 快捷入口：锚点滚动到下面各区块（⛔ 不新增浮层）
  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  // 能力清单：**注册表全量**（按域分类）＋ 跨空间三态 ＋ 一句简介
  const capRows = useMemo(
    () =>
      AI_TOOL_META.map((c) => ({
        id: c.id,
        category: domainOf(c.id, c.isWrite),
        isWrite: c.isWrite,
        crossSpace: CROSS_SPACE_META.get(c.id) ?? ("none" as CrossSpace),
        brief: (c.description.split("。")[0] ?? c.description).replace(/\*\*|✓|✗|⛔/g, ""),
      })),
    [],
  );
  // 顶部统计行：三态各多少 —— **从上面那张表算**（⛔ 不写死数字）
  const crossSpaceCounts = useMemo(() => {
    const out: Record<CrossSpace, number> = { read: 0, write: 0, none: 0 };
    for (const row of capRows) out[row.crossSpace] += 1;
    return out;
  }, [capRows]);
  const supportCount = crossSpaceCounts.read + crossSpaceCounts.write;

  // 分类（顺序 = DOMAINS 顺序 ＋ 「其它」显式一行）：计数**全部由 capRows 算**
  const categories = useMemo(() => {
    const names = [...DOMAINS.map(([name]) => name), CATCH_ALL];
    return names.map((name) => ({
      name,
      items: capRows.filter((r) => r.category === name),
    }));
  }, [capRows]);
  // 计数自洽断言的数据面：分类之和必须 === 注册表条数（渲染用；测试另有独立断言）
  const categorySum = categories.reduce((n, c) => n + c.items.length, 0);

  const capShown = (crossSpace: CrossSpace) =>
    capFilter === "all" ? true : capFilter === "support" ? crossSpace !== "none" : crossSpace === "none";

  // granted 分组 chips（设计稿第二块：现在是一整串 read:pagesread:files…，不可读）
  const scopeGroups = useMemo(() => groupScopes(granted), [granted]);
  const allow = useMemo(() => allowanceOf(level, granted, token), [level, granted, token]);

  // ⭐ 2026-10-31（owner 选 B）：片段两种形态，**默认「随包」**：
  //   · 随包（零依赖）：`command` 直接指安装包里自带的 **Rust 桥 exe** —— 不需要 Node、不需要联网；
  //     桥自己会去应用数据目录找 `mcp/{port,token}`（与 `tools/shuyonote-mcp/paths.mjs` 同口径）
  //     ⇒ 片段里既没有 env、也没有 args，就是一行命令。
  //   · npx（需 Node 20+）：5 行常量，从 shuyo.cn 拉 JS 桥；给"装了 Node、想要零路径"的人。
  const [snippetMode, setSnippetMode] = useState<"bundled" | "npx">("bundled");
  const snippet = useMemo(() => {
    const bridge = st?.bridge_path ?? "";
    const server =
      snippetMode === "npx"
        ? {
            command: "npx",
            args: ["-y", "-p", NPX_TARBALL, "shuyonote-mcp"],
          }
        : {
            // 随包桥（Rust exe）：零依赖、零网络；找不到它时给一句"未随包"的占位，不编假路径
            command: bridge || "shuyonote-mcp（找不到随包桥：请重新安装）",
          };
    return JSON.stringify({ mcpServers: { shuyonote: server } }, null, 2);
  }, [snippetMode, st?.bridge_path]);

  const scopeRows: Array<[string, string[]]> = [
    ["读", scopeGroups.read],
    ["写", scopeGroups.write],
    ["全部空间", scopeGroups.allSpaces],
    ["导出", scopeGroups.export],
    ...(scopeGroups.other.length ? [["其它", scopeGroups.other] as [string, string[]]] : []),
  ];

  return (
    <div className="mcp-access mcp-panel">
      {/* 顶栏：分段导航（锚点滚动；窄屏换行不横向溢出）＋ 状态 chip ＋「如何接入」 */}
      <div className="mcp-topbar">
        <nav className="mcp-nav" aria-label="MCP 接入面板分区">
          {NAV.map(([label, id]) => (
            <a key={id} className="mcp-nav-link" href={`#${id}`} data-nav={id}>
              {label}
            </a>
          ))}
        </nav>
        <div className="mcp-topbar-right">
          <span
            className={`mcp-status-chip${st?.running ? " is-on" : ""}`}
            data-testid="mcp-top-status"
          >
            <span className="mcp-access-dot" aria-hidden="true" />
            {!st ? "读取中…" : st.running ? "已打开 · 正在听" : st.enabled ? "开关开着 · 未监听" : "已关闭（默认）"}
          </span>
          {/* ⛔ 2026-10-31（owner）：「如何接入」按钮去掉 —— 接入引导本来就是首屏第一块，
              这颗按钮纯属重复；状态卡里的「客户端配置说明」快捷入口仍在。 */}
        </div>
      </div>

      {/* ⭐ 首屏接入引导（精简版）：两步"复制 → 粘贴"，再一行"重启并检测"。
          ⛔ 不再要求先"选择客户端"：片段完全相同，选一次只是多一步交互。
          配置片段与令牌**只在这里出现一次**（状态区不再重复）。 */}
      <section className="set-section mcp-onboard" id="mcp-sec-onboard" data-testid="mcp-onboard">
        <div className="set-section-title mcp-section-title">
          <span className="mcp-section-title-text">接入外部 AI</span>
          <span className="mcp-title-hint">复制 → 粘贴到 mcpServers → 重启（首次）</span>
        </div>
        {/* ⛔ 2026-10-31（owner 截图）：这行提示去掉 ——
            「片段已按这台机器自动填好；令牌只存在本机文件里，不写进片段。」
            片段里已经能直接看到填好的路径，令牌栏单独在下面；再放一句解释反而多一行噪音。 */}
        {level === "off" ? (
          <p className="mcp-onboard-tip" data-testid="mcp-onboard-tip">
            先选一档权限，再按下面三步接入。
          </p>
        ) : null}
        <div className="mcp-onboard-grid">
          <ol className="mcp-onboard-steps">
            <li data-step="1" className="mcp-step">
              <span className="mcp-step-no" aria-hidden="true">
                1
              </span>
              <div className="mcp-step-body">
                <div className="mcp-step-title">复制右边的配置片段</div>
                <div className="mcp-step-note">片段通用，不用先选客户端。</div>
              </div>
            </li>
            <li data-step="2" className="mcp-step">
              <span className="mcp-step-no" aria-hidden="true">
                2
              </span>
              <div className="mcp-step-body">
                <div className="mcp-step-title">粘进客户端的 MCP 配置</div>
                <div className="mcp-path-list">
                  {CONFIG_PATHS.map((c) => (
                    <div
                      className="mcp-path-row"
                      key={c.label}
                      // 只有带 note 的行需要换行（WorkBuddy 的「信任」提示）；其余行保持 单行「标签 + 路径」。
                      style={c.note ? { flexWrap: "wrap" } : undefined}
                    >
                      <span className="mcp-path-label">{c.label}</span>
                      <code className="mcp-path-value" data-testid="mcp-config-path" title={c.configPath}>
                        {c.configPath}
                      </code>
                      {c.note ? (
                        <div
                          className="mcp-step-note"
                          data-testid="mcp-path-note"
                          style={{ flexBasis: "100%", paddingTop: 2 }}
                        >
                          {c.note}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="mcp-step-note">
                  已存在就合并，别整段覆盖。
                </div>
                <div className="mcp-step-note">
                  VS Code：键名是 <code>servers</code>，JSONC（可带注释）。
                </div>
                <div className="mcp-step-note">
                  DeepSeek Harness：写在 <code>cordis.patch.yml</code> 的 <code>insert</code> 一节（YAML）。
                </div>
              </div>
            </li>
            <li data-step="3" className="mcp-step">
              <span className="mcp-step-no" aria-hidden="true">
                3
              </span>
              <div className="mcp-step-body">
                <div className="mcp-step-title">重启客户端（只需首次）</div>
                <div className="mcp-step-note">
                  以后换档、换令牌不用重启。
                </div>
                <div className="mcp-step-readings">
                  <div className="mcp-kv">
                    <span className="mcp-kv-label">最近调用</span>
                    <span className="mcp-kv-value">
                      {lastCall ? `${relTime(lastCall.at)} · ${lastCall.tool}` : "还没有（客户端还没连过）"}
                    </span>
                  </div>
                  <div className="mcp-kv">
                    <span className="mcp-kv-label">连接</span>
                    <span className="mcp-kv-value">{st?.enabled ? "本机回环（连接数不统计）" : "通道关闭"}</span>
                  </div>
                </div>
                <button
                  className="set-btn mcp-detect-btn"
                  data-testid="mcp-detect"
                  disabled={busy || !st}
                  title="只刷新通道状态与最近调用读数；后端不统计连接数"
                  onClick={() => {
                    void refresh();
                    toast("已刷新状态读数", "success");
                  }}
                >
                  刷新状态
                </button>
              </div>
            </li>
          </ol>

          {/* 右侧：配置片段 ＋ 令牌（复制/显示/换新只在**这里**出现一次） */}
          <div className="mcp-config-card" data-testid="mcp-config-card">
            <div className="mcp-config-head">
              <span className="mcp-config-title">配置片段</span>
              {/* 2026-10-31（owner 选 C1）：两种形态可切。默认 npx（5 行、无路径）；
                  「离线」给内网/无网环境用随包桥（绝对路径 + port/token 两个 env）。 */}
              <div className="mcp-snippet-mode" role="group" aria-label="片段形式">
                <button
                  type="button"
                  className={snippetMode === "bundled" ? "is-on" : ""}
                  data-testid="snippet-mode-bundled"
                  aria-pressed={snippetMode === "bundled"}
                  onClick={() => setSnippetMode("bundled")}
                >
                  随包
                </button>
                <button
                  type="button"
                  className={snippetMode === "npx" ? "is-on" : ""}
                  data-testid="snippet-mode-npx"
                  aria-pressed={snippetMode === "npx"}
                  onClick={() => setSnippetMode("npx")}
                >
                  npx
                </button>
              </div>
              <button
                className="set-btn is-primary"
                data-testid="copy-config"
                disabled={!st}
                onClick={() => void copy(snippet, "配置片段")}
              >
                复制配置
              </button>
            </div>
            <pre className="mcp-access-snippet mcp-config-snippet" data-testid="mcp-snippet">
              {snippet}
            </pre>
            <p className="mcp-snippet-hint" data-testid="mcp-snippet-hint">
              {snippetMode === "npx"
                ? "需要 Node 20+ 且联网（npx 从 shuyo.cn 下载 JS 桥）。"
                : "零依赖：用安装包里自带的桥，不需要 Node、也不需要联网。"}
            </p>
            <div className="mcp-config-foot">
              <div className="mcp-token-line">
                <span className="mcp-token-label">令牌</span>
                <span className={`mcp-access-token${emptyToken ? " is-empty" : ""}`}>
                  <code
                    className="mcp-access-token-text"
                    data-testid="mcp-token"
                    data-fingerprint={token ? token.slice(-4) : ""}
                  >
                    {!token ? "（还没有 —— 打开开关时会自动生成）" : showToken ? token : maskToken(token)}
                  </code>
                </span>
              </div>
              <div className="mcp-token-actions">
                <button className="set-btn" data-testid="copy-token" disabled={!token} onClick={() => void copy(token, "令牌")}>
                  复制令牌
                </button>
                <button className="set-btn" disabled={!token} onClick={() => setShowToken((v) => !v)}>
                  {showToken ? "隐藏" : "显示"}
                </button>
                <button className="set-btn" disabled={busy || !st} onClick={() => void rotate()}>
                  换一枚新令牌
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ① 权限档位：六张单选卡 */}
      <section className="set-section" id="mcp-sec-levels">
        <div className="set-section-title mcp-section-title">
          <span className="mcp-section-title-text">权限档位</span>
          <span className="mcp-title-hint">选中即生效：切换会换新令牌，旧令牌立即失效</span>
        </div>
        <p className="set-hint">
          档位决定外部 AI 能对哪些空间做什么。加密空间的内容对 AI 永远不可见（需要口令解锁后才可读）。
        </p>
        <div className="mcp-levels-grid" role="radiogroup" aria-label="外部 AI 权限档位" data-testid="mcp-levels">
          {LEVELS.map((l) => {
            const on = level === l.id;
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={l.label}
                data-level={l.id}
                data-risk={l.risk}
                className={`mcp-level-card ai-settings-tab${on ? " is-on" : ""}`}
                disabled={busy || !st}
                onClick={() => void setLevel(l.id)}
              >
                <span className="mcp-level-head">
                  <span className={`mcp-radio${on ? " is-on" : ""}`} aria-hidden="true" />
                  <span className="mcp-level-title">{l.label}</span>
                  <span className={`mcp-risk mcp-risk-${l.risk}`} data-risk-label={l.risk}>
                    {RISK_LABEL[l.risk]}
                  </span>
                </span>
                <span className="mcp-level-desc">{l.desc}</span>
              </button>
            );
          })}
        </div>
        {/* 选中卡下方的「当前允许」摘要（全部由后端读数推导）。
            ⚠️ 分隔符用 `·`，且**前面带不换行空格**（`\u00a0`）—— 375 下折行时分隔符不会跑到行首。 */}
        <div className="mcp-allow-row" data-testid="mcp-allow-summary">
          <b>当前允许：</b>
          <span data-allow="read">{allow.read}</span>
          <span className="mcp-sep" aria-hidden="true">{"\u00a0· "}</span>
          <span data-allow="write">{allow.write}</span>
          <span className="mcp-sep" aria-hidden="true">{"\u00a0· "}</span>
          <span data-allow="export">{allow.export}</span>
          <span className="mcp-sep" aria-hidden="true">{"\u00a0· "}</span>
          <span className="mcp-invariant" data-invariant="encrypted-spaces">
            {allow.encrypted}
          </span>
          <span className="mcp-sep" aria-hidden="true">{"\u00a0· "}</span>
          <span data-allow="token">{allow.token}</span>
        </div>
      </section>

      {/* ② 能力：分类可展开 ＋ 筛选 ＋ 跨空间徽章 */}
      <section className="set-section" id="mcp-sec-caps">
        <div className="set-section-title mcp-section-title">
          <span className="mcp-section-title-text">它能做什么</span>
        </div>
        {/* 顶部统计行（既有判据钉住的元素与文案：三态计数）；「共 N 项（读 X + 写 Y）」只在这里出现一次
            —— 原来描述里还写了一遍「这一档可见 N 项」，两处重复，已删（2026-10-31 owner 反馈） */}
        <div
          className="set-hint"
          data-testid="mcp-crossspace-stats"
          data-read={crossSpaceCounts.read}
          data-write={crossSpaceCounts.write}
          data-none={crossSpaceCounts.none}
        >
          跨空间：读 {crossSpaceCounts.read} · 写 {crossSpaceCounts.write} · 不支持 {crossSpaceCounts.none}
        </div>
        {/* 筛选：全部 / 支持跨空间 / 不支持（数字从数据算） */}
        <div className="mcp-cap-filter" role="group" aria-label="按跨空间支持筛选">
          <span className="mcp-cap-total" data-testid="mcp-cap-total">
            共 {capRows.length} 项（读 {capRows.filter((c) => !c.isWrite).length} + 写{" "}
            {capRows.filter((c) => c.isWrite).length}）
          </span>
          {(
            [
              ["all", `全部`],
              ["support", `支持跨空间 ${supportCount}`],
              ["none", `不支持 ${crossSpaceCounts.none}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-filter={key}
              aria-pressed={capFilter === key}
              className={`mcp-filter-btn${capFilter === key ? " is-on" : ""}`}
              onClick={() => setCapFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {categories.map((cat) => {
          const shown = cat.items.filter((i) => capShown(i.crossSpace));
          if (shown.length === 0) return null;
          const isCatchAll = cat.name === CATCH_ALL;
          const isOpen = openCats.includes(cat.name);
          // 占比条（折叠时也要能看出各域大小）：条数 / 清单条数
          const ratio = capRows.length ? cat.items.length / capRows.length : 0;
          const toggle = () =>
            setOpenCats((prev) => (prev.includes(cat.name) ? prev.filter((x) => x !== cat.name) : [...prev, cat.name]));
          return (
            <div
              key={cat.name}
              className="mcp-cap-category"
              data-open={isOpen}
              {...(isCatchAll
                ? { "data-domain-catchall": CATCH_ALL }
                : { "data-domain": cat.name })}
              data-count={cat.items.length}
              data-shown={shown.length}
            >
              <button
                type="button"
                className="mcp-cap-cat-head"
                aria-expanded={isOpen}
                data-cat={cat.name}
                onClick={toggle}
              >
                <span className="mcp-caret" aria-hidden="true">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="mcp-cap-cat-name">{cat.name}</span>
                {/* 占比条：长度 = 该分类条数 / 清单条数（折叠时也能一眼看出各域占比） */}
                <span
                  className="mcp-cap-bar"
                  aria-hidden="true"
                  data-ratio={ratio.toFixed(4)}
                  data-testid="mcp-cap-bar"
                >
                  <span className="mcp-cap-bar-fill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
                </span>
                {isCatchAll && (
                  <span className="mcp-cap-cat-note">
                    这 {cat.items.length} 项没有域归属，显式列出以保证计数自洽
                  </span>
                )}
                <span className="mcp-cap-cat-count" data-count-label={cat.items.length}>
                  {cat.items.length}
                </span>
              </button>
              <div className="mcp-cap-grid">
                {shown.map((c) => {
                  const badge = CROSS_SPACE_BADGE[c.crossSpace];
                  return (
                    <div key={c.id} className="mcp-cap-item" data-cap-id={c.id}>
                      <code className="mcp-cap-name">{c.id}</code>
                      <span className="mcp-cap-item-tail">
                        <span className="mcp-cap-brief">{c.brief}</span>
                        <span className={badge.cls} data-crossspace={c.crossSpace}>
                          {badge.label}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {/* 计数自洽的机器可读读数（数据面；测试用它断言 sum === 注册表条数） */}
        <div className="set-hint" data-testid="mcp-cap-category-sum" data-sum={categorySum}>
          分类计数之和：{categorySum} / 清单 {AI_TOOL_META.length}
        </div>
      </section>

      {/* ③ 连接状态卡 */}
      <section className="set-section" id="mcp-sec-status">
        <div className="mcp-status-head">
          <div className="set-section-title mcp-section-title">现在是什么状态</div>
          <button className="set-btn" data-testid="mcp-refresh" disabled={busy || !st} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <div className="mcp-stat-card" data-testid="mcp-stat-card">
          <div className="mcp-stat-grid">
            <div className="mcp-stat-cell">
              <div className="mcp-stat-label">监听地址</div>
              <div className="mcp-stat-value mcp-stat-addr">
                <code data-testid="mcp-listen-addr">
                  {st?.running ? `127.0.0.1:${st.port ?? "?"}` : "（未监听）"}
                </code>
                <button
                  className="set-btn"
                  data-testid="copy-listen"
                  disabled={!st?.running}
                  onClick={() => void copy(`127.0.0.1:${st?.port ?? ""}`, "监听地址")}
                >
                  复制
                </button>
              </div>
            </div>
            <div className="mcp-stat-cell">
              <div className="mcp-stat-label">最近一次外部调用</div>
              <div className="mcp-stat-value" data-testid="mcp-last-call">
                {lastCall ? `${relTime(lastCall.at)} · ${lastCall.tool}` : "（还没有外部调用记录）"}
              </div>
            </div>
            <div className="mcp-stat-cell">
              <div className="mcp-stat-label">连接</div>
              <div className="mcp-stat-value" data-testid="mcp-connections">
                {st?.enabled ? "本机回环（客户端连接数未采集）" : "（通道关闭）"}
              </div>
            </div>
          </div>
          <div className="mcp-stat-state">
            <span className={`mcp-access-dot${st?.enabled ? " is-on" : ""}`} aria-hidden="true" />
            <span className="mcp-access-state">{st ? stateLine(st) : "读取中…"}</span>
            {err && <span className="set-row-sub mcp-access-err">读/改状态失败：{err}</span>}
            {st?.env_override && <span className="set-row-sub">（这次是被环境变量打开的）</span>}
          </div>
        </div>
        {/* 快捷入口（锚点滚动到下面各区块；⛔ 不新增浮层） */}
        <div className="mcp-shortcuts">
          <button className="set-btn" data-shortcut="drafts" onClick={() => jumpTo("mcp-sec-drafts")}>
            最近草稿
          </button>
          <button className="set-btn" data-shortcut="audit" onClick={() => jumpTo("mcp-sec-audit")}>
            最近审计
          </button>
          <button className="set-btn" data-shortcut="hidden" onClick={() => jumpTo("mcp-sec-hidden")}>
            AI 隐藏空间（{hidden.length}）
          </button>
          <button className="set-btn" data-shortcut="onboard" onClick={() => jumpTo("mcp-sec-onboard")}>
            客户端配置说明
          </button>
        </div>
        {/* granted 权限串 → 分组 chips（以前是一整串 read:pagesread:files…） */}
        <div className="mcp-scope-rows" data-testid="mcp-scope-chips">
          {scopeRows.map(([label, items]) => (
            <div key={label} className="mcp-scope-row" data-scope-group={label}>
              <span className="mcp-scope-label">{label}</span>
              <span className="mcp-scope-chips">
                {items.length === 0 ? (
                  <span className="mcp-scope-empty">（无）</span>
                ) : (
                  items.map((s) => (
                    <span
                      key={s}
                      className={`mcp-chip${label === "全部空间" ? " is-all" : ""}`}
                      data-granted={s}
                    >
                      {s}
                    </span>
                  ))
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="mcp-write-warning" data-testid="mcp-write-warning">
          写操作都是「草稿中介」：外部 AI 产生的修改先落草稿，只有你在应用里点「应用」才真正写库；每条写都留一行审计。关掉或换档会立刻吊销令牌 —— 已连上的外部 AI 会在下一次调用时被拒。
        </p>
      </section>

      {/* ④ 最近草稿 */}
      <section className="set-section" id="mcp-sec-drafts">
        <div className="set-section-title mcp-section-title">最近草稿（5 条）</div>
        <ul data-testid="mcp-drafts">
          {drafts.length === 0 ? (
            <li className="set-hint">暂无草稿</li>
          ) : (
            drafts.map((d) => (
              <li key={d.draftId} className="set-row-sub" data-state={d.state}>
                {fmtTime(d.at)} · <code>{d.tool}</code> · {d.state}
              </li>
            ))
          )}
        </ul>
      </section>

      {/* ⑤ 最近审计 */}
      <section className="set-section" id="mcp-sec-audit">
        <div className="set-section-title mcp-section-title">最近审计（20 条）</div>
        <ul data-testid="mcp-audit">
          {audit.length === 0 ? (
            <li className="set-hint">暂无审计</li>
          ) : (
            audit.map((a, i) => (
              <li key={`${a.at}-${i}`} className="set-row-sub" data-ok={a.ok}>
                {fmtTime(a.at)} · <code>{a.tool}</code> · {a.ok ? "成功" : `失败（${a.code ?? "?"}）`}
              </li>
            ))
          )}
        </ul>
      </section>

      {/* ⑥ AI 不可见空间清单 */}
      <section className="set-section" id="mcp-sec-hidden">
        <div className="set-section-title mcp-section-title">AI 不可见空间</div>
        <p className="set-hint">勾选后 AI 既不能读也不能写该空间；你自己不受影响。隐藏 ≠ 加密。</p>
        <p className="set-hint">清单只保存在本机（不随设备同步）；换机后需要重配。</p>
        {level === "off" ? <p className="set-hint">（先选一个外部接入档位才能编辑）</p> : null}
        <ul data-testid="mcp-hidden-spaces">
          {spaces.length === 0 ? (
            <li className="set-hint">（未隐藏任何空间）</li>
          ) : (
            spaces.map((s) => (
              <li key={s.id} className="set-row-sub">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`隐藏空间 ${s.name}`}
                    checked={hidden.includes(s.id)}
                    disabled={level === "off" || hiddenSaving}
                    onChange={(e) => setHidden(e.target.checked ? [...hidden, s.id] : hidden.filter((x) => x !== s.id))}
                  />{" "}
                  {s.name}
                  <code> {s.id}</code>
                </label>
              </li>
            ))
          )}
        </ul>
        <div className="set-actions">
          <button
            className="set-btn"
            data-testid="mcp-hidden-save"
            disabled={level === "off" || hiddenSaving}
            onClick={() => void saveHidden()}
          >
            保存清单
          </button>
        </div>
      </section>

      {/* ⑦ 边界提示（静态说明，⛔ 不冒充读数） */}
      <section className="set-section" id="mcp-sec-boundary">
        <div className="set-section-title mcp-section-title">边界提示</div>
        <p className="set-hint">导出/下载走句柄（blobs_fetch 落盘），不回真名字节。</p>
        <p className="set-hint">超过 10MB 的下载需要你确认；本版面板尚未接确认 UI。</p>
        <p className="set-hint">上传/导入需要你在系统文件选择框里选文件（外部 AI 不能给任意路径）。</p>
        <p className="set-hint">跨空间读要「只读（全部空间）」档；跨空间写要「可写（全部空间）」档。</p>
        <p className="set-hint">
          笔记仍在本机；但外部 AI 读到什么由它决定 —— 云端 AI 收到内容后，这部分内容就离开了本机。
        </p>
      </section>
    </div>
  );
}
