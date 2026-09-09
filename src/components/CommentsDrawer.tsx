// Right drawer combining CommentsPanel + NotificationCenter (P1). Controlled by
// the shared rightPanel store so it stays mutually exclusive with AI / TOC.
import { useState } from "react";
import { useRightPanel } from "../store/rightPanel";
import { CommentsPanel } from "./CommentsPanel";
import { NotificationCenter } from "./NotificationCenter";

export function CommentsDrawer() {
  const open = useRightPanel((s) => s.comments);
  const setOpen = useRightPanel((s) => s.openComments);
  const [tab, setTab] = useState<"comments" | "notifications">("comments");

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
