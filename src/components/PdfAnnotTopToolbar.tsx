// 方案 B — PDF 阅读器顶部的单一批注工具栏（固定在视图顶部）。
// 作用于「当前活动页」：工具选择是全局共享（所有页用同一工具），
// 撤销/导出/删除/摘录/AI/复制/便签编辑/OCR 走当前页的控制器句柄。
//
// ── 2026-09-22（owner："pdf 页内工具栏任何时候不换行，空间狭小时，可以收起来，不截断"）──
//
// 改前这一行是 `flex-wrap: wrap`：宽度不够就**折成两行**（1280 上少一列面板时
// `tools 454 + status 215` 就折；选中一条批注再多出 `actions` 更是折了又折），
// 窄屏则靠 `.pdf-annot-tools { overflow-x: auto }` 把按钮推出屏外。两种都不是"收起来"。
//
// 现在：**单行**（`flex-wrap: nowrap`）＋ 量宽后的**按优先级收起**，收起来的项全部进「⋯」菜单，
// 功能一个不少（`HIDE_ORDER`）：
//   ① `status`      文本层 chip + 朗读 / OCR / AI（页面级命令，最后才用得上）
//   ② `actions`     选中一条标注之后的操作组（摘录 / AI 帮读 / 编辑 / 复制引用 / 删除）
//   ③ `labels`      工具按钮的**文字标签**（退成图标态：选择 / 高亮 / 画笔 / 便签 / 撤销 / 导出）
//   ④ `undoExport`  撤销 + 导出批注（这一步之后只剩 4 枚模式图标 + ⋯，≈230px）
//
// ⚠️ 宽度是**量出来的**，不是按视口猜的：每个候选先临时 `display:flex` 回来、读 rect、再恢复，
// 全过程在同一个 `useLayoutEffect` 里同步完成（浏览器不会在这中间绘制 ⇒ 看不见这一瞬）。
// 因为每次都**从"全展开"重新推导一遍**，"要不要收"是纯函数 ⇒ 不会出现"收了又放、放了又收"的抖动。
//
// ⚠️ 「⋯」菜单 `.pdf-annot-more-pop` 是**锚在工具条里的内联菜单**（与同文件族的 `.pdf-eye-pop`
// 同一先例），不是应用级浮层，因此**不登记** `useOverlayLayer`（返回键关的是阅读器本身）。
// 若要让返回键先关它，改成 `useOverlayLayer("pdfAnnotMore", …)` 并在
// `check-overlay-registry.mjs` 的 B 判据里补一条豁免即可。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PdfPageController, AnnotTool, PdfPageState } from "./pdfAnnotController";
import { TOOLS } from "./pdfAnnotController";
import { ocrBusyButtonLabel } from "../lib/pdfOcrCopy";

interface Props {
  /** 当前活动页控制器（无则禁用大部分操作）。 */
  ctl: PdfPageController | null;
  /** 版本号：页状态变化时递增，触发本组件重读 ctl.getState()。 */
  version: number;
  tool: AnnotTool;
  onToolChange: (t: AnnotTool) => void;
}

/** 空间不够时**按这个顺序**收进「⋯」（越靠前越先收；最后一个是最舍不得收的）。 */
const HIDE_ORDER = ["status", "undoExport", "labels", "actions"] as const;
type HideKey = (typeof HIDE_ORDER)[number];

const _iconFor: Record<AnnotTool, string> = {
  select: "M4 4l7.5 16 2-6.5L20 11.5z",
  highlight: "M9 11l4 4L19 9a2 2 0 0 0-3-3l-6 6H9z",
  ink: "M12 19l7-7a2 2 0 0 0-3-3l-7 7v3h3z",
  sticky: "M4 5h16v10l-5 5H4z",
};

export function PdfAnnotTopToolbar({ ctl, version, tool, onToolChange }: Props) {
  // version 变化 → 重读当前页状态快照（撤销/选中/批注数等）。
  const st: PdfPageState = useMemo(() => (ctl ? ctl.getState() : nullSt()), [ctl, version]);
  const [hidden, setHidden] = useState<HideKey[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // ---------------------------------------------------------------------------
  // 量宽 → 决定"收哪几项"。幂等：每次都从"全展开"重新推导，写回 state 前先比对。
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    const row = rowRef.current;
    const moreWrap = moreRef.current;
    if (!bar || !row || !moreWrap || typeof getComputedStyle !== "function") return;
    const tools = row.querySelector<HTMLElement>(".pdf-annot-tools");
    if (!tools) return;
    const pair = row.querySelector<HTMLElement>(".pdf-annot-pair");
    const actions = row.querySelector<HTMLElement>(".pdf-annot-actions");
    const status = row.querySelector<HTMLElement>(".pdf-annot-status");

    const cs = getComputedStyle(row);
    const gap = parseFloat(cs.columnGap) || 0;
    // 可用宽取**工具条**的内容宽，而不是行（`.pdf-annot-toolbar-row`）的：
    // 「⋯」是行的兄弟节点，它一出现行就窄了 `wMore + gap` —— 拿行的宽度当预算，
    // 就会和 `need()` 里那笔「⋯ 也要占位」重复计算 ⇒ 自己把自己逼着多收一格。
    const bcs = getComputedStyle(bar);
    const avail =
      bar.clientWidth - (parseFloat(bcs.paddingLeft) || 0) - (parseFloat(bcs.paddingRight) || 0);
    if (avail <= 16) return;

    // ① 把候选**全部**显示出来（同一个 layout effect 内恢复）
    // ⚠️ 前提是"收起来的项**仍然渲染**、只是被 CSS 藏起来"（见 JSX 与 App.css 的 `[data-collapse]`）。
    // 第一版写成了条件渲染 ⇒ 收起来之后 `querySelector` 直接拿到 null，量到 0 宽，
    // "收起来"与"放回去"互相触发（React: Maximum update depth exceeded）。
    const restores: [HTMLElement, string][] = [];
    const force = (el: HTMLElement | null) => {
      if (!el) return;
      if (getComputedStyle(el).display === "none") {
        restores.push([el, el.style.display]);
        el.style.display = "flex";
      }
    };
    force(moreWrap);
    force(pair);
    force(actions);
    force(status);
    const iconsOn = tools.classList.contains("is-icons");
    tools.classList.remove("is-icons");

    // ② 量（**带标签**那一态）
    const w = (el: HTMLElement | null) => (el ? el.getBoundingClientRect().width : 0);
    const wToolsFull = w(tools);
    const wPairFull = w(pair);
    const wActions = w(actions);
    const wStatus = w(status);
    const wMore = w(moreWrap);
    // 再量**图标**那一态：撤销 / 导出批注在工具组内部，收掉它们省下的宽度
    // 取决于当时标签在不在（160 vs 76），两个都要量。
    tools.classList.add("is-icons");
    const wToolsIcons = w(tools);
    const wPairIcons = w(pair);
    if (!iconsOn) tools.classList.remove("is-icons");
    const pairGap = pair ? parseFloat(getComputedStyle(tools).columnGap) || 0 : 0;

    // ③ 还原（把 ① 改过的内联样式还回去；`is-icons` 已在 ② 里恢复）
    for (const [el, display] of restores) el.style.display = display;

    const need = (set: HideKey[]): number => {
      const s = new Set(set);
      let total = s.has("labels") ? wToolsIcons : wToolsFull;
      if (s.has("undoExport")) total -= (s.has("labels") ? wPairIcons : wPairFull) + pairGap;
      let groups = 0;
      let groupW = 0;
      if (actions && !s.has("actions")) {
        groups++;
        groupW += wActions;
      }
      if (status && !s.has("status")) {
        groups++;
        groupW += wStatus;
      }
      total += groupW + groups * gap;
      // 「⋯」自己也是一格：一旦收了东西它就要占位（含与前一格的间距）
      if (set.length) total += gap + wMore;
      return total;
    };
    const fits = (set: HideKey[]) => need(set) <= avail + 1;

    let next: HideKey[] = [];
    if (!fits(next)) {
      for (const k of HIDE_ORDER) {
        if (k === "actions" && !actions) continue;
        if (k === "undoExport" && !pair) continue;
        next = [...next, k];
        if (fits(next)) break;
      }
    }
    if (next.join(" ") !== hidden.join(" ")) setHidden(next);
  });

  // 容器宽度变了（面板开合 / 窗口缩放 / 横竖屏）→ 触发一次重渲染，让上面那个量宽 effect 重算。
  // 这个 state 的值本身不用：量宽 effect 没有依赖数组，每次渲染都会重算一遍。
  const [, bump] = useState(0);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => bump((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 菜单：点外面 / Esc 关掉；已经没有可收的项时也关掉。
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);
  useEffect(() => {
    if (!hidden.length && menuOpen) setMenuOpen(false);
  }, [hidden.length, menuOpen]);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  const toolBtn = (id: AnnotTool, label: string, hint: string) => (
    <button
      key={id}
      className={`pdf-annot-tool ${tool === id ? "active" : ""}`}
      onClick={() => onToolChange(id)}
      title={hint}
      aria-pressed={tool === id}
    >
      <span className="pdf-annot-tool-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={_iconFor[id]} /></svg>
      </span>
      <span className="pdf-annot-tool-label">{label}</span>
    </button>
  );

  /** 撤销 + 导出批注（一个整体：要么都在工具组里，要么一起进「⋯」）。 */
  const undoExport = (
    <div className="pdf-annot-pair">
      <button
        className={`pdf-annot-tool ${st.canUndo ? "" : "disabled"}`}
        onClick={() => ctl?.undo()}
        disabled={!st.canUndo}
        title="撤销上次批注"
      >
        <span className="pdf-annot-tool-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 13" /></svg>
        </span>
        <span className="pdf-annot-tool-label">撤销</span>
      </button>
      <button
        className={`pdf-annot-tool ${st.annotationsCount ? "" : "disabled"}`}
        onClick={() => ctl?.exportAnnotations()}
        disabled={!st.annotationsCount}
        title="把本页全部批注导出为笔记块（含 pdf:// 回链）"
      >
        <span className="pdf-annot-tool-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
        </span>
        <span className="pdf-annot-tool-label">导出批注</span>
      </button>
    </div>
  );

  // ⚠️ 容器**只在有内容时渲染**：`.pdf-annot-actions` 自带背景/圆角/内边距，
  // 空着就是一枚 **14×10 的小白胶囊** 挂在工具条上（owner 2026-09-22 截图圈出的那个）。
  const actions = st.selected ? (
    <div className="pdf-annot-actions">
      <button className="pdf-annot-tool accent" onClick={() => ctl?.excerpt()} title="把选中内容摘录为笔记块（含 pdf:// 回链）">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
        <span className="pdf-annot-tool-label">摘录成块</span>
      </button>
      <button className="pdf-annot-tool accent" onClick={() => ctl?.aiRead()} disabled={st.aiBusy} title="AI 总结这段 PDF 文字，生成笔记块（含 pdf:// 回链）">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" /></svg>
        <span className="pdf-annot-tool-label">{st.aiBusy ? "AI 中…" : "AI 帮读"}</span>
      </button>
      {st.selectedType === "sticky" && (
        <button className="pdf-annot-tool" onClick={() => ctl?.editSticky()} title="编辑便签内容">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          <span className="pdf-annot-tool-label">编辑</span>
        </button>
      )}
      <button className="pdf-annot-tool" onClick={() => ctl?.copyRef()} title="复制 PDF 引用（可粘贴到别处回链）">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        <span className="pdf-annot-tool-label">复制引用</span>
      </button>
      <button className="pdf-annot-tool danger" onClick={() => ctl?.deleteSelected()} title="删除选中标注">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
        <span className="pdf-annot-tool-label">删除</span>
      </button>
    </div>
  ) : null;

  // 页面的**能力状态 + 页面级命令**：文本层 chip 与 朗读 / OCR / AI 同在一格。
  // 标签一律**短**（朗读 / OCR / AI），完整说法进 `title`。
  const status = (
    <div className="pdf-annot-status">
      <span
        className={`pdf-annot-layer ${st.hasTextLayer ? "ok" : "warn"}`}
        title={st.hasTextLayer ? "有文本层，可精确划词" : "无文本层，建议用矩形/画笔/便签"}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {st.hasTextLayer ? <path d="M20 6L9 17l-5-5" /> : <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
        </svg>
        {st.hasTextLayer ? "有文本层" : "无文本层"}
      </span>
      <div className="pdf-annot-ocr-actions">
        <button className="pdf-annot-ocr" onClick={() => ctl?.speakPage()} title="朗读本页（有文本层读全文；扫描版先识别再听）">朗读</button>
        {!st.hasTextLayer && (
          <>
            {/* 忙碌文案跟着**在跑的那条路**走。旧写法让「OCR 识别本页」无条件变成「识别中…」，
                于是点「AI 识别」时反倒由 OCR 那个按钮替它表态（2026-09-20 用户截图里的那一幕）。 */}
            <button
              className="pdf-annot-ocr"
              onClick={() => ctl?.runOcr()}
              disabled={st.ocrBusy}
              title="OCR 识别本页（本机识别；无文本层时把扫描页变成可划词的文字）"
            >
              {st.ocrBusy && st.ocrMode === "ocr" ? ocrBusyButtonLabel("ocr") : "OCR"}
            </button>
            <button className="pdf-annot-ocr pdf-annot-ocr-ai" onClick={() => ctl?.visionOcr()} disabled={st.ocrBusy} title="用 AI 视觉大模型识别本页文字（对中文/复杂排版通常更准，需配置支持图像的模型）">
              {st.ocrBusy && st.ocrMode === "ai" ? ocrBusyButtonLabel("ai") : "AI"}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const moreCount = hidden.length;

  return (
    <div
      className={`pdf-annot-toolbar${moreCount ? " has-more" : ""}`}
      data-collapse={hidden.join(" ")}
      ref={toolbarRef}
    >
      <div className="pdf-annot-toolbar-row" ref={rowRef}>
        <div
          className={`pdf-annot-tools${hiddenSet.has("labels") ? " is-icons" : ""}`}
          role="toolbar"
          aria-label="批注工具"
        >
          {TOOLS.map((t) => toolBtn(t.id, t.label, t.hint))}
          {undoExport}
        </div>
        {actions}
        {status}
      </div>
      <div className="pdf-annot-more-wrap" ref={moreRef}>
        <button
          type="button"
          className={`pdf-annot-tool pdf-annot-more${menuOpen ? " active" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label="更多批注操作"
          title="更多批注操作（一行放不下时收在这里）"
        >
          <span className="pdf-annot-tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </span>
        </button>
        {/* ⚠️ 菜单里的这几件是**同一份渲染函数的第二份调用**（收起来的那几项在这里仍可点到）。
            它必须留在 `.pdf-annot-toolbar-row` **外面**：量宽时按 `.pdf-annot-*` 找的是行内那一份。 */}
        {menuOpen && (
          <div className="pdf-annot-more-pop" role="group" aria-label="更多批注操作">
            {hiddenSet.has("undoExport") && undoExport}
            {hiddenSet.has("actions") && actions}
            {hiddenSet.has("status") && status}
          </div>
        )}
      </div>
    </div>
  );
}

function nullSt(): PdfPageState {
  return { selected: null, selectedType: null, annotationsCount: 0, canUndo: false, hasTextLayer: false, ocrBusy: false, ocrMode: "ocr", aiBusy: false };
}
