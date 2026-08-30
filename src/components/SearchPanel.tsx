import { useEffect, useRef, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { SearchResult } from "../types";
import { SearchIcon } from "./icons";

// Map a raw semantic/rank score to a friendly percentage-ish label (0..1 style).
function formatScore(score: number): string {
  const pct = Math.max(0, Math.min(1, score));
  return `相关 ${Math.round(pct * 100)}%`;
}

// Render a snippet containing [[...]] highlight markers.
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  // markers come in pairs: [[ starts highlight, ]] ends it.
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part === "") return;
    // The split leaves even indexes outside markers, odd inside.
    if (i % 2 === 1) {
      nodes.push(<mark key={i}>{part}</mark>);
    } else {
      nodes.push(<span key={i}>{part}</span>);
    }
  });
  return <>{nodes}</>;
}

export function SearchPanel() {
  const { openPage, setSearchQuery } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [allSpaces, setAllSpaces] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when the popover opens; reset state when it closes.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setResults([]);
      setShowResults(false);
    }
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setShowResults(false);
      return;
    }
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const r = await api.search(query.trim(), 50, allSpaces);
        setResults(r);
        setShowResults(true);
      } catch (e) {
        console.error("search failed", e);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, allSpaces]);

  const select = (id: string) => {
    const q = query.trim();
    openPage(id);
    setSearchQuery(q);
    setQuery("");
    setShowResults(false);
    close();
  };

  return (
    <div className="search-panel">
      <button ref={triggerRef} className="btn-search" onClick={toggle} title="搜索笔记">
        <SearchIcon />
      </button>
      {open && (
        <div ref={contentRef} className="search-popover" style={{ top: pos.top, left: pos.left }}>
          <div className="search-input-row">
            <input
              ref={inputRef}
              className="search-input"
              value={query}
              placeholder="搜索笔记…"
              title="支持 prop:属性=值 过滤（如 prop:状态=进行中）"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className={`search-all-toggle ${allSpaces ? "on" : ""}`}
              title="在所有工作空间搜索"
              onClick={() => setAllSpaces((v) => !v)}
            >
              {allSpaces ? "全空间" : "本空间"}
            </button>
          </div>
          {showResults && (
            <div className="search-results">
              {loading && <div className="search-hint">搜索中…</div>}
              {!loading && results.length === 0 && (
                <div className="search-hint">无结果</div>
              )}
              {results.map((r) => (
                <div
                  key={r.id}
                  className="search-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(r.id);
                  }}
                >
                  <div className="search-item-title">
                    {r.title || "未命名"}
                    {allSpaces && r.space && <span className="search-item-space">{r.space}</span>}
                    {typeof r.score === "number" && r.score > 0 && (
                      <span className="search-item-score" title="语义相关度">{formatScore(r.score)}</span>
                    )}
                  </div>
                  {r.snippet && (
                    <div className="search-item-snippet">
                      <Highlighted text={r.snippet} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
