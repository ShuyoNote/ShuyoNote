import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { SearchResult } from "../types";
import { SearchIcon } from "./icons";

// 侧栏内嵌的搜索面板（activity bar 的「搜索」活动）。
//
// 与之前的弹层版是同一套交互（分段范围、两行摘要、↑↓/Enter/Esc、用法 chip），
// 只是外壳从 popover 变成常驻侧栏——这正是 activity bar 模式与弹层模式的差别：
// 结果列表可以一直开着，边看边点，不会因为失焦而消失。
const EXAMPLES = ["prop:状态=进行中", "prop:标签=读书", "会议纪要"];

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part === "") return;
    if (i % 2 === 1) nodes.push(<mark key={i}>{part}</mark>);
    else nodes.push(<span key={i}>{part}</span>);
  });
  return <>{nodes}</>;
}

function formatScore(score: number): string {
  const pct = Math.max(0, Math.min(1, score));
  return `相关 ${Math.round(pct * 100)}%`;
}

export function SearchSidebar() {
  const { openPage, setSearchQuery } = useNotes();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [allSpaces, setAllSpaces] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
        setActiveIdx(0);
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

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const select = (id: string) => {
    openPage(id);
    setSearchQuery(query.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[activeIdx];
      if (hit) select(hit.id);
    }
  };

  const countLabel = useMemo(() => {
    if (loading) return "搜索中…";
    if (!results.length) return "无结果";
    return `找到 ${results.length} 条${results.length >= 50 ? "（前 50 条）" : ""}`;
  }, [loading, results.length]);

  return (
    <div className="search-side">
      <div className="search-side-head">
        <div className="search-input-row">
          <span className="search-input-icon" aria-hidden>
            <SearchIcon width={15} height={15} />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="搜索标题与正文…"
            aria-label="搜索笔记"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button className="search-clear" title="清空" aria-label="清空搜索词" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
              ×
            </button>
          )}
        </div>
        <div className="search-scope" role="group" aria-label="搜索范围">
          <button className={`search-scope-btn${allSpaces ? "" : " is-on"}`} onClick={() => setAllSpaces(false)}>
            本空间
          </button>
          <button className={`search-scope-btn${allSpaces ? " is-on" : ""}`} onClick={() => setAllSpaces(true)}>
            全空间
          </button>
        </div>
      </div>

      {!showResults && !loading ? (
        <div className="search-tips">
          <div className="search-tips-title">试试这样搜</div>
          <div className="search-tips-chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="search-chip" onClick={() => { setQuery(ex); inputRef.current?.focus(); }}>
                {ex}
              </button>
            ))}
          </div>
          <div className="search-tips-foot">
            支持 <code>prop:属性=值</code> 按属性过滤；<kbd>↑</kbd><kbd>↓</kbd> 选择、<kbd>Enter</kbd> 打开
          </div>
        </div>
      ) : (
        <>
          <div className="search-count">{countLabel}</div>
          <div className="search-results search-side-results" ref={listRef}>
            {loading && (
              <div className="search-skeleton" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="search-skeleton-row">
                    <div className="search-skeleton-line w60" />
                    <div className="search-skeleton-line w90" />
                  </div>
                ))}
              </div>
            )}
            {!loading && results.length === 0 && (
              <div className="search-empty">
                <div className="search-empty-title">没有找到「{query.trim()}」</div>
                <div className="search-empty-sub">换个关键词，或切到「全空间」。</div>
              </div>
            )}
            {!loading &&
              results.map((r, i) => (
                <div
                  key={r.id}
                  data-idx={i}
                  className={`search-item${i === activeIdx ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(r.id);
                  }}
                >
                  <div className="search-item-title">
                    <span className="search-item-name">{r.title || "未命名"}</span>
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
        </>
      )}
    </div>
  );
}
