import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { PageMeta } from "../types";

export function BacklinksPanel({ pageId }: { pageId: string }) {
  const { openPage } = useNotes();
  const [links, setLinks] = useState<PageMeta[]>([]);

  useEffect(() => {
    api.getBacklinks(pageId).then(setLinks).catch((e) => console.error(e));
  }, [pageId]);

  if (links.length === 0) return null;

  return (
    <div className="backlinks">
      <div className="backlinks-title">反向链接</div>
      <div className="backlinks-list">
        {links.map((l) => (
          <button key={l.id} className="backlink-item" onClick={() => openPage(l.id)}>
            {l.title || "未命名"}
          </button>
        ))}
      </div>
    </div>
  );
}
