import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { SearchResult } from "../types";

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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [allSpaces, setAllSpaces] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const r = await api.search(query.trim(), 50, allSpaces);
        setResults(r);
        setOpen(true);
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

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const select = (id: string) => {
    const q = query.trim();
    openPage(id);
    setSearchQuery(q);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="search-box" ref={boxRef}>
      <div className="search-input-row">
        <input
          id="global-search-input"
          className="search-input"
          value={query}
          placeholder="搜索笔记…"
          title="支持 prop:属性=值 过滤（如 prop:状态=进行中）"
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.trim() && setOpen(true)}
        />
        <button
          className={`search-all-toggle ${allSpaces ? "on" : ""}`}
          title="在所有工作空间搜索"
          onClick={() => setAllSpaces((v) => !v)}
        >
          {allSpaces ? "全空间" : "本空间"}
        </button>
      </div>
      {open && (
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
  );
}
