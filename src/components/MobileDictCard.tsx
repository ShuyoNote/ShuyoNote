import { useCallback, useEffect, useState } from "react";
import { lookupWord, presentOutcome, type LookupPresentation } from "../lib/dictionary/lookup";
import { platform } from "../lib/platform";

/**
 * **移动端「划词查词」卡片**（效果图 `docs/plans/mobile/mockups/06-dict.svg`，规格 §4.6）。
 *
 * ⭐ **形态照图** ✓：卡片**压在正文上**（图里就是"正文还在、词条卡盖在下半屏"✓）——
 * 所以它是 `MobileRead` 里的一层卡，⛔ 不是把正文换掉 ✗。
 *
 * 照图逐条 ✓（能做的）：
 * - 词条大字 `白平衡` ⇒ `view.title`（后端给的 `entry.word` ✓）
 * - 小字行 `bái píng héng · 摄影术语` ⇒ `view.meta`；⚠️ 本机可用的只有 **`phonetic` ＋ `pos`**
 *   （`entry.phonetic` / `entry.pos` ✓），图上的**「领域」没有字段** ✗ ⇒ 这里显示的是**词性** ✓
 * - 释义正文（`1 …` / `2 …`）⇒ `view.body`（`translation`→`definition` 的既有口径 ✓）
 * - `复制` ⇒ `navigator.clipboard` ✓
 * - 页脚 `释义来源：本机词典` ✓
 *
 * ⚠️ **如实标注：没做到的部分** ✗（不许把没做的写成做了 ✗）：
 * - **`加入词库` 没做** ✗ —— 全仓 `grep 加入词库` **零命中** ✅（没有词库存储、也没有对应命令 ✓）
 *   ⇒ 渲染成 `disabled` ＋ `title` 写明「未接」✓（**让缺口看得见** ✓，⛔ 不做"按下去什么也不发生"的假按钮 ✗）。
 * - 图上的 **「例：…」例句框** ✗ —— `DictionaryEntry` **没有例句/领域字段** ✗ ⇒ **不做** ✓。
 * - 图底部那条 `高亮 / † / 笔记` 工具条是**另外三个功能**（高亮、加粗、记笔记）✗ ⇒ **不做** ✓。
 * - 例子词：图上是中文词 `白平衡`，而**本机是英汉词典**（`DictionaryMissKind` 含 `not_english` ✗，
 *   `src/lib/dictionary/lookup.test.ts:79` 逐字「本地词典是英汉词典，不含中文词条」✓）
 *   ⇒ 自测用**真英文词** ✓（⛔ 不照图的中文词 ✗），查不到时如实走"未收录／走 AI"那一档 ✓。
 */
export function MobileDictCard({ word, onClose }: { word: string; onClose: () => void }) {
  const [view, setView] = useState<LookupPresentation | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setView(null);
    setCopied(false);
    // ⚠️ 与桌面划词浮层**同一条路**（`platform.executor` ⇒ `dictionary_lookup` ✓）——
    //    ⛔ 我没有改桌面那个 Lexical 插件 ✗（它是桌面专用 ✓），这里只是**阅读屏专属**的第二处调用 ✓。
    lookupWord(platform.executor, word)
      .then((outcome) => {
        if (alive) setView(presentOutcome(outcome));
      })
      .catch(() => {
        if (alive) setView({ tone: "unavailable", title: word, body: "查词调用失败（本机词典没答上来）", meta: "", aiHint: false });
      });
    return () => {
      alive = false;
    };
  }, [word]);

  const copy = useCallback(() => {
    const text = view ? `${view.title}\n${view.body}` : word;
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [view, word]);

  return (
    <aside className="mdict" data-testid="mobile-dict">
      <div className="mdict-head">
        <span className="mdict-word">{view?.title ?? word}</span>
        <button className="mdict-close" onClick={onClose} aria-label="关闭词条">
          ×
        </button>
      </div>
      {view?.meta ? <p className="mdict-meta">{view.meta}</p> : null}
      <p className="mdict-body">{view ? view.body : "正在查…"}</p>
      <div className="mdict-actions">
        {/* ⛔ 没这个功能 ⇒ 明标未接（禁用 ＋ title 写原因 ✓） */}
        <button className="mdict-btn is-primary" disabled title="本屏未接：没有词库存储、也没有对应命令（未做 ✗）">
          加入词库
        </button>
        <button className="mdict-btn" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p className="mdict-src">释义来源：本机词典</p>
    </aside>
  );
}
