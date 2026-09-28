import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useMobileOverlayViewport } from "../hooks/useMobile";
import { usePdfReader } from "../store/pdfReader";
import { useAiStore } from "../store/ai";
import { canvasToPngBlob, type createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
// NOTE: pdf.js is large (~1MB) and only needed when a PDF is actually opened,
// so the runtime engine is imported lazily below (see the load effect), keeping
// it out of the initial bundle. `createPdfjsEngine` is imported as a *type only*
// so the `ReturnType<typeof createPdfjsEngine>` annotations stay valid without
// pulling the pdf.js runtime into the synchronous chunk.
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { PdfAnnotation } from "../lib/pdfAnnotation";
import type { OutlineItem } from "../lib/pdfRender";
import type { TextItemLike } from "../lib/pdfTextLayer";
import type { PdfAnnotationRecord } from "../types";
import { generateOutlineFromVision } from "../lib/aiOutline";
import { loadAiOutline, saveAiOutline } from "../lib/pdfOutlineStore";
import { tryConsume } from "../lib/ai/gate";
import { rebuildOutlineTree } from "../lib/pdfOutlineGen";
import type { ProviderConfig } from "../lib/ai/llm";
import { buildLayout, computeViewport, annCenterY, pageImageHeight, resolveZoomScale, stepZoom, zoomContentWidth, zoomLabel, zoomPct, ZOOM_LADDER, type ZoomMode } from "../lib/pdfLayout";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";
import { PdfAnnotTopToolbar } from "./PdfAnnotTopToolbar";
import type { AnnotTool, PdfPageController } from "./pdfAnnotController";
import { PdfSidebar } from "./PdfSidebar";
import { PdfOutline } from "./PdfOutline";
import { PdfAskBar } from "./PdfAskBar";

/** 「AI 生成目录」默认向后生成的页数（可在目录面板范围下拉里改：30/60/120 页或整本）。 */
const AI_OUTLINE_PAGES = 60;

/**
 * 头部工具条里**可以被收进「⋯」**的几项，按"先收谁"排序（2026-09-22，owner：
 * "pdf 阅读器顶部系统工具栏任何时候不换行，空间狭小时收起来，除了最右端的关闭按钮"）。
 *
 * 值 = `.pdf-reader-head` 里的选择器（每一项都是它的**直接子元素**，所以量宽公式很短）。
 * 顺序的理由：四个"视图开关"（最大化/批注侧栏/提问/护眼）最先收 → 导出 → 缩放 →
 * 翻页（页码读数也是信息，尽量留）→ 目录（导航入口）最后收。
 * **永不收**：文件名（它靠省略号自己缩）、「⋯」自己、**关闭**。
 */
const HEAD_HIDE_ORDER = ["tail", "export", "zoom", "nav", "outline"] as const;
type HeadHideKey = (typeof HEAD_HIDE_ORDER)[number];
const HEAD_HIDE_SEL: Record<HeadHideKey, string> = {
  tail: ".pdf-head-tail",
  export: ".pdf-head-export",
  zoom: ".pdf-reader-zoom",
  nav: ".pdf-reader-nav",
  outline: ".pdf-reader-outline-toggle",
};

/** 目录栏宽度持久化键。 */
const OUTLINE_WIDTH_KEY = "shuyonote.pdf.outlineWidth";
/** 批注侧栏宽度持久化键。 */
const SIDEBAR_WIDTH_KEY = "shuyonote.pdf.sidebarWidth";

/** 面板（目录/侧栏）拖拽调宽 + 双击归位。用**指针捕获**把 move/up 绑定到拖拽手柄自身，
 *  结束（up/cancel）必定清理，绝不往 window 累积监听器（否则相继拖动会越来越卡顿）。
 *  拖动直接改容器 DOM 宽度（不每帧 React 重渲染）。dir=1 左侧（向右加宽）/ dir=-1 右侧（向左加宽）。 */
function startPanelResize(
  e: ReactPointerEvent<HTMLDivElement>,
  cfg: {
    min: number; max: number; def: number; key: string; dir: 1 | -1;
    el: () => HTMLElement | null;
    commit: (n: number) => void;
    /** 拖动开始（用于暂停舞台 resize 的 React 更新）。 */
    onDragStart?: () => void;
    /** 拖动/双击结束（用于恢复并应用一次舞台尺寸）。 */
    onDragEnd?: () => void;
    /** 拖到多窄就**收起**（2026-09-22：拖拽与开合同一个手势）。不给就只按 min/max 夹。 */
    collapseAt?: number;
    onCollapse?: () => void;
  },
) {
  cfg.onDragStart?.();
  if (e.detail === 2) {
    cfg.commit(cfg.def);
    const el = cfg.el();
    if (el) el.style.width = `${cfg.def}px`;
    try { localStorage.setItem(cfg.key, String(cfg.def)); } catch { /* 忽略 */ }
    cfg.onDragEnd?.();
    return;
  }
  e.preventDefault();
  const el = cfg.el();
  const handle = e.currentTarget;
  if (!el || !handle) { cfg.onDragEnd?.(); return; }
  const startX = e.clientX;
  const startW = parseFloat(el.style.width) || cfg.def;
  let cur = startW;
  const detach = () => {
    try { handle.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
  };
  const stop = () => {
    detach();
    cfg.commit(cur);
    try { localStorage.setItem(cfg.key, String(cur)); } catch { /* 忽略 */ }
    cfg.onDragEnd?.();
  };
  /** 拖过头了：**不提交宽度**，直接收起（并结束这一次拖拽）。 */
  const collapse = () => {
    detach();
    cfg.onCollapse?.();
    cfg.onDragEnd?.();
  };
  const move = (ev: PointerEvent) => {
    const raw = startW + cfg.dir * (ev.clientX - startX);
    // 2026-09-22（owner："要可以通过鼠标拖拽收起展开"）：拖到 collapseAt 以内就收起。
    // 判据用**未夹的 raw**（夹过之后永远 ≥ min ⇒ 永远收不起来）。
    if (cfg.onCollapse && raw < (cfg.collapseAt ?? 0)) {
      collapse();
      return;
    }
    cur = Math.max(cfg.min, Math.min(cfg.max, raw));
    el.style.width = `${cur}px`;
  };
  const up = () => stop();
  const cancel = () => stop();
  try { handle.setPointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
}

/**
 * 面板**收起时**那条边上的"拖出来"手势（2026-09-22，owner："两侧侧栏要可以通过鼠标拖拽收起展开"）。
 * 收起后面板不在 DOM 里 ⇒ 没有可抓的 resizer，所以在同一条边上留一条 8px 手柄：
 *   · 拖动 ⇒ 面板立刻打开，宽度**跟着指针走**（绝对位置，不是增量 —— "拉出来"的手感）；
 *   · 拖不够（< 阈值）松手 ⇒ 撤回，仍然保持收起（避免误开）；
 *   · 双击 ⇒ 按默认宽度打开。
 */
function startPanelExpand(
  e: ReactPointerEvent<HTMLDivElement>,
  cfg: {
    min: number; max: number; def: number; key: string; side: "left" | "right";
    commit: (n: number) => void;
    open: () => void;
    close: () => void;
    collapseAt: number;
    onDragEnd?: () => void;
  },
) {
  e.preventDefault();
  const host = e.currentTarget.parentElement;
  const handle = e.currentTarget;
  if (!host) return;
  if (e.detail === 2) {
    cfg.commit(cfg.def);
    try { localStorage.setItem(cfg.key, String(cfg.def)); } catch { /* 忽略 */ }
    cfg.open();
    return;
  }
  const rect = host.getBoundingClientRect();
  const widthAt = (clientX: number) =>
    Math.max(cfg.min, Math.min(cfg.max, cfg.side === "left" ? clientX - rect.left : rect.right - clientX));
  const rawAt = (clientX: number) => (cfg.side === "left" ? clientX - rect.left : rect.right - clientX);
  let opened = false;
  let lastX = e.clientX;
  const detach = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
  };
  const move = (ev: PointerEvent) => {
    lastX = ev.clientX;
    const raw = rawAt(ev.clientX);
    if (raw >= cfg.collapseAt) {
      if (!opened) {
        opened = true;
        cfg.open(); // 一越过阈值就打开；随后 commit 让宽度跟手
      }
      cfg.commit(widthAt(ev.clientX));
    } else if (opened) {
      // 拖回去又不够宽 ⇒ 再次收起（手势两边对称）
      opened = false;
      cfg.close();
    }
  };
  const finish = () => {
    detach();
    try { handle.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
    if (opened) {
      const w = widthAt(lastX);
      cfg.commit(w);
      try { localStorage.setItem(cfg.key, String(w)); } catch { /* 忽略 */ }
    }
    cfg.onDragEnd?.();
  };
  try { handle.setPointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

/** 护眼模式开关的本地持久化键。 */
const EYE_CARE_KEY = "shuyonote.pdf.eyecare";

/** 护眼档位：off=关闭；soft=柔光；warm=暖黄(更明显)；night=夜间；green=淡绿(防蓝光)。 */
type EyeMode = "off" | "soft" | "warm" | "night" | "green";
const EYE_MODES: { id: EyeMode; label: string }[] = [
  { id: "off", label: "关闭护眼" },
  { id: "soft", label: "柔光" },
  { id: "warm", label: "暖黄" },
  { id: "night", label: "夜间" },
  { id: "green", label: "淡绿" },
];

// M24 — desktop native PDF render engine. Prefer the Rust/mupdf rasterizer when
// available (works in the Tauri webview too); otherwise fall back to pdf.js.
// Native returns raw RGBA8; we draw it into a <canvas> and emit a Blob so the
// rest of the reader (which renders an <img src>) stays engine-agnostic.
//
// 提速：native 路径用 JPEG（quality 0.92）而非 PNG —— PNG 无损编码在主线程很慢
//（整页 RGBA, 网页文本+图形占比高、性价比低）；JPEG 编码快一个数量级、体积小、
// `<img>` 解码也更快。页面是白纸背景（PDF 正文/批注 overlay 是 SVG 叠加在 <img> 上），
// JPEG 无透明度需求，白底即可。
async function renderPagePng(
  eng: ReturnType<typeof createPdfjsEngine>,
  attachmentId: string | null,
  pageIndex: number,
  scale: number,
): Promise<Blob> {
  if (attachmentId && platform.pdfRender.nativeAvailable()) {
    try {
      return await renderPageNative(attachmentId, pageIndex, scale);
    } catch (e) {
      // 原生引擎坏了不该让整页空白：退回 pdf.js（慢一点，但看得见）。
      // 这条日志是排查的第一个现场，别删。
      console.error("native page render failed, falling back to pdf.js", { pageIndex, scale, error: e });
    }
  }
  return eng.renderPageToBlob(pageIndex, scale);
}

/** 原生（MuPDF）渲染：RGBA8 → 白底画布 → JPEG Blob。 */
async function renderPageNative(attachmentId: string, pageIndex: number, scale: number): Promise<Blob> {
  const { bytes, width, height } = await platform.pdfRender.renderPdfPage(attachmentId, pageIndex, scale);
  // 再挡一道：宽高/字节数不合法时绝不进画布（NaN 会让 WKWebView 抛
  // "Value NaN is outside the range …"，Chrome 则静默画成 0×0）。
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`原生渲染返回的尺寸非法（${width}×${height}）`);
  }
  if (bytes.length !== width * height * 4) {
    throw new Error(`原生渲染字节数对不上（${width}×${height} 应为 ${width * height * 4} 字节，实际 ${bytes.length} 字节）`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 上下文");
  // 把 RGBA 叠到白纸上：PDF 常为透明底（alpha），直接 putImageData 会替换像素让透明
  // 仍透明，JPEG 会把透明当成黑。先把含 alpha 的像素画进临时画布，再 drawImage 到白底画布
  //（drawImage 做 alpha 混合），透明 → 白。
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext("2d");
  if (!tctx) throw new Error("无法创建 2D 上下文");
  const img = tctx.createImageData(width, height);
  img.data.set(bytes);
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  // 导出这页的 JPEG：同样不能只信 toBlob（见 canvasToPngBlob 的注释），
  // 失败时退回 PNG 的编码路径，至少让导出这一步能完成。
  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
  );
  return jpeg ?? canvasToPngBlob(canvas);
}

/** 触发浏览器下载一个 Blob（用于「导出带批注的 PDF 副本」）。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 单页块数据（懒加载，视口内才拉取）。
interface PageBlockData {
  url: string | null;
  textItems: TextItemLike[] | null;
  hasTextLayer: boolean;
  meta: { w: number; h: number } | null;
  /**
   * 这一页光栅化失败的原因（成功时为 null）。
   *
   * 以前两处渲染路径的 catch 都是空的（`// 忽略：图像加载失败不影响跳转`），于是
   * **失败看起来和"还没加载"一模一样**：页面位置、页码、工具条都在，就是一片空白，
   * 用户只能报"看不到内容"。失败必须留下痕迹——既是给人看，也是给排查用。
   */
  error?: string | null;
}

// 方案 B — 连续滚动中的单个页块。每页一个自包含 PdfAnnotationCanvas，
// 工具条/撤销/选中/批注都随页块走。宽 = 内容宽，高位略宽于内容以留间隙。
function PdfContinuousPage({
  pageIndex,
  attachmentId,
  data,
  width,
  focusTarget,
  onFocusConsumed,
  deleteTarget,
  onDeleteConsumed,
  tool,
  onToolChange,
  registerController,
  onStateChange,
  onChanged,
  renderPage,
  onRetry,
}: {
  pageIndex: number;
  attachmentId: string;
  data: PageBlockData;
  width: number;
  focusTarget: { pageIndex: number; ann: PdfAnnotation } | null;
  onFocusConsumed: () => void;
  /** 侧栏删掉的批注（一次性目标）：交给对应页去同步它自己的渲染状态。 */
  deleteTarget: { pageIndex: number; annId: string } | null;
  onDeleteConsumed: () => void;
  tool: AnnotTool;
  onToolChange: (t: AnnotTool) => void;
  registerController: (pageIndex: number, ctl: PdfPageController | null) => void;
  onStateChange: () => void;
  onChanged: () => void;
  renderPage: (pageIndex: number, scale: number) => Promise<Blob>;
  /** 重新光栅化这一页（失败后给用户一个出口，而不是让他去关掉重开）。 */
  onRetry: (pageIndex: number) => void;
}) {
  const { url, textItems, hasTextLayer, meta, error } = data;
  if (!meta) {
    return <div className="pdf-annot-placeholder" style={{ width }}>第 {pageIndex + 1} 页…</div>;
  }
  if (!url && error) {
    return (
      <div className="pdf-page-error" style={{ width }}>
        <div className="pdf-page-error-title">第 {pageIndex + 1} 页没能显示</div>
        <div className="pdf-page-error-why">{error}</div>
        <button className="pdf-page-error-retry" onClick={() => onRetry(pageIndex)}>重试</button>
      </div>
    );
  }
  return (
    <PdfAnnotationCanvas
      attachmentId={attachmentId}
      pageIndex={pageIndex}
      pageW={meta.w}
      pageH={meta.h}
      pageImageUrl={url}
      hasTextLayer={hasTextLayer}
      textItems={textItems}
      focusTarget={focusTarget}
      onFocusConsumed={onFocusConsumed}
      deleteTarget={deleteTarget}
      onDeleteConsumed={onDeleteConsumed}
      tool={tool}
      onToolChange={onToolChange}
      registerController={registerController}
      onStateChange={onStateChange}
      onChanged={onChanged}
      renderPage={renderPage}
    />
  );
}

// M24 — PDF reader modal. 方案 B：虚拟化连续滚动。文档以「页块栈」纵向排布：
// 每个页块绝对定位在累计偏移处（占位高 = 固定 chrome 带 + 页面图像高，宽统一为内容宽），
// 舞台只挂载视口 ± 缓冲的页块，其余页只占位（不渲染），保持整段可滚且不叠盖。
/**
 * PDF 阅读器。
 *
 * `inline` = 它是**内容区里的一种视图**（桌面端默认这样）：和 Markdown 阅读器一样铺满 `.main`，
 * 侧边栏与右栏都留着。此时"最大化窗口"没有意义（它已经在内容区里铺满），按钮不显示——
 * 留一个按下去什么都不发生的按钮，比没有更糟。
 * 窄屏（以及单页独立窗口）仍然按全屏浮层渲染。
 */
export function PdfReader({ inline = false }: { inline?: boolean } = {}) {
  // 逐字段订阅（`close` 是动作，引用恒定 ⇒ 选择器不产生额外重渲染）。
  const open = usePdfReader((s) => s.open);
  const attachmentId = usePdfReader((s) => s.attachmentId);
  const name = usePdfReader((s) => s.name);
  const bytes = usePdfReader((s) => s.bytes);
  const targetPage = usePdfReader((s) => s.targetPage);
  const close = usePdfReader((s) => s.close);
  useOverlayScrollLock(open);
  // Android 返回键：**只在它确实以覆盖层身份出现时才登记**。
  // `inline` 模式下它就是内容区里的一种视图（和 Markdown 阅读器一样铺满 `.main`），
  // 那时没有"最上层浮层"可言，登记进去只会让返回键先吃掉一次按键。
  // 浮层形态（窄屏 / 单页独立窗口）才登记。
  useOverlayLayer("pdfReader", open && !inline, close);
  // 浮层形态视口（窄**或**矮）：目录栏 / 批注栏在这时是**盖在正文上的抽屉**，不是并排的列。
  // 判据与 CSS 那段 `@media (max-width:768px), (max-height:520px)` 逐字对应（同一个 hook）。
  const overlayViewport = useMobileOverlayViewport();
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState<ZoomMode>({ mode: "fit-width" });
  const [maximized, setMaximized] = useState(true);
  // 宽屏默认两栏都开（桌面阅读习惯）；抽屉形态下**默认收起**——真机上 360 宽开着目录栏
  // 等于正文看不见（页面图 x=99/宽 306，右边直接溢出屏幕）。
  const [sidebarOpen, setSidebarOpen] = useState(() => !overlayViewport);
  const [outlineOpen, setOutlineOpen] = useState(() => !overlayViewport);
  /**
   * 头部工具条的「⋯」菜单是否展开（2026-09-22 起它由**量宽**决定要不要出现，不再只属于窄屏）。
   *
   * owner："pdf 阅读器顶部系统工具栏任何时候不换行，空间狭小时收起来，除了最右端的关闭按钮。"
   * 放不下的那几项按 `HEAD_HIDE_ORDER` 收进这里；**关闭按钮永远不收**（它是"离开"的唯一入口）。
   */
  const [headMenuOpen, setHeadMenuOpen] = useState(false);
  const headRef = useRef<HTMLDivElement | null>(null);
  const headMoreRef = useRef<HTMLDivElement | null>(null);
  const [headHidden, setHeadHidden] = useState<HeadHideKey[]>([]);
  const headHiddenSet = useMemo(() => new Set(headHidden), [headHidden]);
  // 容器宽度变了（面板开合 / 窗口缩放 / 横竖屏）→ 触发一次重渲染，让下面那个量宽 effect 重算。
  const [, headBump] = useState(0);
  useEffect(() => {
    const el = headRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => headBump((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 菜单：点外面 / Esc 关掉；没有可收的项时也关掉（宽度变宽了它就该自己消失）。
  useEffect(() => {
    if (!headMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!headMoreRef.current?.contains(e.target as Node)) setHeadMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHeadMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [headMenuOpen]);
  useEffect(() => {
    if (!headHidden.length && headMenuOpen) setHeadMenuOpen(false);
  }, [headHidden.length, headMenuOpen]);
  // ---------------------------------------------------------------------------
  // 量宽 → 决定头部收哪几项。与 `PdfAnnotTopToolbar` 是**同一套做法**：
  //   · 候选先临时显示回来、读 rect、再恢复 —— 全在同一个 layout effect 里同步走完，
  //     浏览器不会在这中间画一帧；
  //   · 每次都从"全展开"重新推导 ⇒ "要不要收"是纯函数，不会"收了又放、放了又收"。
  // 这里每一项都是头部的直接子元素（工具条那份不一样：撤销/导出嵌在工具组里，
  // 而且标签收起会改变那一组的宽度），所以公式是简版：宽度求和 + 间距。
  // ⚠️ 前提同样是"收起来的项**仍然渲染**、只是被 CSS 藏起来"——条件渲染会让这里量到 0 宽。
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const head = headRef.current;
    const moreWrap = headMoreRef.current;
    if (!head || !moreWrap || typeof getComputedStyle !== "function") return;
    const hcs = getComputedStyle(head);
    const gap = parseFloat(hcs.columnGap) || 0;
    const avail = head.clientWidth - (parseFloat(hcs.paddingLeft) || 0) - (parseFloat(hcs.paddingRight) || 0);
    if (avail <= 16) return;
    const restores: [HTMLElement, string][] = [];
    const force = (el: HTMLElement | null) => {
      if (!el) return;
      if (getComputedStyle(el).display === "none") {
        restores.push([el, el.style.display]);
        el.style.display = "flex";
      }
    };
    force(moreWrap);
    const cands: [HeadHideKey, HTMLElement | null][] = HEAD_HIDE_ORDER.map((k) => [
      k,
      head.querySelector<HTMLElement>(`:scope > ${HEAD_HIDE_SEL[k]}`),
    ]);
    for (const [, el] of cands) force(el);
    const w = (el: HTMLElement | null) => (el ? el.getBoundingClientRect().width : 0);
    const wMore = w(moreWrap);
    const candEls = new Set(cands.map(([, el]) => el).filter(Boolean) as HTMLElement[]);
    const nameEl = head.querySelector<HTMLElement>(":scope > .pdf-reader-name");
    // 文件名按**地板宽**计（它自己会用省略号缩到 `min-width`，见 App.css）。地板从 CSS 读，
    // 不在这里抄一份 —— 抄一份就会两边漂移。
    const nameFloor = nameEl ? parseFloat(getComputedStyle(nameEl).minWidth) || 0 : 0;
    const natural = Array.from(head.children).filter(
      (c) => c !== moreWrap && (c === nameEl || candEls.has(c as HTMLElement) || getComputedStyle(c).display !== "none"),
    ) as HTMLElement[];
    // 各项**自身**占的宽（不含间距与「⋯」）
    const itemW = new Map<HeadHideKey, number>();
    for (const [k, el] of cands) if (el) itemW.set(k, w(el));
    let sum = 0;
    for (const c of natural) sum += c === nameEl ? nameFloor : w(c);
    for (const [el, display] of restores) el.style.display = display;

    const need = (set: HeadHideKey[]) => {
      const vis = natural.length - set.length;
      let t = sum;
      for (const k of set) t -= itemW.get(k) ?? 0;
      t += Math.max(0, vis - 1) * gap;
      if (set.length) t += gap + wMore; // 「⋯」自己也要占一格（含它与前一格之间的间距）
      return t;
    };
    let next: HeadHideKey[] = [];
    if (need(next) > avail + 1) {
      for (const k of HEAD_HIDE_ORDER) {
        if (!itemW.has(k)) continue;
        next = [...next, k];
        if (need(next) <= avail + 1) break;
      }
    }
    if (next.join(" ") !== headHidden.join(" ")) setHeadHidden(next);
  });
  // 转到抽屉形态（竖屏转横屏、把窗口拖矮、进分屏）时**收起来**：留着开就是拿两栏盖住正文。
  // 只单向收敛（不回弹），把"要不要打开"的决定权留给用户。
  useEffect(() => {
    if (!overlayViewport) return;
    setOutlineOpen(false);
    setSidebarOpen(false);
  }, [overlayViewport]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // 「AI 生成目录（本段）」进行态（进度/阶段/取消）。扫描版无目录时才显示入口。
  const [aiOutline, setAiOutline] = useState<{ status: "idle" | "running" | "done" | "error"; stage: "ocr" | "ai"; done: number; total: number }>({ status: "idle", stage: "ocr", done: 0, total: 0 });
  const [aiOutlineCount, setAiOutlineCount] = useState<number>(AI_OUTLINE_PAGES); // -1=整本
  const [aiOutlineCustom, setAiOutlineCustom] = useState(false); // 是否手工输入页数
  const aiOutlineAbortRef = useRef<AbortController | null>(null);
  // 目录栏宽度（可拖拽调宽，双击归位，持久化）。
  const [outlineWidth, setOutlineWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(OUTLINE_WIDTH_KEY));
    return Number.isFinite(v) && v >= 160 && v <= 520 ? v : 240;
  });
  const outlineColRef = useRef<HTMLDivElement | null>(null);
  // 面板拖拽期间暂停舞台 resize 的 React 更新（避免每帧整屏重渲染/缩放重算）。
  const isResizingRef = useRef(false);
  const applyStageSize = () => {
    const st = stageRef.current;
    if (!st) return;
    setStageWidth(st.clientWidth);
    setStageHeight(st.clientHeight);
  };
  const onOutlineResizeStart = (e: ReactPointerEvent<HTMLDivElement>) =>
    startPanelResize(e, {
      min: 160, max: 520, def: 240, key: OUTLINE_WIDTH_KEY, dir: 1,
      el: () => outlineColRef.current,
      commit: (n) => setOutlineWidth(n),
      onDragStart: () => { isResizingRef.current = true; },
      onDragEnd: () => { isResizingRef.current = false; applyStageSize(); },
      // 拖到 120 以内 ⇒ 直接收起（"拖拽收起"这一半）
      collapseAt: 120,
      onCollapse: () => setOutlineOpen(false),
    });
  /** 目录收起时：这条边上的手柄可以把面板"拖出来"（另一半）。 */
  const onOutlineExpandStart = (e: ReactPointerEvent<HTMLDivElement>) =>
    startPanelExpand(e, {
      min: 160, max: 520, def: 240, key: OUTLINE_WIDTH_KEY, side: "left",
      commit: (n) => setOutlineWidth(n),
      open: () => setOutlineOpen(true),
      close: () => setOutlineOpen(false),
      collapseAt: 120,
    });

  // 右侧批注侧栏宽度（同理：向左加宽 dir=-1，持久化）。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(v) && v >= 220 && v <= 560 ? v : 260;
  });
  const sidebarColRef = useRef<HTMLDivElement | null>(null);
  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) =>
    startPanelResize(e, {
      min: 220, max: 560, def: 260, key: SIDEBAR_WIDTH_KEY, dir: -1,
      el: () => sidebarColRef.current,
      commit: (n) => setSidebarWidth(n),
      onDragStart: () => { isResizingRef.current = true; },
      onDragEnd: () => { isResizingRef.current = false; applyStageSize(); },
      // 拖到 160 以内 ⇒ 直接收起
      collapseAt: 160,
      onCollapse: () => setSidebarOpen(false),
    });
  const onSidebarExpandStart = (e: ReactPointerEvent<HTMLDivElement>) =>
    startPanelExpand(e, {
      min: 220, max: 560, def: 260, key: SIDEBAR_WIDTH_KEY, side: "right",
      commit: (n) => setSidebarWidth(n),
      open: () => setSidebarOpen(true),
      close: () => setSidebarOpen(false),
      collapseAt: 160,
    });
  const outlineOcrCacheRef = useRef<Map<number, string>>(new Map());
  // 护眼模式：多档位（暖色纸底 + 页图降蓝/柔光滤镜），本地持久化。无偏好时默认开启（柔光）。
  const [eyeMode, setEyeMode] = useState<EyeMode>(() => {
    const v = localStorage.getItem(EYE_CARE_KEY) as EyeMode | null;
    return v && EYE_MODES.some((m) => m.id === v) ? v : "soft";
  });
  const [eyeOpen, setEyeOpen] = useState(false);
  const eyeWrapRef = useRef<HTMLDivElement | null>(null);
  const [annRecords, setAnnRecords] = useState<PdfAnnotationRecord[]>([]);
  const [focusTarget, setFocusTarget] = useState<{ pageIndex: number; ann: PdfAnnotation } | null>(null);
  // B6 反向同步：侧栏删除后要通知「那一页」把批注从阅读区去掉（页内画布不会自己重载，见
  // PdfAnnotationCanvas 里的 deleteTarget effect）。
  const [deleteTarget, setDeleteTarget] = useState<{ pageIndex: number; annId: string } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [ready, setReady] = useState(false);
  /**
   * 文档加载失败的原因（成功为 null）。
   *
   * 原来这里是空的 `catch { setPageCount(0) }`——于是"这份 PDF 根本没打开"和
   * "正在加载"长得一模一样：舞台一直显示「加载中…」，页码还显示「第 1 / 1 页」
   * （`pageCount || 1`），用户只能报"看不到内容"。失败必须说出来。
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [viewRange, setViewRange] = useState<{ start: number; end: number }>({ start: -1, end: -1 });
  const [pageData, setPageData] = useState<Record<number, PageBlockData>>({});
  const [stageWidth, setStageWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  // 「导出带批注副本」进度 / 取消（60 页扫描版导出耗时，需可取消 + 防假死）。
  const exportAbortRef = useRef<AbortController | null>(null);
  const [exportState, setExportState] = useState<{ status: "idle" | "running"; done: number; total: number }>({ status: "idle", done: 0, total: 0 });
  const [tool, setTool] = useState<AnnotTool>("select");
  // 顶部批注工具栏：作用于当前活动页。版本号在页状态变化时递增，触发工具栏重读状态。
  const [annotToolVersion, setAnnotToolVersion] = useState(0);
  const controllersRef = useRef<Map<number, PdfPageController>>(new Map());

  const engRef = useRef<ReturnType<typeof createPdfjsEngine> | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageCacheRef = useRef<Map<string, string>>(new Map());
  const mountedPagesRef = useRef<Set<number>>(new Set());
  const inflightRef = useRef<Set<string>>(new Set());
  const scrollRafRef = useRef<number | null>(null);
  const zoomWrapRef = useRef<HTMLDivElement | null>(null);
  const zoomCustomRef = useRef<HTMLInputElement | null>(null);
  const resyncedRef = useRef(false);
  const autoFitRef = useRef(false);

  const toggleMax = () => setMaximized((m) => !m);

  // 参考基准页宽/高（用首页 meta，作为所有页共享的显示尺寸基准）。取不到时回退 A4 (612×792)。
  const { refW, refH } = useMemo(() => {
    const m0 = pageData[0]?.meta;
    if (m0?.w && m0?.h) return { refW: m0.w, refH: m0.h };
    for (const d of Object.values(pageData)) if (d.meta?.w && d.meta?.h) return { refW: d.meta.w, refH: d.meta.h };
    return { refW: 612, refH: 792 };
  }, [pageData]);

  // 视口可用宽/高（舞台内容区减去内边距）。
  const availW = Math.max(stageWidth - 24, 40);
  const availH = Math.max(stageHeight - 40, 60);

  // 实际缩放倍率：由缩放模式 + 当前视口解出。适配模式随视口变化自动重算（连续滚动）。
  const scale = useMemo(() => resolveZoomScale(zoom, refW, refH, availW, availH), [zoom, refW, refH, availW, availH]);

  // 内容宽（页块显示宽，px）= 基准页宽 × 缩放。真正随 scale 变化 ⇒ 放大即真实放大。
  const contentWidth = zoomContentWidth(refW, scale);

  // 全部页的前缀和布局（占位高 = chrome 带 + 页面图像高）。用 memo 避免滚动时 O(n) 回算。
  const metas = useMemo(
    () => Array.from({ length: pageCount }, (_, i) => pageData[i]?.meta ?? null),
    [pageCount, pageData],
  );
  const layout = useMemo(() => buildLayout(metas, contentWidth), [metas, contentWidth]);

  // 适配页宽：切换缩放模式到「适合宽度」（随视口自动重算）。
  const fitWidth = () => setZoom({ mode: "fit-width" });
  // 适配整页：同时放下整页宽和高。
  const fitPage = () => setZoom({ mode: "fit-page" });
  // 适配内容：忽略四周留白，比 fit-page 略放大。
  const fitContent = () => setZoom({ mode: "fit-content" });
  // 实际大小：1:1 原始像素。
  const actualSize = () => setZoom({ mode: "actual" });

  // 设置默认缩放比例：把当前缩放存到本地，下次打开 PDF 默认用它（未设置时回到适合宽度）。
  const setDefaultZoom = () => {
    const pct = zoomPct(scale);
    // 具名模式直接存模式名；百分比存数值。
    const saved = zoom.mode === "pct"
      ? { kind: "pct" as const, value: pct }
      : { kind: zoom.mode as "actual" | "fit-page" | "fit-width" | "fit-content", value: 0 };
    try {
      localStorage.setItem("pdf.defaultZoom", JSON.stringify(saved));
      toast("已设为默认缩放比例", "success");
    } catch {
      /* 本地存储不可用则忽略 */
    }
    setZoomOpen(false);
  };

  // 顶部批注工具栏的页句柄注册/注销。注册时若页 index 是当前页，版本 +1 让工具栏刷新。
  const registerController = useCallback((pageIndex: number, ctl: PdfPageController | null) => {
    if (ctl) controllersRef.current.set(pageIndex, ctl);
    else controllersRef.current.delete(pageIndex);
    if (pageIndex === currentPage) setAnnotToolVersion((v) => v + 1);
  }, [currentPage]);

  // 页内批注状态变化（新增/选中/撤销…）→ 版本 +1 刷新顶部工具栏。
  const onAnnotStateChange = useCallback(() => {
    setAnnotToolVersion((v) => v + 1);
  }, []);

  // 当前活动页控制器（顶部工具栏只作用于此页）。
  const curCtl = controllersRef.current.get(currentPage) ?? null;

  // 舞台宽/高监听（最大化 / 侧栏开关 / 窗口缩放改变布局）。
  useEffect(() => {
    if (!ready) return;
    const st = stageRef.current;
    if (!st) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      // 只在值真正变化时才 setState，避免拖动面板时每帧重渲染。
      setStageWidth((prev) => (prev === st.clientWidth ? prev : st.clientWidth));
      setStageHeight((prev) => (prev === st.clientHeight ? prev : st.clientHeight));
    };
    const ro = new ResizeObserver(() => {
      // 面板拖拽期间：暂停舞台尺寸的 React 更新（避免整屏重渲染/缩放重算），松手时由 onDragEnd 应用一次。
      if (isResizingRef.current) return;
      if (!raf) raf = window.requestAnimationFrame(apply);
    });
    ro.observe(st);
    apply();
    return () => { ro.disconnect(); if (raf) window.cancelAnimationFrame(raf); };
  }, [ready]);

  // 首次进入 / 舞台宽就绪且基准页宽到位后：应用默认缩放（未保存过则适合宽度）。
  // 等 pageData[0].meta 拿到（真实基准页宽）才首度应用，避免用 612 回退值没对正。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    if (!pageData[0]?.meta) return;
    if (autoFitRef.current) return;
    autoFitRef.current = true;
    let mode: ZoomMode = { mode: "fit-width" };
    try {
      const raw = localStorage.getItem("pdf.defaultZoom");
      if (raw) {
        const saved = JSON.parse(raw) as { kind: string; value: number };
        if (saved.kind === "pct" && saved.value > 0) mode = { mode: "pct", pct: saved.value };
        else if (["actual", "fit-page", "fit-width", "fit-content"].includes(saved.kind)) {
          mode = { mode: saved.kind as ZoomMode["mode"] } as ZoomMode;
        }
      }
    } catch {
      /* 忽略 */
    }
    setZoom(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData, refW]);

  // 单页 OCR：以给定缩放重渲染本页为 Blob（OCR 用高分辨率，不受当前低清显示图影响）。
  const renderPageForOcr = useCallback((pageIndex: number, scale: number) => {
    const eng = engRef.current;
    if (!eng || !attachmentId) return Promise.reject(new Error("engine not ready"));
    return renderPagePng(eng, attachmentId, pageIndex, scale);
  }, [attachmentId]);

  // 目录/书签跳页。
  const onOutlineJump = (pageIndex: number) => {
    if (pageIndex < 0 || pageIndex >= (pageCount || 1)) return;
    gotoPage(pageIndex);
  };

  // 扫描版无目录：从当前页往后 AI_OUTLINE_PAGES 页逐页 OCR，让 AI 提取章节并生成可跳转目录。
  const generateAiOutline = useCallback(async () => {
    if (aiOutline.status === "running") return;
    const eng = engRef.current;
    if (!eng || !attachmentId || !pageCount) return;
    const config = useAiStore.getState().config;
    if (!config.enabled) {
      toast("请先在设置里配置 AI 模型（本地/云端均可）", "error");
      return;
    }
    const start = Math.min(Math.max(currentPage, 0), Math.max(pageCount - 1, 0));
    const count = aiOutlineCount === -1 ? Math.max(pageCount - start, 1) : aiOutlineCount;
    const total = Math.min(start + count, pageCount) - start;
    if (total <= 0) return;
    const outlineGate = tryConsume("outline");
    if (!outlineGate.ok) {
      toast(outlineGate.message, "error");
      return;
    }
    const ac = new AbortController();
    aiOutlineAbortRef.current = ac;
    setAiOutline({ status: "running", stage: "ocr", done: 0, total });
    try {
      const { items, recognizedPages, totalChars } = await generateOutlineFromVision({
        attachmentId,
        pageCount,
        start,
        count,
        config: config as unknown as ProviderConfig,
        renderPage: (a, i, s) => renderPagePng(eng, a, i, s),
        ocrCache: outlineOcrCacheRef.current,
        onProgress: (p) => setAiOutline({ status: "running", stage: "ocr", done: p.done, total: p.total }),
        onStage: (s) => setAiOutline((prev) => ({ ...prev, status: "running", stage: s })),
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      if (recognizedPages === 0 || totalChars < 5) {
        toast("AI 目录生成未识别到章节标题：请确认已配置支持图像的视觉模型（如 gpt-4o / qwen-vl / llava），或换更靠前的起点", "error");
        setAiOutline({ status: "error", stage: "ai", done: 0, total: 0 });
        return;
      }
      if (items.length === 0) {
        toast(`已识别到部分页面但未提取到目录，可重试或换更靠前的起点`, "error");
        setAiOutline({ status: "error", stage: "ai", done: 0, total: 0 });
        return;
      }
      setOutline(items);
      if (attachmentId) saveAiOutline(attachmentId, items);
      toast(`已生成目录（${items.length} 个项目）`, "success");
      gotoPage(items[0].pageIndex);
      setAiOutline({ status: "done", stage: "ocr", done: total, total });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        toast("已取消目录生成", "success");
      } else {
        toast("AI 生成目录失败，请检查 AI 模型配置/网络", "error");
      }
      setAiOutline({ status: "error", stage: "ocr", done: 0, total: 0 });
    } finally {
      if (aiOutlineAbortRef.current === ac) aiOutlineAbortRef.current = null;
    }
  }, [aiOutline.status, attachmentId, pageCount, currentPage]);

  const cancelAiOutline = useCallback(() => {
    aiOutlineAbortRef.current?.abort();
  }, []);

  // Load all annotation records for this attachment once (for the sidebar).
  useEffect(() => {
    if (!open || !attachmentId) return;
    let alive = true;
    api
      .listPdfAnnotations(attachmentId)
      .then((recs) => { if (alive) setAnnRecords(recs ?? []); })
      .catch(() => { if (alive) setAnnRecords([]); });
    return () => { alive = false; };
  }, [open, attachmentId]);

  // 页内批注被持久化保存后触发：重新拉取批注记录，让右侧批注侧栏及时更新。
  const refreshAnnRecords = useCallback(() => {
    if (!open || !attachmentId) return;
    void api
      .listPdfAnnotations(attachmentId)
      .then((recs) => { setAnnRecords(recs ?? []); })
      .catch(() => {});
  }, [open, attachmentId]);

  // Sidebar click: jump so the target annotation is precisely visible + ask the canvas to focus it.
  const onSidebarJump = (pageIndex: number, ann: PdfAnnotation) => {
    if (pageIndex < 0 || pageIndex >= (pageCount || 1)) return;
    setFocusTarget({ pageIndex, ann });
    focusAnnotation(pageIndex, ann);
  };

  // B6 — 从侧栏删除一条批注（更新 records + 持久化该页）。
  const onSidebarDelete = (pageIndex: number, annId: string) => {
    const rec = annRecords.find((r) => r.page_index === pageIndex);
    if (!rec) return;
    const next = (rec.annotations as PdfAnnotation[]).filter((a) => a.id !== annId);
    if (next.length === rec.annotations.length) return;
    const updated = annRecords.map((r) =>
      r.page_index === pageIndex ? { ...r, annotations: next } : r,
    );
    setAnnRecords(updated);
    // ★ 还必须通知页内画布：它只在 attachmentId/pageIndex 变化时加载自己的 annotations，
    //   少了这一步，侧栏删掉了、阅读区还画着（2026-09-19 缺陷帖 #8）。
    setDeleteTarget({ pageIndex, annId });
    void api.savePdfAnnotations(attachmentId ?? "", pageIndex, next).catch(() => {});
    toast("已删除批注", "success");
  };

  // 导出「带批注的 PDF 副本」：pdf-lib 懒加载（不进主 chunk）；每页用引擎的 PDF-point
  // 尺寸作为页框（保证打印/显示尺寸与源 PDF 一致）；批注一次预取（避免 N+1 IPC）；
  // 逐页渲染 + 让出主线程 + 可取消。不动源文件。
  const handleExportAnnotatedPdf = async () => {
    if (!attachmentId || !engRef.current || !pageCount) return;
    if (exportState.status === "running") return;
    const eng = engRef.current;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportState({ status: "running", done: 0, total: pageCount });
    const base = (name || "PDF").replace(/\.pdf$/i, "");
    try {
      const { exportPdfWithAnnotations } = await import("../lib/pdfAnnotExport");
      // 一次性取回全部页批注，建立 pageIndex -> annotations 的映射。
      const recs = await api.listPdfAnnotations(attachmentId);
      const byPage = new Map<number, PdfAnnotation[]>();
      for (const r of recs) byPage.set(r.page_index, (r.annotations as PdfAnnotation[]) ?? []);
      const blob = await exportPdfWithAnnotations({
        pageCount,
        getPageBox: async (i) => {
          const m = await eng.getPageMeta(i);
          return { w: m.width, h: m.height };
        },
        renderPage: (i, scale) => renderPagePng(eng, attachmentId, i, scale),
        getAnnotations: (i) => byPage.get(i) ?? [],
        signal: controller.signal,
        onProgress: (done, total) => setExportState({ status: "running", done, total }),
      });
      if (platform.pdfRender.nativeAvailable()) {
        // 桌面：弹「另存为」并写二进制；取消则中止（不落盘）。
        const dest = await platform.dialog.save({ defaultPath: `${base}-批注副本.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (!dest) {
          toast("已取消导出", "info");
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await api.writeBinaryFile(dest, Array.from(bytes));
      } else {
        // Web：浏览器下载。
        downloadBlob(blob, `${base}-批注副本.pdf`);
      }
      toast("已导出带批注的 PDF 副本", "success");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") toast("已取消导出", "info");
      else toast("导出带批注副本失败", "error");
    } finally {
      exportAbortRef.current = null;
      setExportState({ status: "idle", done: 0, total: 0 });
    }
  };

  // Load the document once per (open, bytes).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      closeRef.current?.();
      closeRef.current = null;
      setReady(false);
      setPageData({});
      setPageCount(0);
      setMaximized(true);
      setFocusTarget(null);
      // ⚠️ 这里是**每次打开文档都会跑**的复位块——它一度把两栏硬写成 `true`，于是"窄屏默认收起"
      // 被它覆盖掉（真机上第一版就栽在这：`useState(() => !overlayViewport)` 是对的，
      // 打开 PDF 之后两栏又都在 DOM 里）。判据跟着**视口**走，别写死。
      // 故意**不**把 `overlayViewport` 放进依赖数组：那会让旋转/拖窗口触发整个文档重新加载，
      // 代价远大于"这次复位用的是上一个视口值"（而 effect 的闭包在 open/bytes 变化时是新的）。
      setSidebarOpen(!overlayViewport);
      setOutlineOpen(!overlayViewport);
      setOutline([]);
      aiOutlineAbortRef.current?.abort();
      aiOutlineAbortRef.current = null;
      outlineOcrCacheRef.current.clear();
      setAiOutline({ status: "idle", stage: "ocr", done: 0, total: 0 });
      setCurrentPage(0);
      setViewRange({ start: -1, end: -1 });
      setZoomOpen(false);
      setZoom({ mode: "fit-width" });
      setStageWidth(0);
      setStageHeight(0);
      setLoadError(null);
      mountedPagesRef.current.clear();
      resyncedRef.current = false;
      autoFitRef.current = false;
      const cache = pageCacheRef.current;
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
      inflightRef.current.clear();
      const { createPdfjsEngine } = await import("../lib/pdfEngine/pdfjsEngine");
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
          // 用 pdf.js 内置目录；扫描版为空时，恢复本机已生成的 AI 目录（重开不丢失）。
          const builtin = doc.outline ?? [];
          const saved = builtin.length === 0 && attachmentId ? loadAiOutline(attachmentId) : null;
          setOutline(saved && saved.length ? rebuildOutlineTree(saved) : builtin);
          const target = Math.min(Math.max(targetPage, 0), Math.max(doc.pageCount - 1, 0));
          setCurrentPage(target);
          setReady(true);
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.error("loadPdf failed", { attachmentId, bytes: bytes?.length ?? 0, error: e });
        if (alive) {
          setPageCount(0);
          // 把字节数也报出来：文件明明 2MB 而这里显示 0 字节，说明 buffer 已经被
          // "交接"走了（pdf.js 会 transfer 传给它的 buffer）——那是另一类问题，
          // 光看一句 "The object can not be cloned." 是看不出来的。
          setLoadError(`${why}（字节 ${bytes?.length ?? 0}）`);
        }
      }
    })();
    return () => {
      alive = false;
      // On close (open → null) the reader stays mounted but renders null, so the
      // page-image cache + pageData would otherwise survive. Worse, in-flight page
      // renders (viewport effect / launchPageImage) can complete AFTER close and
      // re-populate pageData with a URL that is then revoked on the next open →
      // stale `blob:` URLs → net::ERR_FILE_NOT_FOUND. Clear state AND drop `ready`
      // so the reopened reader never renders a pre-close page image before the
      // fresh-load effect has produced a valid one.
      const cache = pageCacheRef.current;
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
      setReady(false);
      setPageData({});
    };
  }, [open, bytes]);

  // 首次渲染后 / 舞台宽度就绪：把舞台滚到当前页。
  // 依赖 stageWidth —— 初始 stageWidth=0 时页高还是占位值，等 ResizeObserver 报出真实宽再聚焦。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    gotoPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth]);

  // 舞台滚动 → 重算当前页与挂载范围（rAF 节流）。
  const updateViewport = useCallback(() => {
    const st = stageRef.current;
    if (!st) return;
    const vr = computeViewport(st.scrollTop, st.clientHeight, layout);
    setViewRange((prev) =>
      prev.start === vr.start && prev.end === vr.end ? prev : { start: vr.start, end: vr.end },
    );
    setCurrentPage((prev) => (prev === vr.current ? prev : vr.current));
  }, [layout]);

  const onStageScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateViewport();
    });
  }, [updateViewport]);

  // 跳转/滚动时对某页立即光栅化（若当前缩放下未缓存），让页面图像提前就绪，
  // 不等 viewRange 更新后再开始——降低跳去远处页的感知延迟。
  // 直接按当前 scale 渲染一次成型（不再用低清预览：那会导致"从小变大"的视觉跳变）。
  const launchPageImage = useCallback(
    async (pageIndex: number) => {
      const eng = engRef.current;
      if (!eng || !ready) return;
      const key = `${pageIndex}@${scale}`;
      if (pageCacheRef.current.has(key) || inflightRef.current.has(key)) return;
      inflightRef.current.add(key);
      try {
        const blob = await renderPagePng(eng, attachmentId, pageIndex, scale);
        const url = URL.createObjectURL(blob);
        // If the reader was closed while this page was rendering, don't leak a
        // page-image URL into state (it would be revoked on the next open and
        // re-requested → ERR_FILE_NOT_FOUND).
        if (!usePdfReader.getState().open) {
          URL.revokeObjectURL(url);
          return;
        }
        const cache = pageCacheRef.current;
        if (cache.size >= 12) {
          for (const k of [...cache.keys()]) {
            const idx = Number(k.split("@")[0]);
            if (mountedPagesRef.current.has(idx)) continue;
            const old = cache.get(k);
            if (old) URL.revokeObjectURL(old);
            cache.delete(k);
            if (cache.size < 12) break;
          }
        }
        cache.set(key, url);
        setPageData((d) => ({ ...d, [pageIndex]: { ...(d[pageIndex] ?? { meta: null, textItems: null, hasTextLayer: false }), url } }));
      } catch (e) {
        // 不再静默：记进这一页的数据里，页块会把它显示出来（带「重试」）。
        const why = e instanceof Error ? e.message : String(e);
        console.error("renderPagePng failed", { pageIndex, scale, error: e });
        setPageData((d) => ({
          ...d,
          [pageIndex]: {
            ...(d[pageIndex] ?? { meta: null, textItems: null, hasTextLayer: false }),
            error: why,
          },
        }));
      } finally {
        inflightRef.current.delete(key);
      }
    },
    [ready, scale, attachmentId],
  );

  // 滚动到某页：瞬时把该页顶部对齐到滚动容器顶部（目录/侧栏跳到远页——快速到达）。
  const focusPage = useCallback(
    (pageIndex: number) => {
      const st = stageRef.current;
      if (!st) return;
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      // 预取目标页及相邻页的图像，与滚动并行。
      void launchPageImage(clamped);
      if (clamped - 1 >= 0) void launchPageImage(clamped - 1);
      if (clamped + 1 < pageCount) void launchPageImage(clamped + 1);
      st.scrollTop = Math.max(0, layout.tops[clamped] ?? 0);
      updateViewport();
    },
    [layout, updateViewport, pageCount, launchPageImage],
  );

  // 平滑滚动到某页（页面导航箭头/键盘翻页——像滚轮一样丝滑，非瞬跳）。
  const smoothScrollTo = useCallback(
    (pageIndex: number) => {
      const st = stageRef.current;
      if (!st) return;
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      void launchPageImage(clamped);
      if (clamped - 1 >= 0) void launchPageImage(clamped - 1);
      if (clamped + 1 < pageCount) void launchPageImage(clamped + 1);
      st.scrollTo({ top: Math.max(0, layout.tops[clamped] ?? 0), behavior: "smooth" });
    },
    [layout, pageCount, launchPageImage],
  );

  // 精准定位到某条批注：把该标注的垂直中心（页内归一化 y）滚到视口中央，而非只滚到页顶。
  // 连续布局下标注的绝对 Y = 页块顶部 + 页内归一化 y × 页面图像高。瞬时到达（不平滑）保证精准。
  const focusAnnotation = useCallback(
    (pageIndex: number, ann: PdfAnnotation) => {
      const st = stageRef.current;
      if (!st) return;
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      // 预取目标页及相邻页的图像，与滚动并行。
      void launchPageImage(clamped);
      if (clamped - 1 >= 0) void launchPageImage(clamped - 1);
      if (clamped + 1 < pageCount) void launchPageImage(clamped + 1);
      // 用基准页宽高（各页通常同尺寸，来自首个已加载页）算图像高：即使目标页 meta 尚未加载，
      // 用 1.414 回退会因宽高比不同而偏位；基准值已就绪即可精准。
      const imgH = pageImageHeight({ w: refW, h: refH }, contentWidth);
      const absY = (layout.tops[clamped] ?? 0) + annCenterY(ann) * imgH;
      const maxTop = Math.max(0, layout.total - st.clientHeight);
      st.scrollTop = Math.max(0, Math.min(absY - st.clientHeight / 2, maxTop));
      setCurrentPage(clamped);
      updateViewport();
    },
    [layout, contentWidth, refW, refH, pageCount, launchPageImage, updateViewport],
  );

  // 当前滚动位置对应的页（视口中心页）。翻页导航/键盘据此算目标页，避免用滞后的 currentPage。
  const pageAtViewport = useCallback(() => {
    const st = stageRef.current;
    if (!st) return 0;
    return computeViewport(st.scrollTop, st.clientHeight, layout).current;
  }, [layout]);

  const gotoPage = useCallback(
    (pageIndex: number) => {
      const clamped = Math.min(Math.max(pageIndex, 0), Math.max(pageCount - 1, 0));
      setCurrentPage(clamped);
      focusPage(clamped);
    },
    [pageCount, focusPage],
  );

  // 挂载范围变化 → 更新已挂载页集合 + 触发数据加载。
  useEffect(() => {
    if (!ready || viewRange.start < 0) return;
    const mounted = new Set<number>();
    for (let i = viewRange.start; i <= viewRange.end; i++) mounted.add(i);
    mountedPagesRef.current = mounted;
  }, [viewRange, ready]);

  // 首屏：预取全部页的 meta（只是尺寸，秒回、不光栅化）。这样 slotH/pageTop 从第一帧起
  // 就用真实页面高宽比，滚动轴高度稳定，不会在逐页加载时发生布局跳变。
  useEffect(() => {
    if (!ready || pageCount <= 0) return;
    const eng = engRef.current;
    if (!eng) return;
    let alive = true;
    (async () => {
      // 并行拉取，数量大时也很快（仅 getPage + getViewport）。
      const metas = await Promise.all(
        Array.from({ length: pageCount }, (_, i) =>
          eng.getPageMeta(i).then((m) => ({ w: m.width, h: m.height })).catch(() => null),
        ),
      );
      if (!alive) return;
      setPageData((d) => {
        const next = { ...d };
        for (let i = 0; i < metas.length; i++) {
          const m = metas[i];
          if (m) next[i] = { ...(next[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: m };
        }
        return next;
      });
    })();
    return () => { alive = false; };
  }, [ready, pageCount]);

  // 真实页高就绪后，滚动轴上的页位置会重算一次；此时把当前页重新对齐一次（仅一次），
  // 避免首屏按占位比例定位、meta 到达后页面微移。用 ref 标记避免与用户滚动打架。
  useEffect(() => {
    if (!ready || stageWidth <= 0 || pageCount <= 0) return;
    if (resyncedRef.current) return;
    if (!pageData[0]?.meta) return;
    resyncedRef.current = true;
    focusPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stageWidth, pageData]);

  // 加载挂载范围内每页的数据（meta + 图像 + 文本层）。
  // - meta / 文本层：只在缺失时拉取（一次性）。
  // - 图像：以 `${i}@${scale}` 为缓存键，缩放变化后对每个可见页重新光栅化，
  //   否则页面图像停在旧分辨率、放大只会变糊。只对「当前缩放下的缓存 miss」发请求。
  useEffect(() => {
    if (!open || !ready || viewRange.start < 0) return;
    const eng = engRef.current;
    if (!eng) return;
    let alive = true;
    const pages: number[] = [];
    for (let i = viewRange.start; i <= viewRange.end; i++) pages.push(i);

    // 每个可见页：确保有占位数据 + meta（缺失则拉一次）。
    const needMeta = pages.filter((i) => !pageData[i]?.meta);
    for (const i of needMeta) {
      if (!pageData[i]) {
        setPageData((d) => ({ ...d, [i]: { url: null, textItems: null, hasTextLayer: false, meta: null } }));
      }
    }

    (async () => {
      // 1) 并行拉取缺失 meta（尺寸，秒回）。
      if (needMeta.length) {
        const metas = await Promise.all(
          needMeta.map((i) =>
            eng.getPageMeta(i).then((m) => ({ i, w: m.width, h: m.height })).catch(() => ({ i, w: 600, h: 848 })),
          ),
        );
        if (!alive) return;
        setPageData((d) => {
          const next = { ...d };
          for (const { i, w, h } of metas) {
            next[i] = { ...(next[i] ?? { url: null, textItems: null, hasTextLayer: false }), meta: { w, h } };
          }
          return next;
        });
      }

      // 2) 并行拉取每个可见页在当前缩放下的图像（缓存 miss 才拉）。
      const needImg = pages.filter((i) => !pageCacheRef.current.has(`${i}@${scale}`));
      if (needImg.length) {
        await Promise.all(
          needImg.map(async (i) => {
            const key = `${i}@${scale}`;
            if (inflightRef.current.has(key)) return;
            inflightRef.current.add(key);
            let url: string | null = null;
            let failure: string | null = null;
            try {
              const blob = await renderPagePng(eng, attachmentId, i, scale);
              if (!alive) return;
              url = URL.createObjectURL(blob);
              const cache = pageCacheRef.current;
              if (cache.size >= 12) {
                const keys = [...cache.keys()];
                for (const k of keys) {
                  const idx = Number(k.split("@")[0]);
                  if (mountedPagesRef.current.has(idx)) continue;
                  const old = cache.get(k);
                  if (old) URL.revokeObjectURL(old);
                  cache.delete(k);
                  if (cache.size < 12) break;
                }
              }
              cache.set(key, url);
            } catch (e) {
              if (alive) url = null;
              failure = e instanceof Error ? e.message : String(e);
              console.error("renderPagePng failed", { pageIndex: i, scale, error: e });
            } finally {
              inflightRef.current.delete(key);
            }
            if (alive) {
              setPageData((d) => ({
                ...d,
                [i]: { ...(d[i] ?? { meta: null, textItems: null, hasTextLayer: false }), url, error: failure },
              }));
            }
          }),
        );
      }

      // 3) 并行拉取缺失文本层（划词用）。hasTextLayer 由 items 长度推断。
      const needText = pages.filter((i) => pageData[i]?.textItems === undefined || pageData[i]?.textItems === null);
      if (needText.length) {
        await Promise.all(
          needText.map(async (i) => {
            try {
              const items = await eng.getPageTextItems(i);
              if (!alive) return;
              setPageData((d) => ({
                ...d,
                [i]: { ...(d[i] ?? { meta: null, url: null }), textItems: items, hasTextLayer: items.length > 0 },
              }));
            } catch {
              if (!alive) return;
              setPageData((d) => ({ ...d, [i]: { ...(d[i] ?? { meta: null, url: null }), textItems: null } }));
            }
          }),
        );
      }
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewRange, scale, attachmentId, open]);

  // 缩放变化后：页高随之变化，重新校准滚动位置。
  useEffect(() => {
    if (!ready || stageWidth <= 0) return;
    focusPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // 键盘导航：←/→/↑/↓ 滚动，PageUp/PageDown 上下翻页，+/- 缩放，Esc 关闭，F 适配页宽。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 优先关闭缩放下拉；没有下拉时再关闭整篇阅读器。
        setZoomOpen((z) => {
          if (z) return false;
          close();
          return z;
        });
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // PageUp/PageDown：上下翻页（平滑滚动到上一页/下一页顶），阻止浏览器默认整屏滚动。
      if (e.key === "PageDown") {
        e.preventDefault();
        smoothScrollTo(pageAtViewport() + 1);
        return;
      } else if (e.key === "PageUp") {
        e.preventDefault();
        smoothScrollTo(pageAtViewport() - 1);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        // ↑/↓ 完全复刻滚轮：固定小步长（~100px/格，与视口大小无关），平滑逐格累积；←/→ 平滑到上一/下一页顶。
        if (e.key === "ArrowDown") {
          const st = stageRef.current;
          if (st) st.scrollBy({ top: 100, behavior: "smooth" });
        } else {
          smoothScrollTo(pageAtViewport() + 1);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        if (e.key === "ArrowUp") {
          const st = stageRef.current;
          if (st) st.scrollBy({ top: -100, behavior: "smooth" });
        } else {
          smoothScrollTo(pageAtViewport() - 1);
        }
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom(stepZoom(scale, 1));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom(stepZoom(scale, -1));
      } else if ((e.key || "").toLowerCase() === "f") {
        e.preventDefault();
        fitWidth();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageCount, close, currentPage, zoom, scale, smoothScrollTo, pageAtViewport]);

  // 缩放下拉：点击下拉框外部时关闭。
  useEffect(() => {
    if (!zoomOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = zoomWrapRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setZoomOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [zoomOpen]);

  // 护眼档位下拉：点击外部时关闭。
  useEffect(() => {
    if (!eyeOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = eyeWrapRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setEyeOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [eyeOpen]);

  if (!open) return null;

  // 构建挂载页块（绝对定位在累计偏移，宽 = 内容宽）。
  const pageBlocks: React.ReactNode[] = [];
  if (viewRange.start >= 0) {
    for (let i = viewRange.start; i <= viewRange.end; i++) {
      const d = pageData[i];
      pageBlocks.push(
        <div
          className="pdf-continuous-page"
          key={i}
          style={{ position: "absolute", top: layout.tops[i], left: "50%", transform: "translateX(-50%)", width: contentWidth, minHeight: layout.heights[i] }}
        >
          <PdfContinuousPage
            pageIndex={i}
            attachmentId={attachmentId ?? ""}
            width={contentWidth}
            data={d ?? { url: null, textItems: null, hasTextLayer: false, meta: null }}
            focusTarget={focusTarget}
            onFocusConsumed={() => setFocusTarget(null)}
            deleteTarget={deleteTarget}
            onDeleteConsumed={() => setDeleteTarget(null)}
            tool={tool}
            onToolChange={setTool}
            registerController={registerController}
            onStateChange={onAnnotStateChange}
            onChanged={refreshAnnRecords}
            renderPage={renderPageForOcr}
            onRetry={launchPageImage}
          />
        </div>,
      );
    }
  }

  // 浮层模式（窄屏 / 单页窗口）才 portal 到 body：那是一层盖住全屏的浮层，必须跳出
  // 容器的层叠上下文。**内容区模式不能 portal**——portal 会把 DOM 挂到 body 下，
  // CSS 里那条 `.main > .pdf-reader-overlay` 就永远匹配不上，于是"留在内容区里"这件事
  // 只发生在 React 树里、没发生在真实 DOM 里（第一版就是这么错的）。
  // ---------------------------------------------------------------------------
  // 头部工具条的分组（2026-09-22 重排）：每一项都是 `.pdf-reader-head` 的**直接子元素**，
  // 这样"量宽 → 收起"的公式才简单（见上面那个 layout effect），而且收起来的项能在「⋯」
  // 菜单里用**同一份 JSX** 再渲染一遍（不是抄两遍逻辑）。
  //   [目录][文件名][翻页][缩放][分隔线][视图开关组][分隔线][导出][⋯][×]
  // 顺序：nav / zoom 从原来的 `.pdf-reader-controls` 里**提出来**当兄弟节点（那个包裹层
  // 会让"只收缩放、留翻页"这种粒度做不到），间距靠 head 自己的 `gap: 8px`（原值就是 8）。
  // ---------------------------------------------------------------------------
  const headNav = (
    <div className="pdf-reader-nav">
      <button className="pdf-reader-btn" onClick={() => smoothScrollTo(pageAtViewport() - 1)} disabled={pageAtViewport() <= 0} title="上一页">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <span className="pdf-reader-page">
        {pageCount > 0
          ? `第 ${Math.min(currentPage + 1, pageCount)} / ${pageCount} 页`
          : // pageCount=0 时以前会显示"第 1 / 1 页"——那是在替一份打不开的文档
            // 说谎。宁可显示"页数未知"。
            "页数未知"}
      </span>
      <button className="pdf-reader-btn" onClick={() => smoothScrollTo(pageAtViewport() + 1)} disabled={pageAtViewport() >= pageCount - 1} title="下一页">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
  );

  const headZoom = (
    <div className="pdf-reader-zoom">
      <button className="pdf-reader-btn" onClick={() => setZoom(stepZoom(scale, -1))} title="缩小" aria-label="缩小">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/></svg>
      </button>
      <div className="pdf-zoom-wrap" ref={zoomWrapRef}>
        <button
          className="pdf-reader-btn pdf-zoom-btn"
          onClick={() => setZoomOpen((o) => !o)}
          title="缩放"
          aria-haspopup="listbox"
          aria-expanded={zoomOpen}
        >
          <span className="pdf-reader-pct">{zoomLabel(zoom)}</span>
          <svg className="pdf-zoom-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        {zoomOpen && (
          <div className="pdf-zoom-menu" role="listbox">
            <button
              className={`pdf-zoom-item${zoom.mode === "actual" ? " active" : ""}`}
              role="option"
              onClick={() => { actualSize(); setZoomOpen(false); }}
            >
              <span>实际大小</span>
            </button>
            <button
              className={`pdf-zoom-item${zoom.mode === "fit-page" ? " active" : ""}`}
              role="option"
              onClick={() => { fitPage(); setZoomOpen(false); }}
            >
              <span>适合页面</span>
            </button>
            <button
              className={`pdf-zoom-item${zoom.mode === "fit-width" ? " active" : ""}`}
              role="option"
              onClick={() => { fitWidth(); setZoomOpen(false); }}
            >
              <span>适合宽度</span>
            </button>
            <button
              className={`pdf-zoom-item${zoom.mode === "fit-content" ? " active" : ""}`}
              role="option"
              onClick={() => { fitContent(); setZoomOpen(false); }}
            >
              <span>适合内容</span>
            </button>
            <button
              className="pdf-zoom-item"
              role="option"
              onClick={() => { zoomCustomRef.current?.focus(); }}
            >
              <span>自定义缩放</span>
            </button>
            <div className="pdf-zoom-sep" />
            {ZOOM_LADDER.map((p) => {
              const isCur = zoom.mode === "pct" && Math.abs(zoomPct(scale) - p) < 0.5;
              return (
                <button
                  key={p}
                  className={`pdf-zoom-item${isCur ? " active" : ""}`}
                  role="option"
                  onClick={() => { setZoom({ mode: "pct", pct: p }); setZoomOpen(false); }}
                >
                  <span className="pdf-zoom-item-check">{isCur ? "✓" : ""}</span>
                  <span className="pdf-zoom-item-label">{Number.isInteger(p) ? p : +p.toFixed(2)}%</span>
                </button>
              );
            })}
            <div className="pdf-zoom-sep" />
            <button className="pdf-zoom-item pdf-zoom-footer" role="option" onClick={setDefaultZoom}>
              <span>设置默认缩放比例</span>
            </button>
            <input
              ref={zoomCustomRef}
              className="pdf-zoom-custom"
              type="number"
              min={1}
              step="any"
              placeholder="自定义 %"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = parseFloat(e.currentTarget.value);
                  if (!Number.isNaN(v) && v > 0) { setZoom({ mode: "pct", pct: v }); setZoomOpen(false); }
                }
                e.stopPropagation();
              }}
              onBlur={(e) => {
                const v = parseFloat(e.currentTarget.value);
                if (!Number.isNaN(v) && v > 0) { setZoom({ mode: "pct", pct: v }); setZoomOpen(false); }
              }}
            />
          </div>
        )}
      </div>
      <button className="pdf-reader-btn" onClick={() => setZoom(stepZoom(scale, 1))} title="放大" aria-label="放大">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  );

  /** 视图开关组：最大化 / 批注侧栏 / 提问 / 护眼（最先被收进「⋯」的一组）。 */
  const headTail = (
    <div className="pdf-head-tail">
      {!inline && (
        <button className="pdf-reader-btn pdf-reader-maximize" onClick={toggleMax} title={maximized ? "还原窗口" : "最大化窗口"}>
          {maximized ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4h12v12M4 8l16-4"/></svg>
          )}
        </button>
      )}
      <button className="pdf-reader-btn pdf-reader-sidebar-toggle" onClick={() => setSidebarOpen((s) => !s)} title={sidebarOpen ? "隐藏批注侧栏" : "显示批注侧栏"} aria-pressed={sidebarOpen}>
        {sidebarOpen ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
        )}
      </button>
      <button className="pdf-reader-btn pdf-reader-ask" onClick={() => setAskOpen((s) => !s)} title={askOpen ? "隐藏提问栏" : "对这篇 PDF 提问"} aria-pressed={askOpen}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
      </button>
      <div className="pdf-eye-wrap" ref={eyeWrapRef}>
        <button
          className={`pdf-reader-btn${eyeMode !== "off" ? " active" : ""}`}
          onClick={() => setEyeOpen((o) => !o)}
          title={`护眼模式：${EYE_MODES.find((m) => m.id === eyeMode)?.label ?? "关闭"}`}
          aria-haspopup="listbox"
          aria-expanded={eyeOpen}
          aria-pressed={eyeMode !== "off"}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7z"/><circle cx="12" cy="12" r="2.6"/></svg>
        </button>
        {eyeOpen && (
          <div className="pdf-eye-menu" role="listbox">
            {EYE_MODES.map((m) => (
              <button
                key={m.id}
                className={`pdf-eye-item${eyeMode === m.id ? " active" : ""}`}
                role="option"
                onClick={() => {
                  setEyeMode(m.id);
                  try { localStorage.setItem(EYE_CARE_KEY, m.id); } catch {}
                  setEyeOpen(false);
                }}
              >
                <span className="pdf-eye-item-check">{eyeMode === m.id ? "✓" : ""}</span>
                <span className="pdf-eye-item-label">{m.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  /** 导出（图标按钮）+ 导出中的「取消」。 */
  const headExport = (
    <div className="pdf-head-export">
      <button
        className="pdf-reader-btn pdf-export-btn"
        onClick={() => void handleExportAnnotatedPdf()}
        disabled={!ready || pageCount <= 0 || exportState.status === "running"}
        title={
          exportState.status === "running"
            ? `正在导出带批注的 PDF 副本：${exportState.done}/${exportState.total} 页`
            : "导出为带批注的 PDF 副本（不动源文件）"
        }
        aria-label="导出带批注副本"
      >
        {exportState.status === "running" ? (
          <span className="pdf-export-progress">
            {exportState.done}/{exportState.total}
          </span>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {/* 「带批注的副本」= 文档 + 向下导出箭头 */}
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 11.5v5.5" />
            <path d="M9.6 14.6 12 17l2.4-2.4" />
          </svg>
        )}
      </button>
      {exportState.status === "running" && (
        <button className="pdf-reader-btn pdf-export-btn" onClick={() => exportAbortRef.current?.abort()} title="取消导出">
          取消
        </button>
      )}
    </div>
  );

  const tree = (
    <div
      className="pdf-reader-overlay"
      // 浮层模式下点空白关闭；inline 模式下它就是内容区（铺满），没有"空白"可点。
      onMouseDown={(e) => {
        if (!inline && e.target === e.currentTarget) close();
      }}
    >
      <div className={`pdf-reader${maximized ? " maximized" : ""}${eyeMode !== "off" ? ` eye-${eyeMode}` : ""}`}>
        {/* 标题区整体可拖窗口（配合 dragDropEnabled=false）。按钮/控件不挂在
            drag-region 上，否则点击会被当成拖窗口——与主窗口 TitleBar 一致。

            ⚠️ 2026-09-22（owner："pdf 阅读器顶部系统工具栏任何时候不换行，空间狭小时收起来，
            除了最右端的关闭按钮"）：这一行**任何时候都不换行**，放不下的项由上面的量宽 effect
            写进 `data-collapse`、收进「⋯」；**关闭按钮永不收**（它是"离开"的唯一入口，
            所以它排在最后 + `margin-left:auto` 顶到最右端）。 */}
        <div
          className={`pdf-reader-head${headHidden.length ? " has-more" : ""}`}
          data-collapse={headHidden.join(" ")}
          ref={headRef}
          data-tauri-drag-region
        >
          <button className="pdf-reader-btn pdf-reader-outline-toggle" onClick={() => setOutlineOpen((s) => !s)} title={outlineOpen ? "隐藏目录" : "显示目录"} aria-pressed={outlineOpen}>
            {outlineOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            )}
          </button>
          <span className="pdf-reader-name" data-tauri-drag-region title={name || "PDF"}>{name || "PDF"}</span>
          {headNav}
          {headZoom}
          {/* 分组分隔线：左边是"翻页 / 缩放"，右边是"面板 / 视图"（窄屏隐藏）。 */}
          <span className="pdf-reader-sep" aria-hidden />
          {headTail}
          {/* 分隔线：把"面板 / 视图"与"导出"分开（窄屏隐藏）。 */}
          <span className="pdf-reader-sep" aria-hidden />
          {headExport}
          {/* 「⋯」：**放不下时才出现**（`has-more` 由量宽结果决定）；菜单里是收起来的那几项。 */}
          <div className="pdf-head-more-wrap" ref={headMoreRef}>
            <button
              className={`pdf-reader-btn pdf-reader-more${headMenuOpen ? " active" : ""}`}
              onClick={() => setHeadMenuOpen((v) => !v)}
              title="更多工具（放不下的收在这里）"
              aria-label="更多工具"
              aria-expanded={headMenuOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {/* ⚠️ 菜单里的这几件是同一份 JSX 的第二份调用（收起来的那几项在这里仍可点到）。
                它必须留在 head 的直接子元素**之外**：量宽时按 `:scope > 选择器` 找的是行内那一份。 */}
            {headMenuOpen && (
              <div className="pdf-head-more-pop" role="group" aria-label="更多工具">
                {headHiddenSet.has("outline") && (
                  <div className="pdf-head-more-row">
                    <button className="pdf-reader-btn" onClick={() => setOutlineOpen((s) => !s)} title={outlineOpen ? "隐藏目录" : "显示目录"} aria-pressed={outlineOpen}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                      <span className="pdf-head-more-label">{outlineOpen ? "隐藏目录" : "显示目录"}</span>
                    </button>
                  </div>
                )}
                {headHiddenSet.has("nav") && <div className="pdf-head-more-row">{headNav}</div>}
                {headHiddenSet.has("zoom") && <div className="pdf-head-more-row">{headZoom}</div>}
                {headHiddenSet.has("tail") && <div className="pdf-head-more-row">{headTail}</div>}
                {headHiddenSet.has("export") && <div className="pdf-head-more-row">{headExport}</div>}
              </div>
            )}
          </div>
          <button className="pdf-reader-close" onClick={close} title="关闭">×</button>
        </div>
        <div className="pdf-reader-body">
          {ready && pageCount > 0 ? (
            <div className={`pdf-reader-layout${sidebarOpen ? " has-sidebar" : ""}${outlineOpen ? " has-outline" : ""}`}>
              {/* 面板收起时的"拖出来"边缘手柄（桌面形态；抽屉形态下有开关按钮，不需要）。
                  拖动 ⇒ 打开并跟手定宽；拖不够 ⇒ 不动；双击 ⇒ 默认宽度打开。 */}
              {!overlayViewport && !outlineOpen && (
                <div
                  className="pdf-edge-drag is-left"
                  onPointerDown={onOutlineExpandStart}
                  title="向右拖动展开目录（双击恢复默认宽度）"
                />
              )}
              {!overlayViewport && !sidebarOpen && (
                <div
                  className="pdf-edge-drag is-right"
                  onPointerDown={onSidebarExpandStart}
                  title="向左拖动展开批注侧栏（双击恢复默认宽度）"
                />
              )}
              {outlineOpen && (
                <div
                  className="pdf-outline-col"
                  ref={outlineColRef}
                  // 抽屉形态下**不写内联宽度**：宽度由窄屏那段 CSS 定（min(300px, 86vw)），
                  // 内联样式优先级更高，写了就把抽屉顶成 240px 的列。
                  style={overlayViewport ? { flexShrink: 0 } : { width: outlineWidth, flexShrink: 0 }}
                >
                  <PdfOutline outline={outline} currentPage={currentPage} onJump={onOutlineJump} onAiGenerate={generateAiOutline} onAiCancel={cancelAiOutline} aiBusy={aiOutline.status === "running"} aiStage={aiOutline.stage} aiProgress={aiOutline.status === "running" ? { done: aiOutline.done, total: aiOutline.total } : null} aiCount={aiOutlineCount} aiCustom={aiOutlineCustom} onAiCountChange={setAiOutlineCount} onAiCustomChange={setAiOutlineCustom} />
                  <div className="pdf-outline-resizer" onPointerDown={onOutlineResizeStart} title="拖拽调整目录宽度" />
                </div>
              )}
              <div className="pdf-reader-stage-wrap">
                <PdfAnnotTopToolbar
                  ctl={curCtl}
                  version={annotToolVersion}
                  tool={tool}
                  onToolChange={setTool}
                  // 宽度不够时由工具条自己把「文本层 chip + 朗读/OCR/AI」收进它那枚「⋯」
                  // （2026-09-22：不再靠这里传 showStatus 猜 —— 见 PdfAnnotTopToolbar 顶部注释）。
                />
                <div className="pdf-reader-stage" ref={stageRef} onScroll={onStageScroll}>
                  <div className="pdf-continuous" style={{ height: layout.total, position: "relative" }}>
                    {pageBlocks.length ? (
                      pageBlocks
                    ) : (
                      <div className="pdf-reader-loading">加载中…</div>
                    )}
                  </div>
                </div>
              </div>
              {sidebarOpen && (
                <div
                  className="pdf-sidebar-col"
                  ref={sidebarColRef}
                  style={overlayViewport ? { flexShrink: 0 } : { width: sidebarWidth, flexShrink: 0 }}
                >
                  <PdfSidebar
                    records={annRecords}
                    currentPage={currentPage}
                    onJump={onSidebarJump}
                    onDelete={onSidebarDelete}
                  />
                  <div className="pdf-sidebar-resizer" onPointerDown={onSidebarResizeStart} title="拖拽调整批注侧栏宽度" />
                </div>
              )}
            </div>
          ) : loadError ? (
            <div className="pdf-page-error" style={{ margin: "24px auto", maxWidth: 520 }}>
              <div className="pdf-page-error-title">这份 PDF 没能打开</div>
              <div className="pdf-page-error-why">{loadError}</div>
              <button
                className="pdf-page-error-retry"
                onClick={() => {
                  // 重新加载同一份字节：先关掉（触发清理）再重开。
                  const id = attachmentId;
                  const nm = name;
                  if (!id) return;
                  close();
                  setTimeout(() => void usePdfReader.getState().openPdf(id, nm), 0);
                }}
              >
                重新打开
              </button>
            </div>
          ) : (
            <div className="pdf-reader-loading">加载中…</div>
          )}
        </div>
        {askOpen && (
          <div className="pdf-reader-askbar">
            <PdfAskBar
              attachmentId={attachmentId ?? ""}
              pageCount={pageCount || 1}
              getEngine={() => engRef.current}
              onDone={close}
            />
          </div>
        )}
      </div>
    </div>
  );
  return inline ? tree : createPortal(tree, document.body);
}
