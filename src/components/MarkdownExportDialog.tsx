// 「导出」对话框（C 弹窗，2026-10-18）—— 两个入口（导出当前页… / 导出本空间…）共用这一个浮层 ✓。
//
// 为什么要有它（owner 的 C 方案）：命令面板里现在有四条导出命令，用户得先想"我要哪种形态"；
// 这里收成**一个对话框**：先看**预估**，再勾三件事，点开始 ⇒ 由 `lib/exportMarkdownDialog.ts` 执行 ✓。
// ⚠️ 四条旧命令**一条没删**（`builtinCommands.ts`）—— 新入口要 owner 真机验过再收 ✓。
//
// 浮层纪律（`check-overlay-registry` 守的那条）：
// · 打开时锁内容区滚动（`useOverlayScrollLock` ✓）；
// · **登记进返回栈**（`useOverlayLayer("markdownExport", …)` ✓）—— 不登记 ⇒ 安卓返回键直接退出应用 ✗。
// · 容器类名复用 `.confirm-overlay` / `.confirm-box`（同一套几何、已登记已量 ✓）＋ 自己的
//   `.md-export-*` 子类做排版（不新增"-overlay/-popover"容器 ⇒ 不引入新的未验几何 ✓）。
import { useEffect, useState } from "react";
import { useExportDialog } from "../store/exportDialog";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import {
  estimateBundleText,
  estimateExportScope,
  ExportReportedError,
  type ExportEstimate,
} from "../lib/exportMarkdownBundle";
import { runDialogExport } from "../lib/exportMarkdownDialog";

const rowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start", margin: "8px 0" };
const labelStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", cursor: "pointer" };
const hintStyle: React.CSSProperties = { margin: "2px 0 0 24px", opacity: 0.72, fontSize: "0.86em", lineHeight: 1.5 };
const boxStyle: React.CSSProperties = { maxWidth: 520, textAlign: "left" };

export function MarkdownExportDialog() {
  const open = useExportDialog((s) => s.open);
  const target = useExportDialog((s) => s.target);
  const pageId = useExportDialog((s) => s.pageId);
  const close = useExportDialog((s) => s.close);
  useOverlayScrollLock(open);
  useOverlayLayer("markdownExport", open, close);

  const [withAttachments, setWithAttachments] = useState(true);
  const [yaml, setYaml] = useState(false);
  const [flat, setFlat] = useState(false);
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 每次打开都回到默认勾选，并**重新估一次**（⛔ 不沿用上一次的读数 ✗ —— 页/附件可能已经变了）
  useEffect(() => {
    if (!open) return;
    setWithAttachments(true);
    setYaml(false);
    setFlat(false);
    setBusy(false);
    setResult(null);
    setEstimate(null);
    setEstimateError(null);
    let alive = true;
    const run =
      target === "space"
        ? estimateExportScope({ kind: "space" })
        : estimateExportScope({ kind: "page", pageId: pageId ?? "" });
    run
      .then((e) => {
        if (alive) setEstimate(e);
      })
      .catch((e) => {
        // 预估拿不到**不挡导出** ✓，但要如实说"拿不到"（⛔ 不编一个数字 ✗）
        if (alive) setEstimateError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open, target, pageId]);

  if (!open) return null;

  const estimateLine = estimateError
    ? `预估拿不到（${estimateError}）—— 仍可直接导出`
    : estimate
      ? `预估：${estimateBundleText(
          estimate.pageCount,
          estimate.assetCount,
          estimate.knownBytes,
          estimate.unknownSize,
        )}${estimate.unreadable ? ` · 另有 ${estimate.unreadable} 处附件清单没列出来` : ""}`
      : "正在估算…";

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const msg = await runDialogExport({
        target,
        pageId: pageId ?? "",
        withAttachments,
        yaml,
        flat: withAttachments ? flat : true, // 纯 .md 那条路本来就是平铺（见执行层文件头 ✓）
      });
      setResult(msg); // 结果由**进度 toast** 与这里的正文各说一次（浮层里看得见，不用再弹一条 ✗）
    } catch (e) {
      // 进度 toast 已经如实变成失败（`ExportReportedError`）⇒ 这里只把同一句显示在浮层里 ✓
      setResult(
        e instanceof ExportReportedError
          ? e.message
          : `导出失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="confirm-overlay" onClick={() => !busy && close()}>
      <div className="confirm-box md-export-box" style={boxStyle} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-head">
          <span className="confirm-title">{target === "page" ? "导出当前页" : "导出本空间"}</span>
        </div>
        <div className="confirm-message">
          <div style={rowStyle}>
            <label style={labelStyle}>
              <input
                type="checkbox"
                checked={withAttachments}
                disabled={busy}
                onChange={(e) => setWithAttachments(e.target.checked)}
              />
              附件（打包 zip）
            </label>
          </div>
          <div style={hintStyle}>
            勾选 ⇒ 产出 zip（.md ＋ assets/ 附件，正文引用换成相对路径）；不勾 ⇒ 只产出 .md（不带附件）
          </div>
          <div style={rowStyle}>
            <label style={labelStyle}>
              <input type="checkbox" checked={yaml} disabled={busy} onChange={(e) => setYaml(e.target.checked)} />
              元数据 YAML
            </label>
          </div>
          <div style={hintStyle}>每份 .md 顶部写 title / id / kind 的 YAML front matter（机读）</div>
          <div style={rowStyle}>
            <label style={labelStyle}>
              <input
                type="checkbox"
                checked={withAttachments ? flat : true}
                disabled={busy || !withAttachments}
                onChange={(e) => setFlat(e.target.checked)}
              />
              纯 .md 平铺
            </label>
          </div>
          <div style={hintStyle}>
            不按页面树建目录（zip 内全部 .md 放根）；不勾附件时本来就是平铺
          </div>
        </div>
        <div className="md-export-estimate" style={{ ...hintStyle, margin: "10px 0 0" }} data-testid="md-export-estimate">
          {estimateLine}
        </div>
        {result && (
          <div className="md-export-result" style={{ marginTop: 10, lineHeight: 1.5 }} data-testid="md-export-result">
            {result}
          </div>
        )}
        <div className="confirm-actions">
          <button className="confirm-cancel" disabled={busy} onClick={close}>
            关闭
          </button>
          <button className="confirm-ok" disabled={busy} onClick={() => void start()}>
            {busy ? "正在导出…" : "开始导出"}
          </button>
        </div>
      </div>
    </div>
  );
}
