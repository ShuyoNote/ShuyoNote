import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { pushOverlay } from "../lib/overlayStack";
import { Highlighted } from "../lib/snippetHighlight";
import { timeAgo } from "../lib/timeAgo";
import { useMobileNav } from "../store/mobileNav";
import { useNotes } from "../store/notes";
import type { SearchResult } from "../types";

/**
 * **移动端「搜索」屏**（效果图 `docs/plans/mobile/mockups/03-search.svg`，规格 §4.3）。
 *
 * 为什么要有它：手机档的「搜索」原先借的是**既有命令面板**（`usePalette` ✗）——
 * 那是桌面形态（命令 ＋ 页面混排），与效果图差得远。本屏只做规格 §4.3 那一句
 * 「**框 ＋ 列表 ＋ 筛选**」✓。
 *
 * 照效果图逐条 ✓（能做的）：
 * - 顶栏：`‹` 返回 ＋ **搜索框**（🔍 图标 ＋ 输入 ＋ `×` 清空）✓
 * - 结果上方一行：左侧**筛选 chips**、右侧 **`N 条结果 · M 毫秒`** ✓
 * - 结果卡：**标题** ＋ **命中片段（高亮）** ＋ **元信息行** ＋ `›` ✓
 * - 页脚：**「结果由本机索引生成 · 未上传服务器」** ✓（本屏**不写库** ✓，规格 §4.3 ✓）
 * - 点一条 ⇒ `openPage(id)` ⇒ 手机档进 **04 阅读屏** ✓（数据走**既有 store 接口** ✓）
 *
 * ⚠️ **如实标注：没做到的部分** ✗（不许把没做的写成做了 ✗）：
 * - 效果图的**筛选 chips「全部／标题／正文」** 里，只有「全部」是真能用的 ✓；
 *   **「标题」「正文」没做** ✗ —— 硬原因：本机检索的入口是 `api.search(query, limit, allSpaces)`
 *   （`src/lib/api.ts:442`），它的参数里**没有"在哪个字段里搜"这一项**
 *   （Rust 侧 `search::search` 的 `SearchArgs` 也只有 `query/limit/all_spaces/embedding`）
 *   ⇒ 想按字段筛，**得先给检索层开一个字段参数** ✗（那是契约改动，不在本屏范围内 ✓）。
 *   ⇒ 这两个 chip **渲染成 `disabled`**（`title` 里写清原因 ✓）：**让缺口看得见 ✓**，
 *     ⛔ 而不是"点得动但什么都不做" ✗ —— 也⛔ 不在返回集上就地筛（那会把"限制 50 条"的结果
 *     当成"全库"报数 ⇒ 读数骗人 ✗）。
 * - 效果图里的 **`12 毫秒`**：检索接口**不返回耗时** ✗ ⇒ 这里量的是**本屏这次调用自己的墙钟**
 *   （`performance.now()` 前后差 ✓），并在数字旁边**如实**就是"毫秒"（不写成"索引耗时"✗）。
 * - 元信息行**第一段**（`笔记`）按页面 `kind` 渲染（`database` ⇒ `数据库`，其余 ⇒ `笔记` ✓，
 *   与 `PageTree.tsx:496` 的判据同源 ✓）；⛔ 拿不到 `kind` 时**不编造**，只显示时间 ✓。
 *   时间取自 `useNotes(s => s.pages)` 里那一页的 `updated_at` ✓（`SearchResult` 本身**没有**时间字段 ✗）；
 *   跨空间结果不在这份列表里 ⇒ **只显示类型、不显示时间** ✓（不编造 ✗）。
 */
export function MobileSearch() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）。
  const setScreen = useMobileNav((s) => s.setScreen);
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 回首页（与 04 阅读屏同一套动作 ✓，不新造第二种口径 ✓）。 */
  const goHome = useCallback(() => setScreen("home"), [setScreen]);

  // ⭐ **安卓返回键**：直连返回栈底层（`MobileCapture`/`MobileRead` 的同一处置 ✓）。
  useEffect(() => pushOverlay("mobile-search", goHome), [goHome]);

  // 进屏即聚焦输入框（效果图里光标就在框里 ✓）。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 检索（防抖 200ms；规格 §4.3「只读」，本屏不写库 ✓）。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setElapsedMs(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const started = performance.now();
      api
        .search(q, 50, false)
        .then((rs) => {
          if (!alive) return;
          setResults(rs);
          setElapsedMs(Math.max(1, Math.round(performance.now() - started)));
        })
        .catch(() => {
          if (!alive) return;
          setResults([]);
          setElapsedMs(null);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim();
  const count = results.length;

  return (
    <div className="main msearch" data-testid="mobile-search">
      <header className="msearch-head">
        <button className="msearch-back" onClick={goHome} aria-label="返回首页">
          ‹
        </button>
        <div className="msearch-box">
          <span className="msearch-box-icon" aria-hidden>
            🔍
          </span>
          <input
            ref={inputRef}
            className="msearch-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索笔记"
            aria-label="搜索笔记"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button className="msearch-clear" onClick={() => setQuery("")} aria-label="清空">
              ×
            </button>
          ) : null}
        </div>
      </header>

      {/* 筛选 ＋ 读数（效果图：chips 在左、「N 条结果 · M 毫秒」在右 ✓） */}
      <div className="msearch-bar">
        <div className="msearch-chips">
          <button className="msearch-chip is-on" aria-pressed="true">
            全部
          </button>
          {/* ⛔ 这两个**没做**（见文件头 ⚠️）：渲染成 disabled 让缺口看得见 ✓，不许"点得动但没用" ✗ */}
          <button className="msearch-chip" disabled title="检索接口暂不支持只搜标题（未做 ✗）">
            标题
          </button>
          <button className="msearch-chip" disabled title="检索接口暂不支持只搜正文（未做 ✗）">
            正文
          </button>
        </div>
        <span className="msearch-stat">
          {q ? `${count} 条结果${elapsedMs !== null ? ` · ${elapsedMs} 毫秒` : ""}` : ""}
        </span>
      </div>

      <div className="msearch-scroll">
        {q && count > 0
          ? results.map((r, i) => {
              const meta = pages.find((p) => p.id === r.id);
              const kind = meta ? (meta.kind === "database" ? "数据库" : "笔记") : null;
              return (
                <button
                  key={r.id}
                  className={"msearch-item" + (i === 0 ? " is-active" : "")}
                  onClick={() => void openPage(r.id)}
                >
                  <span className="msearch-item-main">
                    <span className="msearch-item-title">{r.title || "未命名"}</span>
                    <span className="msearch-item-snippet">
                      <Highlighted text={r.snippet} />
                    </span>
                    <span className="msearch-item-meta">
                      {kind ? `${kind}${meta ? " · " + timeAgo(meta.updated_at) : ""}` : ""}
                    </span>
                  </span>
                  <span className="msearch-item-go" aria-hidden>
                    ›
                  </span>
                </button>
              );
            })
          : null}
        {q && count === 0 && !loading ? <p className="msearch-empty">没有找到「{q}」</p> : null}
        {!q ? <p className="msearch-hint">输入关键词，检索本机索引里的标题与正文</p> : null}
        {q ? <p className="msearch-foot">结果由本机索引生成 · 未上传服务器</p> : null}
      </div>
    </div>
  );
}
