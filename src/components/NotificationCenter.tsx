// P1 notification center: list unread/read notifications, mark seen, jump to page.
// Reads the active sync profile (server+token); notifications are global per user.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSpaceStore } from "../store/space";

interface Notif {
  id: string;
  kind: string;
  actor_id: string;
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
          <div key={n.id} className={`notif-item${n.seen === 0 ? " is-unread" : ""}`} onClick={() => { if (n.seen === 0) void seenOne(n.id); }}>
            <div className="notif-text">{n.text}</div>
            <div className="notif-meta">{n.kind} · {new Date(n.created_at).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
