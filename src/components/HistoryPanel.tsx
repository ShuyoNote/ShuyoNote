import { useCallback, useEffect, useId, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useRightPanel } from "../store/rightPanel";
import { useViewStore } from "../store/view";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageVersion } from "../types";
import { usePopover } from "../hooks/usePopover";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { seedPageCrdtStateAfterRestore } from "../lib/crdt/seedPageState";
import { lineDiff, hasDiff, type DiffLine } from "../lib/textDiff";
import { pageText } from "../lib/docContent";
import { ClockIcon } from "./icons";

// Compact, friendly timestamp: today/yesterday → 时:分, this year → 月日 时:分, else 年月日.
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay(d, now)) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/**
 * 每页保留的版本份数上限 —— ⚠️ **权威是 Rust 的 `versions.rs::MAX_VERSIONS_PER_PAGE`**
 * （它才是真删东西的那个；web 侧同口径 ✓）。这里只是把它**明示**给用户（本仓忌"悄悄丢东西" ✗）。
 * ⛔ 两个数不许漂：判据 `historyPanelInspect.test.ts` ④ 直接读 `versions.rs` 比一比 ✓。
 */
export const VERSION_CAP = 50;

export function HistoryPanel({ pageId }: { pageId: string }) {
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  // ★ 2026-10-08（owner：「优化一下版本历史功能」）：**先看再恢复** —— 哪一条被展开着。
  //   为什么必须：列表数据本来就带**整篇正文**（`versions.rs` 的 `PageVersion`），而面板原先只显示 40 字
  //   ⇒ 用户是**盲着**按「恢复」（破坏性操作 ✗）。现在恢复按钮**只在展开之后**出现 ✓（判据 ①②）。
  const [expanded, setExpanded] = useState<string | null>(null);
  // a11y（2026-11-01）：触发器与弹层用同一个 id 关联（aria-controls / aria-haspopup）。
  const popoverId = useId();
  // P2（2026-11-02）：展开某版后可以点「与当前版本对比」；diff 只对当前展开的那条有效。
  const [diff, setDiff] = useState<{ versionId: string; lines: DiffLine[] } | null>(null);

  // 窄屏 / 矮视口的形态与其余浮层一致：不再锚定触发按钮，而是带 `is-sheet` 走底部弹层
  // （见 hooks/usePopover.ts 与 App.css 末尾那段）。原来它只是 CSS 里的
  // `position:absolute; right:0; width:320px`，360×640 实测**左边缘 = −6px**（越界 6px，
  // 因为工具条上那个按钮的右边缘离屏左边不足 320px）——所以它不是"难看"，是真的越界。
  // ⭐ 2026-11-01（P1-A）：目录打开时把 `--toc-w` 作为"可用右边界"传进去 —— 否则浮层
  // 只按视口 clamp，右缘会压在目录上（owner 截图）。目录是否打开 / 多宽以 store 现值为准。
  const { open, pos, isSheet, triggerRef, contentRef, toggle, close } =
    usePopover<HTMLButtonElement>({
      width: 320,
      rightInset: () =>
        useRightPanel.getState().toc ? useViewStore.getState().tocWidth : 0,
    });
  // 与搜索/回收站/同步同一条既有做法：浮层打开时锁住外壳滚动（否则手指拖背景能把正文拖走）。
  useOverlayScrollLock(open);

  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts 与 §4.1.4）。
  // ⚠️ 这一条曾漏掉：弹层开着时浮层栈 depth=0 ⇒ 返回键**直接退出应用**而弹层还在。
  useOverlayLayer("history", open, close);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listVersions(pageId)
      .then(setVersions)
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [pageId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  // 「点击弹层以外区域关闭」由 usePopover 统一负责（它按 triggerRef/contentRef 判定，
  // 并且会忽略落在模态层上的点击）——这里不再自己挂一份 document mousedown。
  // Escape 关闭（与其它浮层同一条既有做法：window 上监听 keydown）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // P2（2026-11-02）：**恢复前对照** —— 把「这一版」与「当前正文」做逐行 diff。
  // 只读当前页文本（getState 现取，不订阅整店）；加载不到就明确说，不给空对照。
  const showDiff = (versionId: string, oldText: string) => {
    const currentText = pageText(useNotes.getState().current);
    if (!currentText) {
      toast("当前页内容还没加载，稍后再试", "error");
      return;
    }
    setDiff({ versionId, lines: lineDiff(oldText, currentText) });
  };

  const restore = async (versionId: string) => {
    // ★ 2026-10-08：文案**与事实对齐** —— 恢复前会把当前内容先快照进历史
    //   （Rust `versions.rs:138` / web `web.ts:3476`，注释逐字 "so a restore is reversible" ✓）
    //   ⇒ 旧文案「当前内容将被覆盖」读起来像"一去不返"，是**误导** ✗（判据 ③ 钉着它不许回来）。
    if (
      !(await confirmDialog({
        title: "恢复版本",
        message: "恢复到这一版？当前内容会**先存成一条历史版本**，之后你还能再恢复回来。",
      }))
    )
      return;
    try {
      const page = await api.restoreVersion(versionId);
      // 三个都是 store 动作（引用恒定）⇒ 走 getState() 现取：本面板不读 notes 的任何
      // state 字段，订阅整店只会被每次自动保存白白唤醒。
      const notes = useNotes.getState();
      // ⭐ R150（2026-11-01 接上）：恢复**也是外部写** —— 必须先把"这一页刚被外部写过"标上，
      //   否则点「恢复」前 600ms 内敲的那条陈旧待保存会在恢复之后落地，把恢复的正文盖回去
      //   （`lib/pendingSave.ts` 的头注就是那次 0.4 秒覆盖的现场）。
      //   ⚠️ 必须在 `bumpReload()` 之前（与 `notes.refreshCurrent` 同一顺序）。
      notes.noteExternalWrite(page.id);
      // ⭐ R155 × 恢复版本（2026-11-01）：盘上正文已经换成旧版，而这一页的 CRDT 状态还是
      //   恢复前那份；编辑器「有状态就载入」（`crdt/pageBinding.ts`）⇒ 不播种的话，
      //   下面 `bumpReload()` 一重挂，**旧状态就会赢回旧内容**（恢复被静默作废）。
      //   ⇒ 顺序是判据：落库 ⇒ 播种 ⇒ 才允许重挂（判据在 `historyPanelInspect.test.ts`）。
      const seed = await seedPageCrdtStateAfterRestore(page);
      // ⭐ F3（2026-11-01）：恢复把**标题**也一起恢复了 ⇒ 页树/面包屑要跟着改。
      //   不在列表里就回退全量重拉 —— 与保存那条路同一条口径（`App.tsx` 的
      //   `if (!updated || notes.error || !notes.patchPageMeta(updated)) loadPages()`）。
      if (!notes.patchPageMeta({ id: page.id, title: page.title })) await notes.loadPages();
      notes.updateCurrent(page);
      // 编辑器以 `reloadTick` 作为 key 才会重挂载并重新读取 content_json；恢复当前页时
      // pageId 不变，必须 bump reload 才能让编辑器刷新成恢复后的内容。
      notes.bumpReload();
      setExpanded(null);
      close();
      load();
      notes.openPage(page.id);
      // ⛔ 播种失败**不许说成成功**：库已经恢复了，但"重启/重开可能回滚这一页"必须说出来
      //   （只 console.warn 等于对没有 devtools 的用户静默）。恢复结果本身照常保留。
      if (seed.status === "failed") {
        console.warn("[history] 恢复后同步 CRDT 状态失败（重启/重开可能回滚这一页）", seed.error);
        // 提示只给人话，技术细节在上面那条 warn 与 `mcp/apply.log` 的留痕行里（⛔ 不把 200 字错误塞进气泡）
        toast("已恢复该版本，但状态同步失败：重启后可能回滚这一页（详见控制台 / apply.log）", "error");
      } else {
        toast("已恢复该版本", "success");
      }
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  // 一键清空（保留当前）：删除本页全部历史快照。
  const clearHistory = async () => {
    if (versions.length === 0) return;
    if (
      !(await confirmDialog({
        title: "清空版本历史",
        message: `将删除本页的全部 ${versions.length} 条历史版本（当前内容保留）。此操作不可撤销，确定继续？`,
      }))
    )
      return;
    setClearing(true);
    try {
      const n = await api.clearPageVersions(pageId);
      setVersions([]);
      toast(`已清空版本历史（删除 ${n} 条）`, "success");
    } catch (e) {
      toast(`清空失败：${e}`, "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="history-panel">
      <button
        ref={triggerRef}
        className="toolbar-btn"
        onClick={toggle}
        title="版本历史"
        aria-label="版本历史"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
      >
        <ClockIcon />
      </button>
      {open && (
        <div
          ref={contentRef}
          id={popoverId}
          role="dialog"
          aria-label="版本历史"
          className={`history-popover${isSheet ? " is-sheet" : ""}`}
          style={{ top: pos.top, left: pos.left, bottom: pos.bottom }}
        >
          <div className="history-head">
            <span className="history-title">版本历史</span>
            <span className="history-total">{loading ? "…" : `${versions.length} 个版本`}</span>
            <button
              className="history-clear"
              onClick={clearHistory}
              disabled={versions.length === 0 || clearing}
              aria-label="清空版本历史"
              title="删除全部历史版本（保留当前内容）"
            >
              {clearing ? "清空中…" : "清空"}
            </button>
          </div>
          {/* ★ 2026-10-08：**把上限明示出来** —— 超过上限的更早版本是被**真删掉**的
              （`versions.rs` 的 `MAX_VERSIONS_PER_PAGE`），界面原先一个字都没说 ✗
              （本仓最忌"悄悄丢东西"）。数字与 Rust 常量由判据 ④ 钉成一致 ✓。 */}
          <div className="history-note">{`每页最多保留最近 ${VERSION_CAP} 份，更早的会被自动清理`}</div>
          {versions.length === 0 ? (
            <div className="history-empty">{loading ? "加载中…" : "暂无历史版本"}</div>
          ) : (
            versions.map((v, i) => {
              // ⚠️ 正文**只读这一处**：摘要与整篇预览复用同一个值 ✓
              // （`check-doc-content-access` 只减不增 —— 这条直面计数由它守 ✓：
              //   把"摘要一次、整篇又一次"写成两处会当场 +1 ✗，本仓栽过同形的坑）。
              const full = v.content_text;
              return (
                <div key={v.id} className={`history-item${expanded === v.id ? " is-open" : ""}`}>
                  <div className="history-meta">
                    <button
                      className="history-row"
                      onClick={() => {
                        setDiff(null);
                        setExpanded((cur) => (cur === v.id ? null : v.id));
                      }}
                      aria-expanded={expanded === v.id}
                      title={expanded === v.id ? "收起" : "展开看这一版的全文"}
                    >
                      <span className="history-time-row">
                        <span className="history-time">{formatWhen(v.created_at)}</span>
                        {i === 0 && <span className="history-newest">最新</span>}
                      </span>
                      <span className="history-preview">{full.slice(0, 40) || "(空)"}</span>
                    </button>
                    {/* ★ **先看再恢复**：全文预览（数据里本来就带整篇 ✓）＋ 恢复按钮
                        **只在展开之后**出现 —— 折叠态那个 40 字预览下不允许按恢复 ✗（判据 ①②）。 */}
                    {expanded === v.id && (
                      <div className="history-full-wrap">
                        <pre className="history-full">{full || "(空)"}</pre>
                        <div className="history-full-foot">
                          <span className="history-full-hint">恢复后，当前内容会先存成一条历史版本</span>
                          <div className="history-full-actions">
                            <button
                              className="history-diff-btn"
                              onClick={() => showDiff(v.id, full)}
                              aria-label="与当前版本对比"
                            >
                              与当前版本对比
                            </button>
                            <button className="history-restore" onClick={() => restore(v.id)}>
                              恢复这一版
                            </button>
                          </div>
                        </div>
                        {diff && diff.versionId === v.id && (
                          <div className="history-diff" role="region" aria-label="与当前版本的差异">
                            {!hasDiff(diff.lines) ? (
                              <div className="history-diff-empty">与当前版本没有差异</div>
                            ) : (
                              diff.lines.slice(0, 500).map((line, idx) => (
                                <div key={idx} className={`history-diff-line is-${line.kind}`}>
                                  <span className="history-diff-sign">
                                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                                  </span>
                                  <span className="history-diff-text">{line.text || " "}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
