// P0.2 presence indicator: shows who is editing the current page (online members
// whose page_id matches the active page). Lightweight; reads usePresenceStore.
import { useNotes } from "../store/notes";
import { usePresenceStore } from "../store/presence";

export function PresenceBar() {
  const currentId = useNotes((s) => s.currentId);
  const online = usePresenceStore((s) => s.online);

  if (!currentId || online.length === 0) return null;

  // Members on this page (others, excluding self is hard without auth; show all
  // who report this page). Just a best-effort "who's here" prompt.
  const here = online.filter((m) => m.page_id === currentId).length;
  const total = online.length;
  if (total === 0) return null;

  return (
    <div className="presence-bar" title={`${total} 人在线${here > 0 ? ` · ${here} 人正在编辑本页` : ""}`}>
      <span className="presence-dot" aria-hidden />
      <span className="presence-text">
        {total} 人在线
        {here > 0 ? ` · ${here} 人在此页` : ""}
      </span>
    </div>
  );
}
