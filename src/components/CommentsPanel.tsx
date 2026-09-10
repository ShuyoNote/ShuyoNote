// P1 comments panel: list/add/delete comments and @mentions for the current page.
// Reads the active sync profile (server+token+space) and current page id.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";

interface Comment {
  id: string;
  parent_id?: string | null;
  author_id: string;
  /** 服务端 JOIN users 带出的邮箱；老服务端可能没有，届时退回 id 前缀。 */
  author_email?: string | null;
  body: string;
  created_at: number;
}

export function CommentsPanel() {
  const currentId = useNotes((s) => s.currentId);
  const activeId = useSpaceStore((s) => s.activeId);
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<{ server_url: string; token: string; space_id: string } | null>(null);

  // Resolve the active profile for presence/commenting.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profiles = await api.listSyncProfiles();
        const p = profiles.find((x) => x.ws_id === activeId);
        if (p && p.server_url && p.space_id && p.token) {
          if (!cancelled) setProfile({ server_url: p.server_url, token: p.token, space_id: p.space_id });
          else if (!cancelled) setProfile(null);
        } else if (!cancelled) setProfile(null);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  const load = useCallback(async () => {
    if (!profile || !currentId) return;
    setLoading(true);
    try {
      const items = (await api.teamListComments(profile.server_url, profile.token, profile.space_id, currentId)) as Comment[];
      setComments(Array.isArray(items) ? items : []);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [profile, currentId]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!profile || !currentId || !body.trim()) return;
    setError("");
    try {
      await api.teamAddComment(profile.server_url, profile.token, profile.space_id, currentId, body.trim());
      setBody("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const del = async (id: string) => {
    if (!profile) return;
    try {
      await api.teamDeleteComment(profile.server_url, profile.token, profile.space_id, id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="comments-panel">
      <div className="comments-head">
        <strong>评论</strong>
        {profile ? <span className="comments-count">{comments.length}</span> : <span className="comments-noauth">未绑定空间</span>}
      </div>
      {error && <div className="comments-error">{error}</div>}
      <div className="comments-list">
        {comments.length === 0 && !loading && <div className="comments-empty">还没有评论</div>}
        {comments.map((c) => (
          <div key={c.id} className="comment-item">
            <div className="comment-meta">
              <span className="comment-author" title={c.author_email ?? c.author_id}>
                {c.author_email ?? c.author_id.slice(0, 8)}
              </span>
              <span className="comment-time">{new Date(c.created_at).toLocaleString()}</span>
              <button className="comment-del" onClick={() => void del(c.id)} title="删除评论">×</button>
            </div>
            <div className="comment-body">{c.body}</div>
          </div>
        ))}
      </div>
      <div className="comments-input">
        <textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="写下评论，用 @ 提及成员"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void add(); }
          }}
        />
        <div className="comments-actions">
          <button onClick={() => void add()} disabled={!body.trim()}>评论</button>
        </div>
      </div>
    </div>
  );
}
