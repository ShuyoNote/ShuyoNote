// P1「连接体检」对话框：把 `meshDiagnose.ts` 算好的体检项摆出来，并提供
// 「重新读取 / 复制诊断包 / 关闭」三个动作。
//
// ## 三条口径（与 SyncPanel / personalSyncReadout 同源）
// · **只摆，不判定**：级别、原因、下一步全由 `diagnoseMesh()` 这个纯函数给（⛔ 组件里不自己再判一次档 ✗，
//   否则同一个读数会有两套解释）；组件只负责分组顺序与外观。
// · **不显示内部标识**：项标题来自 `title`，显示主体来自 `subject`（设备名）—— ⛔ 不出现 `device_id` /
//   地址 / 配对秘密 ✗（`INV-UI-copy-no-internal-ids`）。诊断包本身由 `meshDiagnosticText()` 生成，
//   那里已经把设备名/地址也摘掉了（见该文件头第 3 条）。
// · **读不到就写未知**：`status` 为 `null`（命令读不到/旧构建）时 `diagnoseMesh()` 只产一条 unknown，
//   这里照摆 —— ⛔ 不许摆成"一切正常" ✗。
//
// ## 为什么复用 `.confirm-overlay` / `.confirm-box` 这套壳
// 它是仓内既有的**居中模态**外观（底色/圆角/阴影/层级 1400 都在 `src/styles/confirm.css` 里 ✓）；
// 这里只把宽度与滚动改成"体检清单"需要的形状（多行、可滚）。⛔ 不新增 CSS 文件 ✗（本笔写域只有
// 4 个前端文件，样式一律复用既有类）。
// ⚠️ 如实交代一条**未验证项**：`check-overlay-registry` 的移动端几何验收按**类名**认层
// （`scripts/verify-mobile-overlays.mjs` 的 `OVERLAYS`），这里复用了 `.confirm-overlay`
// ⇒ 这一层的窄屏几何**没有单独被测过**（脚本里没有本对话框的条目，而加一条要改那个脚本 —— 超本笔写域）。
// 它仍然登记了返回栈（`useOverlayLayer("mesh-diagnose", …)`），所以安卓返回键能先关它 ✓。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { LanStatus, MeshRoundReport } from "../lib/platform/commands";
import {
  LEVEL_LABEL,
  diagnoseMesh,
  meshDiagnosticText,
  type DiagnoseItem,
} from "../lib/meshDiagnose";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { inlineMd } from "../lib/inlineMd";
import { toast } from "../store/toast";

export interface MeshDiagnoseDialogProps {
  open: boolean;
  /** `lan_status` 的当前读数；`null` ＝ 这一次读不到。 */
  status: LanStatus | null;
  /** 本轮 `mesh_sync_now` 的读数（可选；用于"上一轮网格同步"那一项）。 */
  round?: MeshRoundReport | null;
  /** 重新读一次 `lan_status`（由面板提供，⛔ 本组件不直接碰 api ✗）。 */
  onReload: () => Promise<void> | void;
  onClose: () => void;
}

/** 级别 → 圆点色调类（复用「附近设备」那套点；⚠️ 仓里没有 `is-bad` 的点，问题档用警示色）。 */
function dotClass(level: DiagnoseItem["level"]): string {
  if (level === "ok") return " is-ok";
  if (level === "warn" || level === "bad") return " is-warn";
  return "";
}

/** 级别 → `.sync-status` 的语义色（仓内既有三档：ok / warn / err）。 */
function statusTone(level: DiagnoseItem["level"]): "ok" | "warn" | "err" {
  if (level === "ok") return "ok";
  if (level === "warn") return "warn";
  // `unknown` 与 `bad` 都用 err 的红/警示底？——`unknown` 是"没有结论"，
  // 摆成红色会读成"出错了" ⇒ 用中性底色（`is-warn` 只给 bad）。
  return level === "bad" ? "err" : "warn";
}

export function MeshDiagnoseDialog({
  open,
  status,
  round,
  onReload,
  onClose,
}: MeshDiagnoseDialogProps) {
  useOverlayScrollLock(open);
  useOverlayLayer("mesh-diagnose", open, onClose);
  const [busy, setBusy] = useState(false);
  // 纯函数只在读数变化时重算（默认时间可能变，但用户看的是内容；at 只进诊断包）。
  const diag = useMemo(() => diagnoseMesh(status, round), [status, round]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const reload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReload();
    } catch (e) {
      toast(`重新读取失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meshDiagnosticText(diag));
      toast("诊断包已复制（不含设备号、地址与页面内容）", "success");
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  };

  return createPortal(
    <div
      className="confirm-overlay"
      data-testid="mesh-diagnose-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-box"
        role="dialog"
        aria-label="连接体检"
        aria-modal="true"
        data-testid="mesh-diagnose-dialog"
        style={{ width: "min(560px, calc(100vw - 48px))", maxHeight: "84vh", overflowY: "auto" }}
      >
        <div className="confirm-head">
          <span className="confirm-icon">✓</span>
          <span className="confirm-title">连接体检</span>
        </div>

        {/* ⭐ 总评：级别与那句话都来自纯函数（⛔ 组件里不自己数 ✗）。 */}
        <div className={`sync-status is-${statusTone(diag.overall)}`} data-testid="mesh-diagnose-headline">
          {diag.headline}
        </div>
        <div className="sync-hint" data-testid="mesh-diagnose-counts">
          好 {diag.counts.ok} · 注意 {diag.counts.warn} · 问题 {diag.counts.bad} · 未读到{" "}
          {diag.counts.unknown}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
          {diag.items.map((it) => (
            <details
              className="sync-row"
              key={it.key}
              data-testid={`mesh-diagnose-${it.key}`}
              // 好的项默认收起（不用占屏），其余默认展开（那是用户打开这个框要找的东西）。
              open={it.level !== "ok"}
            >
              <summary>
                <span className={`sync-nearby-dot${dotClass(it.level)}`} aria-hidden />
                <span className="sync-row-label">
                  {it.subject ? `${it.subject} · ` : ""}
                  {it.title}
                </span>
                <span className="sync-row-value">{LEVEL_LABEL[it.level]}</span>
                <span className="sync-row-caret" aria-hidden>
                  ›
                </span>
              </summary>
              <div className="sync-row-body">
                {/* ⭐ 原因可能含**后端原文**（「上一轮网格同步」那一项用的是 `round.note`）——
                    它按行内 Markdown 写（`**本轮…**`）⇒ 必须在这里过 `inlineMd`，否则屏上会出现星号。
                    ⚠️ 自己写的那些原因不含成对 `**` ⇒ 原样返回，一个字都不会变。 */}
                <p className={`sync-status is-${statusTone(it.level)}`}>{inlineMd(it.reason)}</p>
                <p className="sync-hint">下一步：{it.next}</p>
              </div>
            </details>
          ))}
        </div>

        <div className="confirm-actions">
          <button
            className="confirm-cancel"
            data-testid="mesh-diagnose-reload"
            disabled={busy}
            onClick={() => void reload()}
          >
            {busy ? "读取中…" : "重新读取"}
          </button>
          <button
            className="confirm-cancel"
            data-testid="mesh-diagnose-copy"
            onClick={() => void copy()}
          >
            复制诊断包
          </button>
          <button className="confirm-ok" data-testid="mesh-diagnose-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
