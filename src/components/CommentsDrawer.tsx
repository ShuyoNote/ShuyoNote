// Right drawer combining CommentsPanel + NotificationCenter (P1). Controlled by
// the shared rightPanel store so it stays mutually exclusive with AI / TOC.
//
// ⚠️ 2026-10-01：页签状态**搬到 store** 了（`rightPanel.commentsTab` ✓）—— 因为顶栏把入口
// 拆成了**两颗**（「讨论」／「通知」✓），"点哪颗进哪页"必须由入口那侧决定 ✓；
// 抽屉自己 hold `useState` 的话，那颗「通知」点开还是会落在讨论页 ✗。
import { useRightPanel } from "../store/rightPanel";
import { CommentsPanel } from "./CommentsPanel";
import { NotificationCenter } from "./NotificationCenter";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

export function CommentsDrawer() {
  const open = useRightPanel((s) => s.comments);
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("comments", open, () => useRightPanel.getState().openComments(false));
  const setOpen = useRightPanel((s) => s.openComments);
  const tab = useRightPanel((s) => s.commentsTab);
  const setTab = useRightPanel((s) => s.setCommentsTab);

  if (!open) return null;

  return (
    <div className="comments-drawer">
      <div className="comments-drawer-tabs">
        <button className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>评论</button>
        <button className={tab === "notifications" ? "active" : ""} onClick={() => setTab("notifications")}>通知</button>
        <button className="comments-drawer-close" onClick={() => setOpen(false)} title="关闭">×</button>
      </div>
      <div className="comments-drawer-body">
        {tab === "comments" ? <CommentsPanel /> : <NotificationCenter />}
      </div>
    </div>
  );
}
