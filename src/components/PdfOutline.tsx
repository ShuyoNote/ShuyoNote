import { type OutlineItem } from "../lib/pdfRender";

// M24 — 左侧目录（书签）树。来自 pdf.js `doc.getOutline()`（已在引擎 loadPdf 时
// 取好，存进 PdfReader 的 outline state）。点击目录项跳转到对应页。
// 扫描版无目录时，空态提供「AI 生成目录（本段）」按钮，从当前页往后 N 页生成并填充目录。

interface Props {
  outline: OutlineItem[];
  currentPage: number;
  onJump: (pageIndex: number) => void;
  /** 触发「AI 生成目录（本段）」。 */
  onAiGenerate?: () => void;
  /** 取消进行中的目录生成。 */
  onAiCancel?: () => void;
  /** 目录生成进行中。 */
  aiBusy?: boolean;
  /** 生成阶段（ocr=逐页识别；ai=让 AI 提取目录）。 */
  aiStage?: "ocr" | "ai";
  /** 生成进度（done/total 页）。 */
  aiProgress?: { done: number; total: number } | null;
  /** 当前生成范围（页数；-1=整本）。 */
  aiCount?: number;
  /** 切换生成范围。 */
  onAiCountChange?: (n: number) => void;
  /** 是否手工输入页数。 */
  aiCustom?: boolean;
  /** 切换手工输入。 */
  onAiCustomChange?: (b: boolean) => void;
}

function TreeNode({ node, depth, currentPage, onJump }: { node: OutlineItem; depth: number; currentPage: number; onJump: (p: number) => void }) {
  return (
    <>
      <button
        className={`pdf-outline-item${node.pageIndex === currentPage ? " active" : ""}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => onJump(node.pageIndex)}
        title={node.title || ""}
      >
        <span className="pdf-outline-caret">›</span>
        <span className="pdf-outline-title">{node.title || "（无标题）"}</span>
      </button>
      {node.children?.map((child, i) => (
        <TreeNode
          key={`${child.title}-${child.pageIndex}-${i}`}
          node={child}
          depth={depth + 1}
          currentPage={currentPage}
          onJump={onJump}
        />
      ))}
    </>
  );
}

export function PdfOutline({ outline, currentPage, onJump, onAiGenerate, onAiCancel, aiBusy, aiStage, aiProgress, aiCount = 60, onAiCountChange, aiCustom = false, onAiCustomChange }: Props) {
  const selValue = aiCustom ? "custom" : aiCount === -1 ? "-1" : String(aiCount);
  if (!outline || outline.length === 0) {
    return (
      <div className="pdf-outline-empty">
        <div className="pdf-outline-empty-title">目录</div>
        <div className="pdf-outline-empty-sub">此 PDF 没有书签/目录。</div>
        {onAiGenerate && (
          <div className="pdf-outline-ai">
            {aiBusy ? (
              <>
                <div className="pdf-outline-ai-progress">
                  {aiStage === "ai"
                    ? "正在让 AI 提取目录…"
                    : `正在识别并生成目录（${aiProgress?.done ?? 0}/${aiProgress?.total ?? 0} 页）…`}
                </div>
                <button className="pdf-outline-ai-btn" onClick={onAiCancel}>取消</button>
              </>
            ) : (
              <>
                <div className="pdf-outline-ai-range">
                  <label className="pdf-outline-ai-label">范围</label>
                  <select
                    className="pdf-outline-ai-select"
                    value={selValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "-1") { onAiCustomChange?.(false); onAiCountChange?.(-1); }
                      else if (v === "custom") { onAiCustomChange?.(true); onAiCountChange?.(aiCount === -1 ? 60 : aiCount); }
                      else { onAiCustomChange?.(false); onAiCountChange?.(Number(v)); }
                    }}
                  >
                    <option value={30}>往后 30 页</option>
                    <option value={60}>往后 60 页</option>
                    <option value={120}>往后 120 页</option>
                    <option value="custom">自定义</option>
                    <option value={-1}>整本</option>
                  </select>
                  {aiCustom && (
                    <input
                      className="pdf-outline-ai-input"
                      type="number"
                      min={1}
                      value={aiCount}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n > 0) onAiCountChange?.(n);
                      }}
                      placeholder="页数"
                      title="手工输入生成几页"
                    />
                  )}
                </div>
                <button className="pdf-outline-ai-btn" onClick={onAiGenerate} title="从当前页往后按所选范围，逐页用 AI 识别章节，生成可点击跳转、带层级的目录">
                  AI 生成目录
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="pdf-outline">
      <div className="pdf-outline-head">
        <span>目录</span>
        {onAiGenerate && (
          <button className="pdf-outline-regen" onClick={onAiGenerate} disabled={aiBusy} title="用 AI 重新生成目录（重新识别当前范围）">
            {aiBusy ? "生成中…" : "AI 重新生成"}
          </button>
        )}
      </div>
      <div className="pdf-outline-list">
        {outline.map((node, i) => (
          <TreeNode key={`${node.title}-${node.pageIndex}-${i}`} node={node} depth={0} currentPage={currentPage} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}
