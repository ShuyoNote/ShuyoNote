// Right drawer combining CommentsPanel + NotificationCenter (P1). Controlled by
// the shared rightPanel store so it stays mutually exclusive with AI / TOC.
//
// ⚠️ 2026-10-01：页签状态**搬到 store** 了（`rightPanel.commentsTab` ✓）—— 因为顶栏把入口
// 拆成了**两颗**（「讨论」／「通知」✓），"点哪颗进哪页"必须由入口那侧决定 ✓；
// 抽屉自己 hold `useState` 的话，那颗「通知」点开还是会落在讨论页 ✗。
import { useRightPanel } from "../store/rightPanel";
import { useSpaceStore } from "../store/space";
import { showsNotifications } from "../lib/syncTag";
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
  // ⭐ 2026-10-18（owner：「抽屉面板里面的通知也去掉」）：**「通知」这一页在个人空间里整个不出现** ✓。
  //    规则仍旧只有一处（`lib/syncTag.ts::showsNotifications` ✓，⛔ 不在这里写 `kind === "team"` ✗）。
  //    ⚠️ 还要防"状态残留"：`commentsTab` 在 store 里，别的入口（命令面板 `panels.notifications`）
  //    可能已经把它设成 `notifications` ⇒ 个人空间里**回落**到「评论」，⛔ 不许渲染出一页空的「通知」✗。
  const spaceKind = useSpaceStore((s) => s.spaces.find((w) => w.id === s.activeId)?.kind);
  const withNotifications = showsNotifications(spaceKind);
  const effectiveTab = withNotifications ? tab : "comments";

  if (!open) return null;

  return (
    <div className="comments-drawer">
      <div className="comments-drawer-tabs">
        <button className={effectiveTab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>评论</button>
        {withNotifications && (
          <button
            className={tab === "notifications" ? "active" : ""}
            onClick={() => setTab("notifications")}
            data-testid="drawer-tab-notifications"
          >
            通知
          </button>
        )}
        <button className="comments-drawer-close" onClick={() => setOpen(false)} title="关闭">×</button>
      </div>
      <div className="comments-drawer-body">
        {effectiveTab === "comments" ? <CommentsPanel /> : <NotificationCenter />}
      </div>
    </div>
  );
}
