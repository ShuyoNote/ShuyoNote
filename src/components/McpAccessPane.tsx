// MCP 接入（R89 的**开关面** ✓）：开关 ＋ 可见状态 ＋ 令牌 ＋ 一段可以粘给 agent 的配置 ✓。
//
// owner 2026-10-06 拍板（白话三问）：**允许外部 AI 读**（默认关、只绑本机、要令牌、关掉立即失效 ✓）
// ＋ **设置里必须有开关与可见状态** ✓。这一节就是那个开关面 —— 所有事实都来自后端
// （`mcp_status` / `mcp_set_enabled` / `mcp_rotate_token` ✓，见 `src-tauri/src/mcp_channel.rs`），
// 界面**不自己推断**任何一条状态 ✓（"在不在听"这类事实只能有一个来源 ✓）。
//
// ⚠️ 三条口径写在界面上（用户要看得见 ✓）：
//   ① **默认关**：没打开时后端根本不起监听 ✓（不是"开着只是没显示" ✗）；
//   ② **只绑本机**：`127.0.0.1` ⇒ 同一个 Wi-Fi 下的设备也连不上 ✓；
//   ③ **关掉立即失效**：关的时候每个请求都会被拒 ＋ 重新打开会**换一枚新令牌** ✓（旧令牌作废 ✓）。
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { McpStatus } from "../types";

/** 一句人话的中间态（"开着但没在听"必须说出来 —— 那通常是端口被占 ✓）。 */
function stateLine(st: McpStatus): string {
  if (!st.enabled) return "已关闭（默认）";
  if (st.running) return `已打开 —— 只绑本机 127.0.0.1:${st.port ?? "?"}`;
  return "开关是开着的，但监听没起来（端口可能被占）—— 这一刻连不上 ✓";
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
        next ? "外部接入已打开（只绑本机 ✓；令牌见下面那一段）" : "外部接入已关闭 —— 旧令牌立刻作废 ✓",
        "success",
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
      toast("已换一枚新令牌 —— 旧的那枚立刻作废 ✓", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what}已复制 ✓`, "success");
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
      <div className="set-row">
        <div className="set-row-main">
          <div className="set-row-title">允许外部 AI 接入（MCP）</div>
          <div className="set-row-hint">
            打开后，外部的 AI 助手（Claude Code、DSH/WorkBuddy 这类）能**读**这个库里的笔记；
            <b>只绑本机</b>（同一个 Wi-Fi 下的其它设备也连不上 ✓），并且要下面那枚令牌 ✓。
            默认**关**；关掉时每个请求立刻被拒、旧令牌作废 ✓。
          </div>
        </div>
        <button
          className={`ui-toggle${st?.enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={st?.enabled === true}
          aria-label="允许外部 AI 接入（MCP）"
          disabled={busy || !st}
          onClick={() => void toggle(!(st?.enabled === true))}
        />
      </div>

      {err && <div className="set-row-hint mcp-access-err">读/改状态失败：{err}</div>}

      <div className="set-row">
        <div className="set-row-main">
          <div className="set-row-title">现在是什么状态</div>
          <div className="set-row-hint">{st ? stateLine(st) : "读取中…"}</div>
          {st?.env_override && (
            <div className="set-row-hint">
              ⚠️ 这次是被**环境变量**打开的（`SHUYONOTE_MCP_SWITCH=on`）—— 面板关不掉它，要在启动环境里去掉 ✓。
            </div>
          )}
        </div>
      </div>

      <div className="set-row">
        <div className="set-row-main">
          <div className="set-row-title">会话令牌</div>
          <div className="set-row-hint">
            这枚令牌只在本机读写 ✓；它写在一个只有你自己能读的文件里（
            <code>{st?.token_path ?? "（未知）"}</code>）✓。换一枚 ⇒ 旧的立刻作废 ✓。
          </div>
          <div className="mcp-access-token">
            <code className="mcp-access-token-text">{st?.token ?? "（还没有 —— 打开开关时会自动生成）"}</code>
          </div>
          <div className="mcp-access-actions">
            <button
              className="settings-btn"
              disabled={!st?.token}
              onClick={() => void copy(String(st?.token ?? ""), "令牌")}
            >
              复制令牌
            </button>
            <button className="settings-btn" disabled={busy || !st} onClick={() => void rotate()}>
              换一枚新令牌
            </button>
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="set-row-main">
          <div className="set-row-title">给 AI 的配置（直接粘进它的 MCP 配置）</div>
          <div className="set-row-hint">
            桥在仓库里（<code>tools/shuyonote-mcp/index.mjs</code> ✓）—— 把 <code>args</code> 换成你机器上那个路径；
            两个环境变量指的就是上面那两个文件 ✓。
          </div>
          <pre className="mcp-access-snippet">{snippet}</pre>
          <div className="mcp-access-actions">
            <button className="settings-btn" disabled={!snippet} onClick={() => void copy(snippet, "配置片段")}>
              复制配置
            </button>
            <button className="settings-btn" disabled={busy || !st} onClick={() => void refresh()}>
              刷新状态
            </button>
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="set-row-hint">
          它**能做什么**：只读（列页面、搜页面、看块与反链、读附件、看索引覆盖）✓ ——
          你能在「审计」里看到每一次调用（谁、什么时候、调了什么、成功还是失败 ✓）；
          ⛔ 它**不能**绕开权限：和插件走的是**同一处**鉴权与同一本审计账 ✓。
        </div>
      </div>
    </div>
  );
}
