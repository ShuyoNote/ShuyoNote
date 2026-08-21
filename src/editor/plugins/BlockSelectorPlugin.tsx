import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { api } from "../../lib/api";
import type { SearchBlock } from "../../types";
import { useBlockSelector } from "../../store/blockSelector";
import { toast } from "../../store/toast";
import { $createBlockRefNode } from "../nodes/BlockRefNode";

// Block picker for /引用块 and /嵌入块: searches blocks by content, then inserts
// a block reference (or embed) at the current caret.
export function BlockSelectorPlugin() {
  const [editor] = useLexicalComposerContext();
  const open = useBlockSelector((s) => s.open);
  const mode = useBlockSelector((s) => s.mode);
  const closeSelector = useBlockSelector((s) => s.closeSelector);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  // Reset and focus on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced block search.
  useEffect(() => {
    if (!open) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = window.setTimeout(async () => {
      try {
        setResults(await api.searchBlocks(query));
      } catch (e) {
        toast(`搜索块失败：${e}`, "error");
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [query, open]);

  if (!open) return null;

  const insert = (block: SearchBlock) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertNodes([$createBlockRefNode(block.block_id, block.snippet)]);
      }
    });
    closeSelector();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((v) => Math.min(v + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((v) => Math.max(v - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const block = results[sel];
      if (block) insert(block);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSelector();
    }
  };

  return (
    <div
      className="block-selector-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeSelector();
      }}
    >
      <div className="block-selector">
        <div className="block-selector-head">
          <span className="block-selector-title">
            {mode === "embed" ? "嵌入块" : "引用块"}
          </span>
          <input
            ref={inputRef}
            className="block-selector-input"
            placeholder="搜索页面或块内容…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="block-selector-results">
          {loading && <div className="block-selector-empty">搜索中…</div>}
          {!loading && results.length === 0 && (
            <div className="block-selector-empty">
              {query.trim() ? "无匹配块" : "输入关键词搜索块"}
            </div>
          )}
          {results.map((block, i) => (
            <button
              key={block.block_id}
              className={`block-selector-item ${sel === i ? "block-selector-item-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(block)}
              onMouseEnter={() => setSel(i)}
            >
              <span className="block-selector-snippet">{block.snippet || "(空块)"}</span>
              <span className="block-selector-page">{block.page_title || "未命名"}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
