import { type OutlineItem } from "../lib/pdfRender";

// M24 — 左侧目录（书签）树。来自 pdf.js `doc.getOutline()`（已在引擎 loadPdf 时
// 取好，存进 PdfReader 的 outline state）。点击目录项跳转到对应页。

interface Props {
  outline: OutlineItem[];
  currentPage: number;
  onJump: (pageIndex: number) => void;
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

export function PdfOutline({ outline, currentPage, onJump }: Props) {
  if (!outline || outline.length === 0) {
    return (
      <div className="pdf-outline-empty">
        <div className="pdf-outline-empty-title">目录</div>
        <div className="pdf-outline-empty-sub">此 PDF 没有书签/目录。</div>
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
