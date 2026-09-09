import { useRightPanel } from "../store/rightPanel";
import { SparkleIcon, ListIcon, CommentIcon } from "./icons";

// Right-edge vertical icon rail (Wolai-style launcher): a slim strip of buttons on
// the window's right edge that opens the right-side drawers (AI assistant / TOC /
// comments). The buttons are mutually exclusive via the shared rightPanel store.
export function RightRail() {
  const aiOpen = useRightPanel((s) => s.ai);
  const tocOpen = useRightPanel((s) => s.toc);
  const commentsOpen = useRightPanel((s) => s.comments);
  const openAi = useRightPanel((s) => s.openAi);
  const openToc = useRightPanel((s) => s.openToc);
  const openComments = useRightPanel((s) => s.openComments);

  return (
    <div className="right-rail">
      <button
        className={`rail-btn ${aiOpen ? "active" : ""}`}
        title="AI 助手"
        aria-label="AI 助手"
        onClick={() => openAi(!aiOpen)}
      >
        <SparkleIcon width={16} height={16} />
      </button>
      <button
        className={`rail-btn ${commentsOpen ? "active" : ""}`}
        title="评论 / 通知"
        aria-label="评论 / 通知"
        onClick={() => openComments(!commentsOpen)}
      >
        <CommentIcon width={16} height={16} />
      </button>
      <button
        className={`rail-btn ${tocOpen ? "active" : ""}`}
        title="目录"
        aria-label="目录"
        onClick={() => openToc(!tocOpen)}
      >
        <ListIcon width={16} height={16} />
      </button>
    </div>
  );
}
