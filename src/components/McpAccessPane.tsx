// MCP 接入面板（P1 改版 —— 「接入面板」六块）。
//
// ⚠️ 样式纪律：**只用设置页既有的那套类**（`set-section` / `set-section-title` / `set-row` /
//   `set-row-text` / `set-row-name` / `set-row-sub` / `set-hint` / `set-status` / `set-btn` /
//   `set-actions` / `ai-settings-tab*` ＋ `mcp-access-*` 既有类）。本版**没有新增 CSS**。
//
// 六块：① 档位（六档；每档动态列"这一档能做什么"）② 状态卡（运行/端口/token 脱敏/复制配置）
// ③ 能力清单（折叠，按域分组，条目来自注册表生成物，⛔ 不手写会漂的句子）
// ④ 最近草稿 ⑤ 最近审计 ⑥ 边界提示。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { AI_TOOL_META } from "../lib/capabilities/aiTools.meta";
import { toast } from "../store/toast";
import type { McpStatus } from "../types";

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

const LEVELS: Array<[McpStatus["level"], string, string]> = [
  ["off", "不接", "完全断开：既不读也不写；旧令牌同时失效。"],
  ["read", "只读", "能看当前空间；不能改。"],
  ["read_all", "只读（全部空间）", "能看所有空间；不能改。"],
  ["write_confirm", "可写（每次确认）", "能改当前空间；每次先问你。"],
  ["write_auto", "可写（免确认）", "能改当前空间；直接写入，但每一次写都会留一行审计。"],
  [
    "write_all",
    "可写（全部空间）",
    "能读并写所有空间（加密空间内容不可见）。⚠️ 仅在你信任外部 AI 时开启：开启后它能读到全部空间的内容。",
  ],
];

/** 能力清单的域分组（顺序即展示顺序）。每条能力只落一个域。 */
const DOMAINS: Array<[string, (id: string, isWrite: boolean) => boolean]> = [
  ["读页面", (id, w) => !w && /^(pages|search|tags|properties|backlinks|space|spaces)\./.test(id)],
  ["写页面", (id, w) => w && /^(pages|templates|import|tags|properties)\./.test(id)],
  ["块", (id) => /^blocks\./.test(id)],
  ["结构", (id, w) => w && /^(folders|nodes|trash|spaces)\./.test(id)],
  ["附件", (id) => /^(files|attachments|blobs)\./.test(id)],
  ["数据库", (id) => /^db\./.test(id)],
  ["导出", (id) => /^(export|coverage)\./.test(id)],
  ["审计", (id) => /^(audit|drafts|versions|version)\./.test(id)],
];

function domainOf(id: string, isWrite: boolean): string {
  for (const [name, hit] of DOMAINS) if (hit(id, isWrite)) return name;
  return "其它";
}

/** 一句人话的中间态（"开着但没在听"必须说出来 —— 那通常是端口被占）。 */
function stateLine(st: McpStatus): string {
  if (!st.enabled) return "已关闭（默认）";
  if (st.running) return `已打开 · 正在听 127.0.0.1:${st.port ?? "?"}`;
  return "开关开着，但监听没起来（端口可能被占）—— 这一刻连不上";
}

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

export function McpAccessPane() {
  const [st, setSt] = useState<McpStatus | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [hiddenSaving, setHiddenSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSt(await api.mcpStatus());
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
    // 草稿/审计是面板的旁路读数：拿不到就空着（⛔ 不因此挡住档位/令牌操作）
    await Promise.all([
      api
        .mcpRecentDrafts(5)
        .then((r) => setDrafts((r as DraftRow[]) ?? []))
        .catch(() => setDrafts([])),
      api
        .mcpRecentAudit(20, true)
        .then((r) => setAudit((r as AuditRow[]) ?? []))
        .catch(() => setAudit([])),
    ]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const label = LEVELS.find(([id]) => id === next)?.[1] ?? next;
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

  // 当前档「能做什么」：**按注册表 ai:true 过滤**，⛔ 不手写能力句子（会漂）。
  const readOk = granted.some((s) => s.startsWith("read:"));
  const writeOk = granted.some((s) => s === "write:pages" || s === "write:all-spaces");
  const visibleCaps = useMemo(
    () => AI_TOOL_META.filter((c) => (c.isWrite ? writeOk : readOk)),
    [readOk, writeOk],
  );
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of visibleCaps) {
      const d = domainOf(c.id, c.isWrite);
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  }, [visibleCaps]);
  const capRows = useMemo(
    () =>
      AI_TOOL_META.map((c) => ({
        id: c.id,
        domain: domainOf(c.id, c.isWrite),
        isWrite: c.isWrite,
        brief: (c.description.split("。")[0] ?? c.description).replace(/\*\*|✓|✗|⛔/g, ""),
      })),
    [visibleCaps],
  );

  const snippet = useMemo(() => {
    const bridge = st?.bridge_path ?? "";
    return JSON.stringify(
      {
        mcpServers: {
          shuyonote: {
            command: "node",
            args: [bridge || "tools/shuyonote-mcp/index.mjs"],
            env: {
              SHUYONOTE_MCP_PORT_FILE: st?.port_path ?? "",
              SHUYONOTE_MCP_TOKEN_FILE: st?.token_path ?? "",
            },
          },
        },
      },
      null,
      2,
    );
  }, [st?.bridge_path, st?.port_path, st?.token_path]);

  return (
    <div className="mcp-access">
      {/* ① 档位 */}
      <section className="set-section">
        <div className="set-section-title">外部 AI 权限</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">当前权限</div>
            <div className="set-row-sub">{LEVELS.find(([id]) => id === level)?.[2] ?? ""}</div>
          </div>
        </div>
        <div className="ai-settings-tabs" role="tablist" aria-label="外部 AI 权限">
          {LEVELS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={level === id}
              aria-label={label}
              data-level={id}
              className={`ai-settings-tab${level === id ? " is-on" : ""}`}
              disabled={busy || !st}
              onClick={() => void setLevel(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="set-hint">切换档位会换新令牌，旧令牌立即失效。</div>

        <details className="set-row" open>
          <summary className="set-row-sub">
            它能做什么（这一档，按能力注册表实时算，共 {visibleCaps.length} 项）
          </summary>
          {DOMAINS.map(([name]) => {
            const n = groupCounts.get(name) ?? 0;
            return (
              <div key={name} className="set-hint" data-domain={name} data-count={n}>
                {name}：{n} 项
              </div>
            );
          })}
        </details>
      </section>

      {/* ② 状态卡 */}
      <section className="set-section">
        <div className="set-section-title">现在是什么状态</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name mcp-access-state">
              <span className={`mcp-access-dot${st?.enabled ? " is-on" : ""}`} aria-hidden="true" />
              {st ? stateLine(st) : "读取中…"}
            </div>
            {err && <div className="set-row-sub mcp-access-err">读/改状态失败：{err}</div>}
            <div className="set-row-sub">
              granted：
              {granted.length === 0
                ? "（无）"
                : granted.map((s) => (
                    <span key={s} className="mcp-access-badge" data-granted={s}>
                      {s}
                    </span>
                  ))}
            </div>
          </div>
          <button className="set-btn" disabled={busy || !st} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        <div className={`mcp-access-token${emptyToken ? " is-empty" : ""}`}>
          <code className="mcp-access-token-text" data-testid="mcp-token">
            {!token
              ? "（还没有 —— 打开开关时会自动生成）"
              : showToken
                ? token
                : "••••••••••••••••••••••••"}
          </code>
        </div>
        <div className="set-actions">
          <button className="set-btn" disabled={!token} onClick={() => void copy(token, "令牌")}>
            复制令牌
          </button>
          <button className="set-btn" disabled={!token} onClick={() => setShowToken((v) => !v)}>
            {showToken ? "隐藏" : "显示"}
          </button>
          <button className="set-btn" disabled={busy || !st} onClick={() => void rotate()}>
            换一枚新令牌
          </button>
        </div>
        <p className="set-hint">
          桥的路径会自动填好；客户端配置里的端口会随重启变化；切档后请重启 AI 客户端（令牌同时换新）。
        </p>
        <pre className="mcp-access-snippet" data-testid="mcp-snippet">
          {snippet}
        </pre>
        <div className="set-actions">
          <button className="set-btn is-primary" data-testid="copy-config" disabled={!st} onClick={() => void copy(snippet, "配置片段")}>
            复制配置（客户端）
          </button>
        </div>
      </section>

      {/* ③ 能力清单 */}
      <section className="set-section">
        <details>
          <summary className="set-section-title">能力清单（{AI_TOOL_META.length} 项，按域分组）</summary>
          <ul>
            {capRows.map((c) => (
              <li key={c.id} className="set-row-sub" data-cap-id={c.id}>
                <b>{c.domain}</b> · <code>{c.id}</code>
                {c.isWrite ? "（写）" : "（读）"} — {c.brief}
              </li>
            ))}
          </ul>
        </details>
      </section>

      {/* ⑦ AI 不可见空间清单 */}
      <section className="set-section">
        <div className="set-section-title">AI 不可见空间</div>
        <p className="set-hint">勾选后 AI 既不能读也不能写该空间；你自己不受影响。隐藏 ≠ 加密。</p>
        <p className="set-hint">清单只保存在本机（不随设备同步）；换机后需要重配。</p>
        {level === "off" ? (
          <p className="set-hint">（先选一个外部接入档位才能编辑）</p>
        ) : null}
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
                  />{' '}
                  {s.name}
                  <code> {s.id}</code>
                </label>
              </li>
            ))
          )}
        </ul>
        <div className="set-actions">
          <button className="set-btn" data-testid="mcp-hidden-save" disabled={level === "off" || hiddenSaving} onClick={() => void saveHidden()}>
            保存清单
          </button>
        </div>
      </section>
      {/* ④ 草稿 */}
      <section className="set-section">
        <div className="set-section-title">最近草稿（5 条）</div>
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

      {/* ⑤ 审计 */}
      <section className="set-section">
        <div className="set-section-title">最近审计（20 条）</div>
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

      {/* ⑥ 边界提示（静态说明，⛔ 不冒充读数） */}
      <section className="set-section">
        <div className="set-section-title">边界提示</div>
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
