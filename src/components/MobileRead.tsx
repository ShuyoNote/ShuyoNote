import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { hasLookupChars, normalizeSelection } from "../lib/dictionary/lookup";
import { pushOverlay } from "../lib/overlayStack";
import { useMobileNav } from "../store/mobileNav";
import { useNotes } from "../store/notes";
import type { PageBlock } from "../types";
import { MobileDictCard } from "./MobileDictCard";

/**
 * **移动端「阅读」屏**（效果图 `docs/plans/mobile/mockups/04-read.svg`，规格 §4.4）。
 *
 * 为什么要有它：手机档点开一条笔记，原先走的是**桌面编辑器** ✗（块编辑器全功能、
 * 顶栏是桌面那套图标工具条、还能拖块），与效果图差得最远。本屏只做**只读阅读** ✓。
 *
 * 照效果图逐条 ✓（能做的）：
 * - 顶部：`‹` 返回 ＋「阅读」标题 ✓
 * - 正文上方：标题 ＋ **元信息行** ✓
 * - **「在电脑上继续」提示块** ✓（副文案如实写"同步通道尚未打通" —— 与
 *   `_workspace/notes/2026-10-10-mobile-screen-audit.md`、`08-pair` 的实测口径一致 ✓）
 * - **正文排版**：按**顶层块**逐块渲染 ✓
 * - 页脚：**「本页共 N 块 · 本机已保存」** ✓
 *
 * ⚠️ **如实标注：没做到的部分** ✗（不许把没做的写成做了 ✗）：
 * - 效果图里的**引用块（蓝色左竖线）**、**图片占位（虚线框）** 我**没做** ✗ ——
 *   原因不是偷懒：本屏是**新文件**，而内容层的直接读取被门禁
 *   `scripts/check-doc-content-access.mjs` **按文件基线**卡住（新文件一引用就红 ✗，
 *   基线又在 `scripts/**`、不在本任务的写域内 ✗）⇒ 只能走**块级只读接口**
 *   `api.getPageBlocks()`，而它返回的是 `{ block_id, text }`（`src-tauri/src/blocks.rs:251`
 *   与 `src/lib/platform/web.ts:2236` 两处实现**都只有纯文本**）⇒ **拿不到块类型**
 *   ⇒ 标题层级／引用／图片这三类**渲染不出结构** ✗。想做对，得先把"结构化只读"开一个口子 ✓。
 * - 效果图元信息行是「拍摄现场 · 2026-10-08 15:20 · 本机」（第一段是**归属文件夹名**）——
 *   我手上只有页自身的 `updated_at` ⇒ 这里渲染「本机 · 更新时间」**两段** ✓（不编造文件夹名 ✗）。
 *
 * ⚠️ 与桌面档的关系：⛔ **桌面档一个字不动** ✓ —— 本屏只在 `isMobile && currentId` 时渲染
 * （`App.tsx` 那一支 ✓），桌面仍走 `NoteEditor` ✓。
 */
export function MobileRead({ pageId }: { pageId: string }) {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）。
  const current = useNotes((s) => s.current);
  const pages = useNotes((s) => s.pages);
  const setScreen = useMobileNav((s) => s.setScreen);

  const [blocks, setBlocks] = useState<PageBlock[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // ⭐ 2026-10-10 **06 划词查词**：选中的词（null ＝ 没在查）—— 形态照 `06-dict.svg`：
  //   卡片**压在正文上**，正文不动 ✓（见 `MobileDictCard.tsx` 文件头 ✓）。
  const [dictWord, setDictWord] = useState<string | null>(null);

  /**
   * 回首页：清掉"当前页" ⇒ `App.tsx` 的手机分支才会渲染 `MobileHome` ✓，
   * 再把屏栈复位 ✓。**与全局那个「‹ 首页」浮标同一套动作** ✓（不新造第二种口径 ✓）。
   */
  const goHome = useCallback(() => {
    useNotes.setState({ currentId: null, current: null });
    setScreen("home");
  }, [setScreen]);

  // ⭐ **安卓返回键**：直连返回栈底层 `pushOverlay(id, close)`（`MobileCapture` 的同一处置 ✓）——
  //   ⛔ 不用 `useOverlayLayer()` ✗：那条要求把 id 登记进 `verify-mobile-overlays.mjs` 的清单，
  //   而那份清单会在**每个视口**打开它，本屏只在手机档渲染 ⇒ 塞进去会造**假红** ✗。
  useEffect(() => pushOverlay("mobile-read", goHome), [goHome]);

  /**
   * ⭐ **06 划词查词**（规格 §4.6）：在正文里**选中一段** ⇒ 查本机词典 ⇒ 卡片浮上来 ✓。
   *
   * ⚠️ **不动桌面那个 Lexical 插件** ✗（`src/editor/plugins/DictionaryLookupPlugin.tsx` 是
   *    **桌面编辑器专用** ✓）—— 这里是**阅读屏专属**的第二条取词路径 ✓（Lead 2026-10-10 明确要求 ✓）。
   * ⚠️ 判据用仓里**现成的两个纯函数** ✓：`normalizeSelection`（折空白 ✓）＋ `hasLookupChars`
   *    （空/太长/没字母 ⇒ 不查 ✓）—— ⛔ 不自己写一套"什么算一个词" ✗。
   */
  const pickWord = useCallback(() => {
    const sel = window.getSelection();
    const word = normalizeSelection(sel ? sel.toString() : "");
    if (hasLookupChars(word)) setDictWord(word);
  }, []);

  // 卡片开着时，**安卓返回键先关卡片**（而不是直接回首页 ✓）—— 与浮层同一套"后进先出" ✓。
  useEffect(() => {
    if (!dictWord) return;
    return pushOverlay("mobile-dict", () => setDictWord(null));
  }, [dictWord]);

  // 正文：**块级只读接口**（唯一门禁安全的那条路 ✓，见文件头 ⚠️）。
  useEffect(() => {
    let alive = true;
    setBlocks(null);
    setErr(null);
    api
      .getPageBlocks(pageId)
      .then((b) => {
        if (alive) setBlocks(b);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e instanceof Error ? e.message : e).slice(0, 120));
        setBlocks([]);
      });
    return () => {
      alive = false;
    };
  }, [pageId]);

  // 标题／时间：优先用**已打开那一页**（`current`），退回到列表里的元信息 ✓。
  const meta = current && current.id === pageId ? current : pages.find((p) => p.id === pageId);
  const title = meta?.title?.trim() || "未命名";
  const updatedAt = meta?.updated_at;
  const count = blocks?.length ?? 0;

  return (
    <div className="main mread" data-testid="mobile-read">
      <header className="mread-head">
        <button className="mread-back" onClick={goHome} aria-label="返回首页">
          ‹
        </button>
        <span className="mread-head-title">阅读</span>
      </header>

      <div className="mread-scroll">
        <h1 className="mread-title">{title}</h1>
        <p className="mread-meta">
          本机
          {updatedAt ? ` · ${stamp(updatedAt)}` : ""}
        </p>

        {/* 「在电脑上继续」——效果图里那块淡蓝提示 ✓；副文案**如实**写同步没通 ✓ */}
        <aside className="mread-tip">
          <span className="mread-tip-icon" aria-hidden>
            🖥️
          </span>
          <span className="mread-tip-body">
            <span className="mread-tip-title">在电脑上继续</span>
            <span className="mread-tip-sub">同步通道尚未打通，先在桌面端打开同名笔记</span>
          </span>
        </aside>

        {blocks === null ? (
          <p className="mread-note">正在读取本页…</p>
        ) : err ? (
          <p className="mread-note">读不到本页正文：{err}</p>
        ) : count === 0 ? (
          <p className="mread-note">这一页还没有内容。</p>
        ) : (
          /* ⭐ 选中即查词（06 ✓）：`onPointerUp` 覆盖鼠标与触屏两种"选完松手" ✓ */
          <div className="mread-body" onPointerUp={pickWord}>
            {blocks.map((b) =>
              b.text ? (
                <p key={b.block_id} className="mread-p">
                  {b.text}
                </p>
              ) : null,
            )}
          </div>
        )}

        <p className="mread-foot">
          本页共 {count} 块 · 本机已保存
        </p>
      </div>

      {/* 词条卡**压在正文上** ✓（效果图 06 就是"正文还在、卡盖在下半屏"✓）—— 关掉它正文原样 ✓ */}
      {dictWord ? <MobileDictCard word={dictWord} onClose={() => setDictWord(null)} /> : null}
    </div>
  );
}

/**
 * 绝对时间（效果图元信息行是 `2026-10-08 15:20` 那种 ✓）。
 *
 * ⚠️ 入参是**毫秒时间戳**（`PageMeta.updated_at` ✓，与 `types.ts` 一致 ✓）。
 * 本仓**没有**现成的绝对时间格式化函数（`MobileHome.tsx` 里那份是**相对**时间 ✓）
 * ⇒ 这一处 8 行先本地放 ✓；哪天第二处要用再抽到 `src/lib/` ✓（别现在造抽象 ✗）。
 */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
