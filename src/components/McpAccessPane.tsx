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

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      setSt(await api.mcpSetEnabled(next));
      setErr("");
      toast(
        next ? "外部接入已打开（只绑本机；令牌见下面那一段）" : "外部接入已关闭 —— 旧令牌立刻作废",
        "success",
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleWrite = async (next: boolean) => {
    setBusy(true);
    try {
      setSt(await api.mcpSetAllowWrite(next));
      setErr("");
      toast(
        next ? "已允许外部 AI 直接写入 —— 每一次写都会留审计" : "已关回「要你确认」—— 外部写只进待确认队列",
        next ? "info" : "success",
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
        <div className="set-section-title">接入开关</div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">允许外部 AI 接入（MCP）</div>
            <div className="set-row-sub">
              打开后，外部的 AI 助手（Claude Code、DSH/WorkBuddy 这类）能<b>读</b>这个库里的笔记，
              也能<b>提改动</b>（新建页面／追加内容）；<b>只绑本机</b>（同一个 Wi-Fi 下的其它设备也连不上），
              并且要下面那枚令牌。默认<b>关</b>；关掉时每个请求立刻被拒、旧令牌作废。
            </div>
          </div>
          {/* ⚠️ 本仓这颗开关的契约（照 `AiSettingsForm.tsx:271` 等现有写法 ✓）：
              开 ⇒ 加类名 **`on`**（⛔ 不是 `is-on` ✗ —— 那个类名**根本不存在** ✗），
              并且**必须**带一个 `.ui-toggle-knob` 子元素 ✓（那个圆钮就是它 ✓，CSS 在 `App.css:13598` ✓）。
              owner 2026-10-06 截图问「开关按钮不对劲吧？」—— 就是因为这两条我都没照做 ✗：
              类名写错 ⇒ 没有"开着"的底色；没有 knob ⇒ 只剩一颗**空胶囊** ✗。 */}
          <button
            className={`ui-toggle ${st?.enabled ? "on" : ""}`}
            role="switch"
            aria-checked={st?.enabled === true}
            aria-label="允许外部 AI 接入（MCP）"
            disabled={busy || !st}
            onClick={() => void toggle(!(st?.enabled === true))}
          >
            <span className="ui-toggle-knob" />
          </button>
        </div>

        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">允许外部 AI 直接写入（免确认）</div>
            <div className="set-row-sub">
              <b>默认关闭</b>。关着时：外部 AI 的新建页面／追加内容<b>不会直接落库</b> —— 它会变成一条
              「待你确认」的改动，你点确定才写；而且它<b>连写工具都看不到</b>。开着时：不再问你、直接写；
              作为交换，<b>每一次写都会留一行审计</b>（哪个外部会话、什么时候、调了什么能力、成功还是失败）。
            </div>
          </div>
          <button
            className={`ui-toggle ${st?.allow_write ? "on" : ""}`}
            role="switch"
            aria-checked={st?.allow_write === true}
            aria-label="允许外部 AI 直接写入（免确认）"
            disabled={busy || !st}
            onClick={() => void toggleWrite(!(st?.allow_write === true))}
          >
            <span className="ui-toggle-knob" />
          </button>
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
