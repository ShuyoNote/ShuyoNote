import { useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { useMobileNav } from "../store/mobileNav";
import { ChevronDownIcon, ChevronRightIcon, PenIcon, SearchIcon, StickyNoteIcon } from "./icons";
import { MobileSpaceSheet } from "./MobileSpaceSheet";
import { timeAgo } from "../lib/timeAgo";

/**
 * **移动端首页**（2026-10-26 重设计；效果图见 `_tmp/acceptance/2026-10-26-mobile-lan/`）。
 *
 * 本轮改的是**闭环**，不是装饰：
 * - 顶部有**当前空间**入口（点开「切换空间」面板）—— 切换是局域网同步的前置；
 * - 「最近笔记」→ **「全部笔记」**：列出当前空间的**所有页**（原来只显示 3 条，
 *   切完空间经常像“什么都没有”）；
 * - 图标统一走 `icons.tsx` 的 SVG（⛔ 不再用 emoji 当图标 ✗）。
 *
 * 仍然守住原来的规矩：本屏**不写库**；快速记录/搜索各自进自己的屏；无桌面侧边栏。
 */
export function MobileHome() {
  // ⚠️ 一律字段级选择器（check-store-subscriptions 挡整店订阅）。
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  const setScreen = useMobileNav((s) => s.setScreen);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const [spaceOpen, setSpaceOpen] = useState(false);

  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";
  const all = useMemo(
    () =>
      pages
        .filter((p) => !p.deleted_at)
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at),
    [pages],
  );

  return (
    <div className="mshell mhome" data-testid="mobile-home">
      <header className="mhome-head">
        <div className="mhome-headtext">
          <h1 className="mhome-title">ShuyoNote</h1>
          <p className="mhome-sub">本地优先 · 离线可用</p>
        </div>
        <button
          className="mhome-space"
          data-testid="mhome-space"
          onClick={() => setSpaceOpen(true)}
          title="切换空间"
        >
          <span className="mhome-space-name">{activeName}</span>
          <ChevronDownIcon width={13} height={13} />
        </button>
      </header>

      {/* ① 主行动：快速记录（保持既有入口/文案/类名，门禁靠 .mhome-card + 文案定位） */}
      <button className="mhome-card is-accent" onClick={() => setScreen("capture")}>
        <span className="mhome-card-icon" aria-hidden>
          <PenIcon width={20} height={20} />
        </span>
        <span className="mhome-card-body">
          <span className="mhome-card-title">快速记录</span>
          <span className="mhome-card-hint">想一句就记一句</span>
        </span>
        <span className="mhome-card-go" aria-hidden>
          <ChevronRightIcon width={18} height={18} />
        </span>
      </button>

      {/* ② 搜索 */}
      <button className="mhome-card" onClick={() => setScreen("search")}>
        <span className="mhome-card-icon" aria-hidden>
          <SearchIcon width={20} height={20} />
        </span>
        <span className="mhome-card-body">
          <span className="mhome-card-title">搜索</span>
          <span className="mhome-card-hint">搜索笔记内容 · 结果来自本机索引</span>
        </span>
        <span className="mhome-card-go" aria-hidden>
          <ChevronRightIcon width={18} height={18} />
        </span>
      </button>

      {/* ③ 全部笔记：当前空间的**所有**页（不再只显示最近 3 条） */}
      <section className="mhome-notes" aria-label="全部笔记" data-testid="mhome-notes">
        <div className="mhome-notes-head">
          <span className="mhome-notes-title">全部笔记</span>
          {all.length > 0 && <span className="mhome-count">{all.length} 条</span>}
        </div>
        {all.length === 0 ? (
          <div className="mhome-empty">
            {activeName}里还没有笔记 —— 点上面「快速记录」写第一条。
          </div>
        ) : (
          <ul className="mhome-note-list">
            {all.map((p) => (
              <li key={p.id}>
                <button className="mhome-note-row" onClick={() => void openPage(p.id)}>
                  <span className="mhome-note-icon" aria-hidden>
                    {p.icon ? (
                      /^(data:image|https?:|\.svg)/i.test(p.icon) ? (
                        <img className="mhome-recent-icon-img" src={p.icon} alt="" draggable={false} />
                      ) : (
                        p.icon
                      )
                    ) : (
                      <StickyNoteIcon width={16} height={16} />
                    )}
                  </span>
                  <span className="mhome-note-body">
                    <span className="mhome-note-title">{p.title || "未命名"}</span>
                    <span className="mhome-note-time">{timeAgo(p.updated_at)}</span>
                  </span>
                  <span className="mhome-note-go" aria-hidden>
                    <ChevronRightIcon width={15} height={15} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mhome-notes-hint">切换空间后，这里显示该空间的全部笔记；不再只显示最近 3 条。</p>
      </section>

      <MobileSpaceSheet open={spaceOpen} onClose={() => setSpaceOpen(false)} />
    </div>
  );
}
