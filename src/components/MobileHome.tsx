import { useMemo } from "react";
import { useNotes } from "../store/notes";
import { usePalette } from "../store/palette";

/**
 * **移动端首页**（效果图 `docs/plans/mobile/mockups/01-home.svg`，规格 §4.1）。
 *
 * 规矩（照规格逐条 ✓，别自己发明 ✗）：
 * - **只有三个入口**：快速记录（主行动）／搜索／最近笔记 —— ⛔ **无页面树、无侧边栏** ✓
 *   （桌面那一套在手机上由 `ActivityBar` 收进抽屉 ✓，本屏不重复它 ✓）
 * - **本屏不写库** ✓：这里只做"入口"，真正落库的是各入口各自的屏 ✓
 * - 对应需求：**M-P0-1**（记一条的入口）、**M-P0-3**（离线可记 —— 三个入口都不依赖网络 ✓）
 *
 * ⚠️ 当前的**如实**状态（不许把没做的写成做了 ✗）：
 * - 「快速记录」现在＝**新建一页并打开编辑器** ✓ —— 效果图里的 **02 屏**（键盘上方 6 项快捷工具栏
 *   ＋ 主按钮「存」）**还没实现** ✗，本处是它的前置动作 ✓。
 * - 「搜索」现在＝打开应用既有的**命令面板**（`usePalette` ✓）—— 效果图的 **03 屏**
 *   （命中片段两档底色）**还没实现** ✗。
 * - 「最近笔记」现在＝真实的最近 3 条（按 `updated_at` 排 ✓）—— 点开即 **04 屏**（阅读形态待量 ✓）。
 */
export function MobileHome() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  const createPage = useNotes((s) => s.createPage);
  const setPaletteOpen = usePalette((s) => s.setOpen);

  const recent = useMemo(() => {
    return pages
      .filter((p) => !p.deleted_at)
      .slice()
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 3);
  }, [pages]);

  return (
    <div className="main mhome" data-testid="mobile-home">
      <header className="mhome-head">
        <h1 className="mhome-title">ShuyoNote</h1>
        <p className="mhome-sub">本地优先 · 离线可用 · 只记你确定要留的</p>
      </header>

      {/* ① 主行动：主色卡（效果图里唯一用 --accent 的那一张 ✓） */}
      <button className="mhome-card is-accent" onClick={() => void createPage(null)}>
        <span className="mhome-card-icon" aria-hidden>✏️</span>
        <span className="mhome-card-body">
          <span className="mhome-card-title">快速记录</span>
          <span className="mhome-card-hint">想一句就记一句</span>
        </span>
        <span className="mhome-card-go" aria-hidden>›</span>
      </button>

      {/* ② 搜索 */}
      <button className="mhome-card" onClick={() => setPaletteOpen(true)}>
        <span className="mhome-card-icon" aria-hidden>🔍</span>
        <span className="mhome-card-body">
          <span className="mhome-card-title">搜索</span>
          <span className="mhome-card-hint">全文搜索 · 结果来自本机索引</span>
        </span>
        <span className="mhome-card-go" aria-hidden>›</span>
      </button>

      {/* ③ 最近笔记：最多 3 条（效果图第三张卡是**列表** ＋「3 条」计数 ✓） */}
      <section className="mhome-card mhome-recent" aria-label="最近笔记">
        <div className="mhome-card-body">
          <span className="mhome-card-title">
            最近笔记
            {recent.length > 0 && <span className="mhome-count">{recent.length} 条</span>}
          </span>
          {recent.length === 0 ? (
            <span className="mhome-card-hint">还没有笔记 —— 点上面「快速记录」写第一条</span>
          ) : (
            <ul className="mhome-recent-list">
              {recent.map((p) => (
                <li key={p.id}>
                  <button className="mhome-recent-item" onClick={() => void openPage(p.id)}>
                    <span className="mhome-recent-icon" aria-hidden>{p.icon || "📄"}</span>
                    <span className="mhome-recent-title">{p.title || "未命名"}</span>
                    <span className="mhome-recent-time">{timeAgo(p.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * 相对时间（效果图第三张卡用「12 分钟前」「昨天 21:40」「10 月 6 日」三档 ✓）。
 *
 * ⚠️ 仓里**没有**现成的相对时间函数 ✓（只在 `src/lib/exportMermaid.ts` 里内联过 ✗）
 * ⇒ 这一处 20 行的小函数先本地放 ✓；哪天第二处要用，再抽到 `src/lib/` ✓（别现在造抽象 ✗）。
 * ⚠️ 入参是**毫秒时间戳**（`PageMeta.updated_at` ✓，与 `types.ts` 一致 ✓）。
 */
function timeAgo(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hhmm}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (y.toDateString() === d.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
