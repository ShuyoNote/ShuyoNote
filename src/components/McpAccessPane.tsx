// MCP 接入（R89 的**开关面** ＋ M2 的**写**那半 ✓）：开关 ／ 状态 ／ 令牌 ／ 给 AI 的配置 ✓。
//
// owner 2026-10-06 拍板：**允许外部 AI 读**（默认关、只绑本机、要令牌、关掉立刻失效 ✓）
// ＋ **设置里必须有开关与可见状态** ✓；M2 又加了「提改动」（默认进待确认；免确认开着时每次写留痕 ✓）。
//
// ⚠️ **2026-10-06 第二版（owner：截图 ＋「优化一下」✓）** —— 第一版我**自己发明了一套 `set-row-*` 子类名**
//    （`set-row-main` / `set-row-title` / `set-row-hint`）✗，而 `App.css` 里**根本没有这几条规则** ✗
//    （全仓只有这个文件在用它们 ✓）⇒ 面板是"裸"的：标题和正文同字号、换行挤在一起、开关悬在长文的
//    垂直中点、`**加粗**` 这种 Markdown 写法在 JSX 里是**字面星号** ✗。
//    ⇒ 这一版改用**设置页既有的那套类**（`AbilitiesPane` 是现成范例 ✓）：
//      `set-section` / `set-section-title` / `set-row` / `set-row-text` / `set-row-name` / `set-row-sub`
//      / `set-hint` / `set-status` / `set-btn` ＋ 既有的 `ui-toggle` ✓ —— 一行都不新造 ✗。
//    ⚠️ 界面上要强调的词一律用 `<b>` ✓，⛔ 不写 `**…**` ✗（那是 Markdown，不是 JSX）。
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { McpStatus } from "../types";

/** 一句人话的中间态（"开着但没在听"必须说出来 —— 那通常是端口被占 ✓）。 */
function stateLine(st: McpStatus): string {
  if (!st.enabled) return "已关闭（默认）";
  if (st.running) return `已打开 · 正在听 127.0.0.1:${st.port ?? "?"}`;
  return "开关开着，但监听没起来（端口可能被占）—— 这一刻连不上";
}

export function McpAccessPane() {
  const [st, setSt] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSt(await api.mcpStatus());
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ⭐ R152（owner 2026-10-08 选 A）：**一个四档**取代原先三个开关 ✓ ——
  //   理由：②「免确认」与③「授权写入」不独立（③ 关着 ⇒ ② 毫无作用 ✗）、① 关着时 ②③ 是死 UI ✗
  //   ⇒ 真状态只有 4 个，却用 3 个布尔表达 ⇒ 一半组合是死的/骗人的 ✗。
  const LEVELS: Array<[McpStatus["level"], string, string]> = [
    ["off", "不接", "关掉本机通道：请求立刻被拒、旧令牌作废 ✓（既不读也不写）"],
    ["read", "只读", "能读笔记；调「新建页面／追加内容」会被**明确拒**（`permission_denied`）✓"],
    ["write_confirm", "可写（每次确认）", "外部写**先变成一条待你确认的改动**，你点确定才落库 ✓"],
    ["write_auto", "可写（免确认）", "外部写**直接落库**；每一次写仍会留一行审计 ✓"],
  ];
  const level: McpStatus["level"] = st?.level ?? "off";

  const setLevel = async (next: McpStatus["level"]) => {
    setBusy(true);
    try {
      setSt(await api.mcpSetLevel(next));
      setErr("");
      const label = LEVELS.find(([id]) => id === next)?.[1] ?? next;
      toast(
        next === "off"
          ? "已关掉外部接入 —— 旧令牌立刻作废"
          : `已切到「${label}」—— 换了一枚对应授权的令牌（旧那枚立刻作废）`,
        next === "write_confirm" ? "info" : "success",
      );
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
      setErr("");
      toast("已换一枚新令牌 —— 旧的那枚立刻作废", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
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

  // 给 agent 的配置片段：**路径取自后端读数** ✓（界面不猜路径 ✗）；桥的路径由用户/README 指 ✓
  const snippet = st
    ? [
        "{",
        '  "mcpServers": {',
        '    "shuyonote": {',
        '      "command": "node",',
        '      "args": ["<桥的路径：本仓 tools/shuyonote-mcp/index.mjs>"],',
        '      "env": {',
        `        "SHUYONOTE_MCP_TOKEN_FILE": "${st.token_path ?? ""}",`,
        `        "SHUYONOTE_MCP_PORT_FILE": "${st.port_path ?? ""}"`,
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n")
    : "";

  return (
    <div className="mcp-access">
      <section className="set-section">
        <div className="set-section-title">接入档位</div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">外部 AI 能做什么</div>
            <div className="set-row-sub">{LEVELS.find(([id]) => id === level)?.[2] ?? ""}</div>
          </div>
        </div>

        <div className="ai-settings-tabs" role="tablist" aria-label="外部 AI 接入档位">
          {LEVELS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={level === id}
              aria-label={label}
              className={`ai-settings-tab${level === id ? " is-on" : ""}`}
              disabled={busy || !st}
              onClick={() => void setLevel(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="set-hint">
          换档＝**换一枚新令牌** ✓（旧那枚立刻作废）。⛔ 授权面不会超过「读笔记 ＋ 新建页面／追加内容」✗。
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-title">现在是什么状态</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name mcp-access-state">
              <span className={`mcp-access-dot${st?.enabled ? " is-on" : ""}`} aria-hidden="true" />
              {st ? stateLine(st) : "读取中…"}
            </div>
            {st?.env_override && (
              <div className="set-row-sub">
                ⚠️ 这次是被<b>环境变量</b>打开的（<code>SHUYONOTE_MCP_SWITCH=on</code>）—— 面板关不掉它，
                要在启动环境里去掉。
              </div>
            )}
            {err && <div className="set-row-sub mcp-access-err">读/改状态失败：{err}</div>}
          </div>
          <button className="set-btn" disabled={busy || !st} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-title">会话令牌</div>
        <p className="set-hint">
          这枚令牌只在本机读写；它写在一个只有你自己能读的文件里（
          <code>{st?.token_path ?? "（未知）"}</code>）。换一枚 ⇒ 旧的立刻作废。
        </p>
        <div className="mcp-access-token">
          <code className="mcp-access-token-text">{st?.token ?? "（还没有 —— 打开开关时会自动生成）"}</code>
        </div>
        <div className="set-actions">
          <button
            className="set-btn is-primary"
            disabled={!st?.token}
            onClick={() => void copy(String(st?.token ?? ""), "令牌")}
          >
            复制令牌
          </button>
          <button className="set-btn" disabled={busy || !st} onClick={() => void rotate()}>
            换一枚新令牌
          </button>
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-title">给 AI 的配置</div>
        <p className="set-hint">
          把下面这段粘进 AI 客户端的 MCP 配置即可。桥在仓库里
          （<code>tools/shuyonote-mcp/index.mjs</code>）—— 把 <code>args</code> 换成你机器上那个路径；
          两个环境变量指的就是上面那两个文件。
        </p>
        <pre className="mcp-access-snippet">{snippet}</pre>
        <div className="set-actions">
          <button className="set-btn is-primary" disabled={!snippet} onClick={() => void copy(snippet, "配置片段")}>
            复制配置
          </button>
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-title">它能做什么</div>
        <p className="set-hint">
          <b>读</b>：列页面、搜页面、看块与反链、读附件。<b>提改动</b>：新建页面／追加内容
          （默认要你点确认；开了免确认才直接写，而那时每一次写都会留一行审计）。
          你能在「审计」里看到每一次调用（谁、什么时候、调了什么、成功还是失败）。
          ⛔ 它<b>不能</b>绕开权限：和插件走的是同一处鉴权与同一本审计账。
        </p>
      </section>
    </div>
  );
}
