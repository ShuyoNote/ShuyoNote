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
  /** 生成进度（done/total 页）。 */
  aiProgress?: { done: number; total: number } | null;
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

export function PdfOutline({ outline, currentPage, onJump, onAiGenerate, onAiCancel, aiBusy, aiProgress }: Props) {
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
                  正在识别并生成目录（{aiProgress?.done ?? 0}/{aiProgress?.total ?? 0} 页）…
                </div>
                <button className="pdf-outline-ai-btn" onClick={onAiCancel}>取消</button>
              </>
            ) : (
              <button className="pdf-outline-ai-btn" onClick={onAiGenerate} title="从当前页往后一屏一屏地 OCR 并让 AI 提取章节，生成可点击跳转的目录">
                AI 生成目录（本段）
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="pdf-outline">
      <div className="pdf-outline-head">目录</div>
      <div className="pdf-outline-list">
        {outline.map((node, i) => (
          <TreeNode key={`${node.title}-${node.pageIndex}-${i}`} node={node} depth={0} currentPage={currentPage} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}
