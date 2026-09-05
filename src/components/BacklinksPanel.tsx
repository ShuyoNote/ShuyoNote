import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import type { BlockBacklink, PageMeta } from "../types";

export function BacklinksPanel({ pageId }: { pageId: string }) {
  const { openPage } = useNotes();
  const [pageLinks, setPageLinks] = useState<PageMeta[]>([]);
  const [blockLinks, setBlockLinks] = useState<BlockBacklink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    Promise.all([api.getBacklinks(pageId), api.listBlockBacklinks(pageId)])
      .then(([pl, bl]) => {
        if (cancelled) return;
        setPageLinks(pl);
        setBlockLinks(bl);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("backlinks load failed", e);
        setError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [pageId, tick]);

  if (error) {
    return (
      <div className="backlinks">
        <div className="backlinks-title">反向链接</div>
        <div className="backlinks-error">
          加载失败
          <button className="backlinks-retry" onClick={() => setTick((t) => t + 1)}>重试</button>
        </div>
      </div>
    );
  }

  if (loading && pageLinks.length === 0 && blockLinks.length === 0) {
    return (
      <div className="backlinks">
        <div className="backlinks-title">反向链接</div>
        <div className="backlinks-loading">加载中…</div>
      </div>
    );
  }

  if (pageLinks.length === 0 && blockLinks.length === 0) return null;

  // Jump to a block: set the pending focus id, switch page if needed.
  const goToBlock = (blockId: string, targetPageId: string) => {
    useEditorStore.getState().setFocusBlockId(blockId);
    if (targetPageId !== pageId) openPage(targetPageId);
  };

  return (
    <div className="backlinks">
      <div className="backlinks-title">反向链接</div>

      {blockLinks.length > 0 && (
        <div className="backlinks-group">
          <div className="backlinks-subtitle">块级引用</div>
          <div className="backlinks-blocks">
            {blockLinks.map((b, i) => (
              <div key={`${b.source_block_id}-${b.target_block_id}-${i}`} className="backlink-block-row">
                <button
                  className="backlink-block-card"
                  title={`跳转到 ${b.source_page_title || "未命名"} 的引用块`}
                  onClick={() => goToBlock(b.source_block_id, b.source_page_id)}
                >
                  <span className="backlink-block-page">{b.source_page_title || "未命名"}</span>
                  <span className="backlink-block-snippet">
                    {b.source_snippet || "(空块)"}
                  </span>
                </button>
                <span className="backlink-block-arrow">→</span>
                <button
                  className="backlink-block-card"
                  title="定位到本页被引用块"
                  onClick={() => goToBlock(b.target_block_id, pageId)}
                >
                  <span className="backlink-block-snippet">
                    {b.target_snippet || "(空块)"}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {pageLinks.length > 0 && (
        <div className="backlinks-group">
          <div className="backlinks-subtitle">页面引用</div>
          <div className="backlinks-list">
            {pageLinks.map((l) => (
              <button key={l.id} className="backlink-item" onClick={() => openPage(l.id)}>
                {l.title || "未命名"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
