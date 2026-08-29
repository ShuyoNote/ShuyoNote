import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePdfReader } from "../store/pdfReader";
import { useAiStore } from "../store/ai";
import { createPdfjsEngine } from "../lib/pdfEngine/pdfjsEngine";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { PdfAnnotation } from "../lib/pdfAnnotation";
import type { OutlineItem } from "../lib/pdfRender";
import type { TextItemLike } from "../lib/pdfTextLayer";
import type { PdfAnnotationRecord } from "../types";
import { generateOutlineFromOcr } from "../lib/aiOutline";
import type { ProviderConfig } from "../lib/ai/llm";
import { buildLayout, computeViewport, annCenterY, pageImageHeight, resolveZoomScale, stepZoom, zoomContentWidth, zoomLabel, zoomPct, ZOOM_LADDER, type ZoomMode } from "../lib/pdfLayout";
import { PdfAnnotationCanvas } from "./PdfAnnotationCanvas";
import { PdfAnnotTopToolbar } from "./PdfAnnotTopToolbar";
import type { AnnotTool, PdfPageController } from "./pdfAnnotController";
import { PdfSidebar } from "./PdfSidebar";
import { PdfOutline } from "./PdfOutline";
import { PdfAskBar } from "./PdfAskBar";

/** 「AI 生成目录（本段）」默认向后生成的页数。 */
const AI_OUTLINE_PAGES = 60;

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
    const { bytes, width, height } = await platform.pdfRender.renderPdfPage(attachmentId, pageIndex, scale);
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
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出页面失败"))), "image/jpeg", 0.92),
    );
  }
  return eng.renderPageToBlob(pageIndex, scale);
}

// 单页块数据（懒加载，视口内才拉取）。
interface PageBlockData {
  url: string | null;
  textItems: TextItemLike[] | null;
  hasTextLayer: boolean;
  meta: { w: number; h: number } | null;
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
  tool,
  onToolChange,
  registerController,
  onStateChange,
  onChanged,
}: {
  pageIndex: number;
  attachmentId: string;
  data: PageBlockData;
  width: number;
  focusTarget: { pageIndex: number; ann: PdfAnnotation } | null;
  onFocusConsumed: () => void;
  tool: AnnotTool;
  onToolChange: (t: AnnotTool) => void;
  registerController: (pageIndex: number, ctl: PdfPageController | null) => void;
  onStateChange: () => void;
  onChanged: () => void;
}) {
  const { url, textItems, hasTextLayer, meta } = data;
  if (!meta) {
    return <div className="pdf-annot-placeholder" style={{ width }}>第 {pageIndex + 1} 页…</div>;
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
      tool={tool}
      onToolChange={onToolChange}
      registerController={registerController}
      onStateChange={onStateChange}
      onChanged={onChanged}
    />
  );
}

// M24 — PDF reader modal. 方案 B：虚拟化连续滚动。文档以「页块栈」纵向排布：
// 每个页块绝对定位在累计偏移处（占位高 = 固定 chrome 带 + 页面图像高，宽统一为内容宽），
// 舞台只挂载视口 ± 缓冲的页块，其余页只占位（不渲染），保持整段可滚且不叠盖。
export function PdfReader() {
  const { open, attachmentId, name, bytes, targetPage, close } = usePdfReader();
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState<ZoomMode>({ mode: "fit-width" });
  const [maximized, setMaximized] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // 「AI 生成目录（本段）」进行态（进度/阶段/取消）。扫描版无目录时才显示入口。
  const [aiOutline, setAiOutline] = useState<{ status: "idle" | "running" | "done" | "error"; stage: "ocr" | "ai"; done: number; total: number }>({ status: "idle", stage: "ocr", done: 0, total: 0 });
  const aiOutlineAbortRef = useRef<AbortController | null>(null);
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
  const [askOpen, setAskOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [viewRange, setViewRange] = useState<{ start: number; end: number }>({ start: -1, end: -1 });
  const [pageData, setPageData] = useState<Record<number, PageBlockData>>({});
  const [stageWidth, setStageWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
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
    const ro = new ResizeObserver(() => {
      setStageWidth(st.clientWidth);
      setStageHeight(st.clientHeight);
    });
    ro.observe(st);
    setStageWidth(st.clientWidth);
    setStageHeight(st.clientHeight);
    return () => ro.disconnect();
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
    const total = Math.min(start + AI_OUTLINE_PAGES, pageCount) - start;
    if (total <= 0) return;
    const ac = new AbortController();
    aiOutlineAbortRef.current = ac;
    setAiOutline({ status: "running", stage: "ocr", done: 0, total });
    try {
      const { items, recognizedPages, totalChars } = await generateOutlineFromOcr({
        attachmentId,
        pageCount,
        start,
        count: AI_OUTLINE_PAGES,
        config: config as unknown as ProviderConfig,
        renderPage: (a, i, s) => renderPagePng(eng, a, i, s),
        ocrCache: outlineOcrCacheRef.current,
        onProgress: (p) => setAiOutline({ status: "running", stage: "ocr", done: p.done, total: p.total }),
        onStage: (s) => setAiOutline((prev) => ({ ...prev, status: "running", stage: s })),
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      if (recognizedPages === 0 || totalChars < 20) {
        toast("未识别到有效文字：请确认离线 OCR 模型已就绪，或该页确为图片型扫描页", "error");
        setAiOutline({ status: "error", stage: "ocr", done: 0, total: 0 });
        return;
      }
      if (items.length === 0) {
        toast(`已识别 ${recognizedPages} 页文字，但 AI 未提取到目录，可重试或换更靠前的起点`, "error");
        setAiOutline({ status: "error", stage: "ocr", done: 0, total: 0 });
        return;
      }
      setOutline(items);
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
    void api.savePdfAnnotations(attachmentId ?? "", pageIndex, next).catch(() => {});
    toast("已删除批注", "success");
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
      setSidebarOpen(true);
      setOutlineOpen(true);
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
      mountedPagesRef.current.clear();
      resyncedRef.current = false;
      autoFitRef.current = false;
      const cache = pageCacheRef.current;
      for (const u of cache.values()) URL.revokeObjectURL(u);
      cache.clear();
      inflightRef.current.clear();
      const eng = createPdfjsEngine();
      engRef.current = eng;
      if (!bytes) return;
      try {
        const doc = await eng.loadPdf(bytes);
        if (alive) {
          closeRef.current = doc.close;
          setPageCount(doc.pageCount);
          setOutline(doc.outline ?? []);
          const target = Math.min(Math.max(targetPage, 0), Math.max(doc.pageCount - 1, 0));
          setCurrentPage(target);
          setReady(true);
        }
      } catch {
        if (alive) setPageCount(0);
      }
    })();
    return () => {
      alive = false;
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
      } catch {
        // 忽略：图像加载失败不影响跳转。
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
    if (!ready || viewRange.start < 0) return;
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
            } catch {
              if (alive) url = null;
            } finally {
              inflightRef.current.delete(key);
            }
            if (alive) {
              setPageData((d) => ({
                ...d,
                [i]: { ...(d[i] ?? { meta: null, textItems: null, hasTextLayer: false }), url },
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
  }, [ready, viewRange, scale, attachmentId]);

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
      } else if (e.key.toLowerCase() === "f") {
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
            tool={tool}
            onToolChange={setTool}
            registerController={registerController}
            onStateChange={onAnnotStateChange}
            onChanged={refreshAnnRecords}
          />
        </div>,
      );
    }
  }

  return createPortal(
    <div className="pdf-reader-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`pdf-reader${maximized ? " maximized" : ""}${eyeMode !== "off" ? ` eye-${eyeMode}` : ""}`}>
        <div className="pdf-reader-head">
          <button className="pdf-reader-btn pdf-reader-outline-toggle" onClick={() => setOutlineOpen((s) => !s)} title={outlineOpen ? "隐藏目录" : "显示目录"} aria-pressed={outlineOpen} style={{ marginRight: 6 }}>
            {outlineOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            )}
          </button>
          <span className="pdf-reader-name" title={name || "PDF"}>{name || "PDF"}</span>
          <div className="pdf-reader-controls">
            <div className="pdf-reader-nav">
              <button className="pdf-reader-btn" onClick={() => smoothScrollTo(pageAtViewport() - 1)} disabled={pageAtViewport() <= 0} title="上一页">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <span className="pdf-reader-page">第 {Math.min(currentPage + 1, pageCount || 1)} / {pageCount || 1} 页</span>
              <button className="pdf-reader-btn" onClick={() => smoothScrollTo(pageAtViewport() + 1)} disabled={pageAtViewport() >= pageCount - 1} title="下一页">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
              </button>
            </div>
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
            <button className="pdf-reader-btn" onClick={toggleMax} title={maximized ? "还原窗口" : "最大化窗口"}>
              {maximized ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4h12v12M4 8l16-4"/></svg>
              )}
            </button>
            <button className="pdf-reader-btn" onClick={() => setSidebarOpen((s) => !s)} title={sidebarOpen ? "隐藏批注侧栏" : "显示批注侧栏"} aria-pressed={sidebarOpen}>
              {sidebarOpen ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
              )}
            </button>
            <button className="pdf-reader-btn" onClick={() => setAskOpen((s) => !s)} title={askOpen ? "隐藏提问栏" : "对这篇 PDF 提问"} aria-pressed={askOpen}>
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
          <button className="pdf-reader-close" onClick={close} title="关闭">×</button>
        </div>
        <div className="pdf-reader-body">
          {ready && pageCount > 0 ? (
            <div className={`pdf-reader-layout${sidebarOpen ? " has-sidebar" : ""}${outlineOpen ? " has-outline" : ""}`}>
              {outlineOpen && (
                <PdfOutline outline={outline} currentPage={currentPage} onJump={onOutlineJump} onAiGenerate={generateAiOutline} onAiCancel={cancelAiOutline} aiBusy={aiOutline.status === "running"} aiStage={aiOutline.stage} aiProgress={aiOutline.status === "running" ? { done: aiOutline.done, total: aiOutline.total } : null} />
              )}
              <div className="pdf-reader-stage-wrap">
                <PdfAnnotTopToolbar
                  ctl={curCtl}
                  version={annotToolVersion}
                  tool={tool}
                  onToolChange={setTool}
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
                <PdfSidebar
                  records={annRecords}
                  currentPage={currentPage}
                  onJump={onSidebarJump}
                  onDelete={onSidebarDelete}
                />
              )}
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
    </div>,
    document.body,
  );
}
