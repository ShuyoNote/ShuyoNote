import { useEffect, useMemo, useRef, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import type { SearchResult } from "../types";
import { SearchIcon } from "./icons";

// Map a raw semantic/rank score to a friendly percentage-ish label (0..1 style).
function formatScore(score: number): string {
  const pct = Math.max(0, Math.min(1, score));
  return `相关 ${Math.round(pct * 100)}%`;
}

// 未输入时展示的用法示例：`prop:` 过滤此前只写在 input 的 title 里，
// 几乎没人能发现——做成可点击的 chip，点一下就填进输入框。
const EXAMPLES = ["prop:状态=进行中", "prop:标签=读书", "会议纪要"];

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
  // 面板比默认弹层宽，把真实尺寸告诉 usePopover，靠边打开才不会被裁切。
  const { open, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>({
    width: 468,
    minSpace: 420,
  });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [allSpaces, setAllSpaces] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // 全空间搜索结果点击：若结果属于其他空间，先切换到该空间再打开。
  const select = async (id: string, workspaceId?: string) => {
    const q = query.trim();
    if (workspaceId) {
      const { activeId, switchTo } = useSpaceStore.getState();
      if (workspaceId !== activeId) {
        const ok = await switchTo(workspaceId);
        if (ok) await useNotes.getState().loadPages();
      }
    }
    openPage(id);
    setSearchQuery(q);
    setQuery("");
    setShowResults(false);
    close();
  };

  // ↑/↓ 选择、Enter 打开、Esc 关闭：搜索面板不该逼用户去摸鼠标。
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
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
      if (hit) select(hit.id, hit.workspace_id);
    }
  };

  // 键盘移动选中项时把它滚进视野（block:"nearest" 不会整页跳动）。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const countLabel = useMemo(() => {
    if (loading) return "搜索中…";
    if (!results.length) return "无结果";
    return `找到 ${results.length} 条${results.length >= 50 ? "（仅显示前 50 条）" : ""}`;
  }, [loading, results.length]);

  return (
    <div className="search-panel">
      {/* 触发器长在左侧竖条里，所以用 activity-btn 的外观与命中区。
          搜索是「找到某页跳过去」的一次性动作：弹层用完即走，不占侧栏、
          不把页面树顶掉，在看板/关系图视图下同样可用。 */}
      <button
        ref={triggerRef}
        className="activity-btn"
        onClick={toggle}
        title="搜索笔记"
        aria-label="搜索笔记"
      >
        <SearchIcon width={18} height={18} />
      </button>
      {open && (
        <div
          ref={contentRef}
          className="search-popover"
          style={{ top: pos.top, left: pos.left }}
          role="dialog"
          aria-label="搜索笔记"
        >
          <div className="search-head">
            <div className="search-input-row">
              <span className="search-input-icon" aria-hidden>
                <SearchIcon width={16} height={16} />
              </span>
              <input
                ref={inputRef}
                className="search-input"
                value={query}
                placeholder="搜索笔记（空格分隔，多词都选）…"
                aria-label="搜索笔记"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {query && (
                <button
                  className="search-clear"
                  title="清空"
                  aria-label="清空搜索词"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {/* 范围切换做成分段控件：两个选项同时可见，比一个会变字的按钮更好懂。 */}
            <div className="search-scope" role="group" aria-label="搜索范围">
              <button
                className={`search-scope-btn${allSpaces ? "" : " is-on"}`}
                onClick={() => setAllSpaces(false)}
              >
                本空间
              </button>
              <button
                className={`search-scope-btn${allSpaces ? " is-on" : ""}`}
                onClick={() => setAllSpaces(true)}
              >
                全空间
              </button>
            </div>
          </div>

          {!showResults && !loading && (
            <div className="search-tips">
              <div className="search-tips-title">试试这样搜</div>
              <div className="search-tips-chips">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="search-chip"
                    onClick={() => {
                      setQuery(ex);
                      inputRef.current?.focus();
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
              <div className="search-tips-foot">
                支持 <code>prop:属性=值</code> 按属性过滤；<b>空格分隔多词</b>（都出现）。<kbd>↑</kbd><kbd>↓</kbd> 选择、<kbd>Enter</kbd> 打开、<kbd>Esc</kbd> 关闭；全空间点结果自动跳转到该空间。
              </div>
            </div>
          )}

          {(showResults || loading) && (
            <>
              <div className="search-count">{countLabel}</div>
              <div className="search-results" ref={listRef}>
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
                    <div className="search-empty-sub">
                      换个关键词，或减少词数再试。
                    </div>
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
                        select(r.id, r.workspace_id);
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
      )}
    </div>
  );
}
