import { useEffect, useRef, useState } from "react";
import { EMOJI_GROUPS } from "../lib/emojis";
import { useIconPicker } from "../store/iconPicker";

const RECENT_KEY = "shuyo:icon-recent";
const RECENT_MAX = 24;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

// Page-icon emoji picker: left group tabs + search (also free-text input) +
// recent + emoji grid, styled like the reference Notion picker.
export function EmojiPicker() {
  const { open, onPick, close } = useIconPicker();
  const [tab, setTab] = useState("face");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRecent(loadRecent());
      setQuery("");
      setTimeout(() => searchRef.current?.focus(), 40);
    }
  }, [open]);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".emoji-picker, .emoji-picker-overlay")) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  if (!open) return null;

  const active = EMOJI_GROUPS.find((g) => g.id === tab) ?? EMOJI_GROUPS[0];
  const q = query.trim().toLowerCase();
  const exactUseable = q.length > 0;
  const matches = q
    ? EMOJI_GROUPS.flatMap((g) => g.list).filter((e) => e.includes(query.trim()))
    : active.list;

  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter((r) => r !== emoji)];
    setRecent(next);
    saveRecent(next);
    onPick?.(emoji);
    close();
  };

  const clear = () => {
    onPick?.("");
    close();
  };

  const currentGroupList = q && matches.length === 0 ? [] : q ? matches : active.list;

  return (
    <div className="emoji-picker-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="emoji-picker">
        <div className="ep-side">
          <button className={`ep-side-btn ${recent.length ? "" : "empty"}`} title="最近使用" onClick={() => setTab("__recent")}>
            🕑
          </button>
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g.id}
              className={`ep-side-btn ${tab === g.id ? "active" : ""}`}
              title={g.name}
              onClick={() => { setTab(g.id); setQuery(""); }}
            >
              {g.icon}
            </button>
          ))}
          <div className="ep-side-spacer" />
          <button className="ep-side-btn danger" title="清除图标" onClick={clear}>
            🗑
          </button>
        </div>

        <div className="ep-main">
          <div className="ep-search">
            <input
              ref={searchRef}
              className="ep-search-input"
              placeholder="搜索…（输入任意 emoji 直接使用）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && exactUseable) pick(query.trim());
              }}
            />
            <button className="ep-search-btn" title="随机" onClick={() => {
              const all = EMOJI_GROUPS.flatMap((g) => g.list);
              pick(all[Math.floor(Math.random() * all.length)]);
            }}>
              🎲
            </button>
          </div>

          {tab === "__recent" ? (
            <>
              <div className="ep-group-title">最近使用</div>
              {recent.length === 0 ? (
                <div className="ep-empty">暂无最近使用的图标</div>
              ) : (
                <div className="ep-grid">
                  {recent.map((e) => (
                    <button key={e} className="ep-item" onClick={() => pick(e)}>{e}</button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {exactUseable && (
                <>
                  <div className="ep-group-title">使用「{query.trim()}」</div>
                  <div className="ep-grid">
                    <button className="ep-item ep-item-custom" onClick={() => pick(query.trim())}>{query.trim()}</button>
                  </div>
                  <div className="ep-group-title">{active.name}</div>
                </>
              )}
              {currentGroupList.length === 0 ? (
                <div className="ep-empty">没有匹配的 emoji，可点击上方「使用输入内容」</div>
              ) : (
                <div className="ep-grid">
                  {currentGroupList.map((e, i) => (
                    <button key={`${e}-${i}`} className="ep-item" onClick={() => pick(e)}>{e}</button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="ep-bottom">
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g.id}
              className={`ep-bottom-btn ${tab === g.id ? "active" : ""}`}
              title={g.name}
              onClick={() => { setTab(g.id); setQuery(""); }}
            >
              {g.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
