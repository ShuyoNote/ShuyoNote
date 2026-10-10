import { useMemo } from "react";
import { useNotes } from "../store/notes";
import { timeAgo } from "../lib/timeAgo";
import { useMobileNav } from "../store/mobileNav";

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
 * - 「搜索」现在＝**进本仓自己的 03 搜索屏**（`src/components/MobileSearch.tsx` ✓，
 *   效果图 `03-search.svg` ✓）—— 2026-10-10 接上 ✓（此前借的是桌面**命令面板** ✗）。
 * - 「最近笔记」现在＝真实的最近 3 条（按 `updated_at` 排 ✓）—— 点开即 **04 屏**（阅读形态待量 ✓）。
 */
export function MobileHome() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  const setScreen = useMobileNav((s) => s.setScreen);

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

      {/* ① 主行动：主色卡（效果图里唯一用 --accent 的那一张 ✓）—— 进「快速记录」屏（02 ✓） */}
      <button className="mhome-card is-accent" onClick={() => setScreen("capture")}>
        <span className="mhome-card-icon" aria-hidden>✏️</span>
        <span className="mhome-card-body">
          <span className="mhome-card-title">快速记录</span>
          <span className="mhome-card-hint">想一句就记一句</span>
        </span>
        <span className="mhome-card-go" aria-hidden>›</span>
      </button>

      {/* ② 搜索 */}
      <button className="mhome-card" onClick={() => setScreen("search")}>
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
                    {/* ⭐ 2026-10-10 修：`p.icon` **可能是 URI/图片数据**（本机那条应用自带样例页
                        「快速上手」的 `icon` 就是 `data:image/svg+xml;base64,…` ✗）——把它当**文字**
                        渲染会让整串 base64 横着冲出屏幕 ✗（实测 `.mhome` 的 `scrollWidth=17561`，
                        视口只有 390 ✗）。判据**照抄 `PageTree.tsx:625` 那条现成的口径** ✓
                        （一处判断、两种形态：图片走 `<img>` ✓，emoji 那种单字符仍走文字 ✓）。 */}
                    <span className="mhome-recent-icon" aria-hidden>
                      {p.icon ? (
                        /^(data:image|https?:|\.svg)/i.test(p.icon) ? (
                          <img className="mhome-recent-icon-img" src={p.icon} alt="" draggable={false} />
                        ) : (
                          p.icon
                        )
                      ) : (
                        "📄"
                      )}
                    </span>
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
