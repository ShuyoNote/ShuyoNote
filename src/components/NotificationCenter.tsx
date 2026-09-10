// P1 notification center: list unread/read notifications, mark seen, jump to page.
// Reads the active sync profile (server+token); notifications are global per user.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { useRightPanel } from "../store/rightPanel";

interface Notif {
  id: string;
  kind: string;
  actor_id: string;
  /** 服务端 JOIN users 带出的触发者邮箱（text 里也含），老服务端可能没有。 */
  actor_email?: string | null;
  space_id?: string | null;
  page_id?: string | null;
  text: string;
  seen: number;
  created_at: number;
}

export function NotificationCenter() {
  const activeId = useSpaceStore((s) => s.activeId);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<{ server_url: string; token: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profiles = await api.listSyncProfiles();
        const p = profiles.find((x) => x.ws_id === activeId);
        if (p && p.server_url && p.token) {
          if (!cancelled) setProfile({ server_url: p.server_url, token: p.token });
          else if (!cancelled) setProfile(null);
        } else if (!cancelled) setProfile(null);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const items = (await api.teamListNotifications(profile.server_url, profile.token)) as Notif[];
      setNotifs(Array.isArray(items) ? items : []);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [profile]);

  useEffect(() => { void load(); }, [load]);

  const seenOne = async (id: string) => {
    if (!profile) return;
    try { await api.teamSeenNotification(profile.server_url, profile.token, id); await load(); } catch (e) { setError(String(e)); }
  };
  const seenAll = async () => {
    if (!profile) return;
    try { await api.teamSeenAllNotifications(profile.server_url, profile.token); await load(); } catch (e) { setError(String(e)); }
  };

  const unread = notifs.filter((n) => n.seen === 0).length;

  /**
   * 点通知：标记已读 + **跳到目标**。
   *
   * 通知的全部意义就是「有人 @ 了你，去看那一条」。只标已读不跳转，用户还得
   * 自己回想是哪个空间哪一页——多空间下基本等于找不到。通知里带着
   * space_id / page_id，之所以还要先切空间，是因为通知是**按用户全局**的，
   * 目标页可能在另一个空间里。
   */
  const jumpTo = async (n: Notif) => {
    if (n.seen === 0) void seenOne(n.id);
    try {
      if (n.space_id && n.space_id !== activeId) {
        const ok = await useSpaceStore.getState().switchTo(n.space_id);
        if (ok) await useNotes.getState().loadPages();
      }
      if (n.page_id) {
        await useNotes.getState().openPage(n.page_id);
        // 已经跳到目标了，抽屉自己让开，别挡着内容。
        useRightPanel.getState().openComments(false);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="notif-center">
      <div className="notif-head">
        <strong>通知</strong>
        {unread > 0 ? <span className="notif-unread">{unread} 未读</span> : <span className="notif-read">全部已读</span>}
        {unread > 0 && <button className="notif-seen-all" onClick={() => void seenAll()}>全部已读</button>}
      </div>
      {error && <div className="notif-error">{error}</div>}
      <div className="notif-list">
        {notifs.length === 0 && <div className="notif-empty">没有通知</div>}
        {notifs.map((n) => (
          <div
            key={n.id}
            className={`notif-item${n.seen === 0 ? " is-unread" : ""}${n.page_id ? " is-clickable" : ""}`}
            title={n.page_id ? "点击跳转到目标页面" : undefined}
            onClick={() => void jumpTo(n)}
          >
            <div className="notif-text">{n.text}</div>
            <div className="notif-meta">{n.kind} · {new Date(n.created_at).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
