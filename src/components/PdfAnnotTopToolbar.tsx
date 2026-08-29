// 方案 B — PDF 阅读器顶部的单一批注工具栏（固定在视图顶部）。
// 作用于「当前活动页」：工具选择是全局共享（所有页用同一工具），
// 撤销/导出/删除/摘录/AI/复制/便签编辑/OCR 走当前页的控制器句柄。
import { useMemo } from "react";
import type { PdfPageController, AnnotTool, PdfPageState } from "./pdfAnnotController";
import { TOOLS } from "./pdfAnnotController";

interface Props {
  /** 当前活动页控制器（无则禁用大部分操作）。 */
  ctl: PdfPageController | null;
  /** 版本号：页状态变化时递增，触发本组件重读 ctl.getState()。 */
  version: number;
  tool: AnnotTool;
  onToolChange: (t: AnnotTool) => void;
}

const _iconFor: Record<AnnotTool, string> = {
  select: "M4 4l7.5 16 2-6.5L20 11.5z",
  highlight: "M9 11l4 4L19 9a2 2 0 0 0-3-3l-6 6H9z",
  ink: "M12 19l7-7a2 2 0 0 0-3-3l-7 7v3h3z",
  sticky: "M4 5h16v10l-5 5H4z",
};

export function PdfAnnotTopToolbar({ ctl, version, tool, onToolChange }: Props) {
  // version 变化 → 重读当前页状态快照（撤销/选中/批注数等）。
  const st: PdfPageState = useMemo(() => (ctl ? ctl.getState() : nullSt()), [ctl, version]);

  const toolBtn = (id: AnnotTool, label: string, hint: string) => (
    <button
      key={id}
      className={`pdf-annot-tool ${tool === id ? "active" : ""}`}
      onClick={() => onToolChange(id)}
      title={hint}
      aria-pressed={tool === id}
    >
      <span className="pdf-annot-tool-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={_iconFor[id]} /></svg>
      </span>
      <span className="pdf-annot-tool-label">{label}</span>
    </button>
  );

  return (
    <div className="pdf-annot-toolbar">
      <div className="pdf-annot-tools" role="toolbar" aria-label="批注工具">
        {TOOLS.map((t) => toolBtn(t.id, t.label, t.hint))}
        <button
          className={`pdf-annot-tool ${st.canUndo ? "" : "disabled"}`}
          onClick={() => ctl?.undo()}
          disabled={!st.canUndo}
          title="撤销上次批注"
        >
          <span className="pdf-annot-tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 13" /></svg>
          </span>
          <span className="pdf-annot-tool-label">撤销</span>
        </button>
        <button
          className={`pdf-annot-tool ${st.annotationsCount ? "" : "disabled"}`}
          onClick={() => ctl?.exportAnnotations()}
          disabled={!st.annotationsCount}
          title="把本页全部批注导出为笔记块（含 pdf:// 回链）"
        >
          <span className="pdf-annot-tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
          </span>
          <span className="pdf-annot-tool-label">导出批注</span>
        </button>
      </div>
      <div className="pdf-annot-actions">
        {st.selected ? (
          <>
            <button className="pdf-annot-tool accent" onClick={() => ctl?.excerpt()} title="把选中内容摘录为笔记块（含 pdf:// 回链）">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
              <span>摘录成块</span>
            </button>
            <button className="pdf-annot-tool accent" onClick={() => ctl?.aiRead()} disabled={st.aiBusy} title="AI 总结这段 PDF 文字，生成笔记块（含 pdf:// 回链）">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" /></svg>
              <span>{st.aiBusy ? "AI 中…" : "AI 帮读"}</span>
            </button>
            {st.selectedType === "sticky" && (
              <button className="pdf-annot-tool" onClick={() => ctl?.editSticky()} title="编辑便签内容">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                <span>编辑</span>
              </button>
            )}
            <button className="pdf-annot-tool" onClick={() => ctl?.copyRef()} title="复制 PDF 引用（可粘贴到别处回链）">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
              <span>复制引用</span>
            </button>
            <button className="pdf-annot-tool danger" onClick={() => ctl?.deleteSelected()} title="删除选中标注">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
              <span>删除</span>
            </button>
          </>
        ) : (
          <span className="pdf-annot-tip">先在页面选中一条标注，即可摘录、复制引用或删除</span>
        )}
      </div>
      {/* 页面能力提示条：文本层状态 + OCR（无文本层时） */}
      <div className="pdf-annot-status">
        <span className={`pdf-annot-layer ${st.hasTextLayer ? "ok" : "warn"}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {st.hasTextLayer ? <path d="M20 6L9 17l-5-5" /> : <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
          </svg>
          {st.hasTextLayer ? "有文本层，可精确划词" : "无文本层，建议用矩形/画笔/便签"}
        </span>
        {!st.hasTextLayer && (
          <div className="pdf-annot-ocr-actions">
            <button className="pdf-annot-ocr" onClick={() => ctl?.runOcr()} disabled={st.ocrBusy}>
              {st.ocrBusy ? "识别中…" : "OCR 识别本页"}
            </button>
            <button className="pdf-annot-ocr pdf-annot-ocr-ai" onClick={() => ctl?.visionOcr()} disabled={st.ocrBusy} title="用 AI 视觉大模型识别本页文字（对中文/复杂排版通常更准，需配置支持图像的模型）">
              AI 识别
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function nullSt(): PdfPageState {
  return { selected: null, selectedType: null, annotationsCount: 0, canUndo: false, hasTextLayer: false, ocrBusy: false, aiBusy: false };
}
