import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restore, exportToBlob, exportToSvg, exportToClipboard, CaptureUpdateAction } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { useResolvedTheme } from "../store/theme";
import { blobStore } from "../lib/platform/blobStore";
import { toast } from "../store/toast";
import { $isDrawingNode, type DrawingNode } from "../editor/nodes/DrawingNode";

interface SceneSnapshot {
  elements: any[];
  appState: any;
  files: any;
}

const DEFAULT_HEIGHT = 420;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 4000;

// The drawing DecoratorNode can remount on unrelated editor commits. Cache the
// parsed/restored scene by blob-hash so a remount restores instantly instead of
// re-fetching the blob and flashing "加载绘图…" (which is the visible jitter).
const sceneCache = new Map<string, SceneSnapshot>();
// NOTE: there is intentionally no separate viewport cache. A fullscreen
// edit-and-save clears the node's zoom/scroll so the embed re-fits on reload; the
// only authoritative "skip the fit" signal is a view persisted ON THE NODE itself.

// Stable UIOptions object — a fresh object on every render would make the
// memoized Excalidraw re-render (and repaint the canvas), causing page jitter.
const INLINE_UI_OPTIONS = { canvasActions: { export: false } } as const;

// `Excalidraw` is memory/render heavy; a DecoratorNode re-renders on every editor
// state change (e.g. typing anywhere in the page), which would otherwise repaint
// the whole canvas and make pages with drawings jitter. Memoize it on stable,
// rarely-changing props (scene, view/theme booleans, stable callbacks) so unrelated
// editor updates don't touch it.
const InlineExcalidraw = memo(function InlineExcalidraw({
  initialData,
  viewMode,
  isDark,
  onChange,
  onApi,
}: {
  initialData: SceneSnapshot;
  viewMode: boolean;
  isDark: boolean;
  onChange: (elements: any, appState: any, files: any) => void;
  onApi: (api: any) => void;
}) {
  return (
    <Excalidraw
      onChange={onChange}
      initialData={initialData}
      excalidrawAPI={onApi}
      viewModeEnabled={viewMode}
      theme={isDark ? "dark" : "light"}
      UIOptions={INLINE_UI_OPTIONS}
      langCode="zh-CN"
    />
  );
});

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Magnifier-style zoom in/out icons (lens + handle + +/−), matching the drawing
// block's zoom control affordance.
function ZoomInIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="16.4" y1="16.4" x2="21" y2="21" />
      <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
      <line x1="10.5" y1="7.5" x2="10.5" y2="13.5" />
    </svg>
  );
}

function ZoomOutIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="16.4" y1="16.4" x2="21" y2="21" />
      <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    </svg>
  );
}

export function InlineDrawing({ node }: { node: DrawingNode }) {
  const apiRef = useRef<any>(null);
  // The DecoratorNode is replaced (via getWritable()) when a save updates the blob
  // hash / height, so `node` is a NEW object each time. Callbacks created with
  // useCallback close over the FIRST `node`; keeping a ref that always points at the
  // CURRENT node lets fit/view logic read fresh data (hash, height, zoom) after a
  // fullscreen edit-and-save — otherwise the embed restores the old scene / height.
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const liveRef = useRef<SceneSnapshot | null>(null);
  // `initialData` is set once and never mutated; Excalidraw re-initializes loops if it changes.
  const [initialData, setInitialData] = useState<SceneSnapshot | null>(null);
  // `initialData` is the AUTHORITATIVE loaded scene. `liveRef` is also written by the
  // `onChange` callback, which Excalidraw can fire with a transient/partial scene
  // (e.g. an empty one) during mount — so fit/size must read the loaded scene, not
  // whatever `onChange` last reported, or the fit would no-op on a momentary empty
  // scene and the embed would come back un-fitted after a fullscreen save.
  const initialDataRef = useRef<SceneSnapshot | null>(null);
  initialDataRef.current = initialData;
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(node.__height ?? DEFAULT_HEIGHT);
  const heightRef = useRef<number>(height);
  const isDark = useResolvedTheme() === "dark";
  const savedViewRef = useRef(false);
  const viewTimerRef = useRef<number | null>(null);
  const lastViewRef = useRef({ zoom: node.__zoom, scrollX: node.__scrollX, scrollY: node.__scrollY });
  const [zoomPct, setZoomPct] = useState(100);

  const hash = node.__hash;

  // Load the saved scene whenever the node's blob hash changes.
  useEffect(() => {
    let alive = true;
    setErr(null);
    // Sync resize height to the node's persisted value.
    const nextH = node.__height ?? DEFAULT_HEIGHT;
    heightRef.current = nextH;
    setHeight(nextH);
    // Remember whether a viewport (zoom/scroll) was previously saved so we restore
    // it instead of re-fitting to content. Only finite values count (a transient
    // NaN must not be persisted, or the view would lock into broken zoom).
    const fin = (v: number | null | undefined): v is number => typeof v === "number" && isFinite(v);
    // A "saved view" only counts if it's NON-DEFAULT. Excalidraw reports a default
    // zoom=1 / scroll=0 on mount, and persistView can write that back onto the node
    // before our fit runs — treating it as a user view would mark savedViewRef=true
    // and skip the auto-fit after a fullscreen edit-and-save (leaving the embed
    // un-scaled/un-centered). Only a view the user actually changed (non-default)
    // should suppress the fit.
    const isDefaultView = (() => {
      const z = fin(node.__zoom) ? node.__zoom : null;
      const sx = fin(node.__scrollX) ? node.__scrollX : null;
      const sy = fin(node.__scrollY) ? node.__scrollY : null;
      return (z == null || z === 1) && (sx == null || sx === 0) && (sy == null || sy === 0);
    })();
    let hasSavedView = !isDefaultView && (fin(node.__zoom) || fin(node.__scrollX) || fin(node.__scrollY));
    savedViewRef.current = hasSavedView;
    let savedView: Record<string, unknown> = hasSavedView
      ? {
          ...(fin(node.__zoom) ? { zoom: { value: node.__zoom! } } : {}),
          ...(fin(node.__scrollX) ? { scrollX: node.__scrollX! } : {}),
          ...(fin(node.__scrollY) ? { scrollY: node.__scrollY! } : {}),
        }
      : {};
    // If the scene is already cached (e.g. this block just remounted), restore it
    // synchronously so the reader never flashes "加载绘图…".
    const cached = sceneCache.get(hash ?? "");
    if (cached) {
      const scene: SceneSnapshot = { elements: cached.elements, appState: { ...cached.appState, ...savedView }, files: cached.files };
      liveRef.current = scene;
      setInitialData(scene);
      setReady(true);
      return () => {
        alive = false;
      };
    }
    setReady(false);
    const load = async () => {
      // Grid is off by default; a fresh inline drawing shows a clean canvas.
      let base: SceneSnapshot = { elements: [], appState: { gridModeEnabled: false }, files: {} };
      if (hash) {
        try {
          const bytes = await blobStore.get(hash);
          if (bytes) {
            const parsed = JSON.parse(new TextDecoder().decode(bytes) || "{}");
            const elems = Array.isArray(parsed?.elements) ? parsed.elements : [];
            const restored = await restore(
              { elements: elems, appState: parsed?.appState ?? {}, files: parsed?.files ?? {} },
              null,
              null,
            );
            base = { elements: restored.elements, appState: { ...restored.appState, gridModeEnabled: false }, files: restored.files };
          }
        } catch (e) {
          if (alive) setErr(String(e));
        }
      } else {
        // No blob hash (a brand-new empty block): if a scene is already loaded (e.g.
        // a fullscreen save just replaced the node and the reader re-rendered with a
        // transient empty hash), keep the existing content instead of blanking it.
        const existing = liveRef.current;
        if (existing && Array.isArray(existing.elements) && existing.elements.length > 0) {
          if (alive) {
            setInitialData(existing);
            setReady(true);
          }
          return;
        }
      }
      sceneCache.set(hash ?? "", base);
      const scene: SceneSnapshot = { elements: base.elements, appState: { ...base.appState, ...savedView }, files: base.files };
      if (alive) {
        liveRef.current = scene;
        setInitialData(scene);
        setReady(true);
      }
    };
    load();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  // Persist the read-only viewport (zoom/scroll) onto the drawing node so the
  // block reopens as the user left it (auto-save after pan/zoom).
  const persistView = useCallback(
    (appState: any) => {
      const zRaw = appState?.zoom;
      const z = typeof zRaw === "number" ? zRaw : zRaw?.value;
      const sx = appState?.scrollX;
      const sy = appState?.scrollY;
      if (typeof z !== "number" && typeof sx !== "number" && typeof sy !== "number") return;
      const zF = typeof z === "number" && isFinite(z) ? z : null;
      const sxF = typeof sx === "number" && isFinite(sx) ? sx : null;
      const syF = typeof sy === "number" && isFinite(sy) ? sy : null;
      if (zF === null && sxF === null && syF === null) return;
      // Only persist when something actually changed: writing the same zoom/scroll
      // back onto the node marks it dirty → triggers a page save → Excalidraw
      // fires onChange again → saves again → the page is stuck at "保存中…".
      const lv = lastViewRef.current;
      if (lv.zoom === zF && lv.scrollX === sxF && lv.scrollY === syF) return;
      lastViewRef.current = { zoom: zF, scrollX: sxF, scrollY: syF };
      const editor = useEditorStore.getState().editor;
      if (!editor) return;
      editor.update(() => {
        const n = $getNodeByKey(node.getKey());
        if (n && $isDrawingNode(n)) {
          n.setDrawing({
            zoom: zF,
            scrollX: sxF,
            scrollY: syF,
          });
        }
      });
    },
    [node],
  );

  // Debounced persist of the viewport, so pan/zoom doesn't spam saves.
  const scheduleViewSave = useCallback(
    (appState: any) => {
      if (viewTimerRef.current !== null) window.clearTimeout(viewTimerRef.current);
      viewTimerRef.current = window.setTimeout(() => persistView(appState), 400);
    },
    [persistView],
  );

  const onChange = useCallback(
    (elements: any, appState: any, files: any) => {
      liveRef.current = { elements, appState, files };
      scheduleViewSave(appState);
    },
    [scheduleViewSave],
  );

  // Center of the drawing content's bounding box, in scene coords.
  const getContentCenter = useCallback(() => {
    const scene = initialDataRef.current;
    if (!scene || !Array.isArray(scene.elements)) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
    for (const el of scene.elements) {
      if (el?.isDeleted) continue;
      if (typeof el.x !== "number" || typeof el.y !== "number") continue;
      const ew = typeof el.width === "number" ? el.width : 0;
      const eh = typeof el.height === "number" ? el.height : 0;
      minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + ew); maxY = Math.max(maxY, el.y + eh);
      has = true;
    }
    if (!has) return null;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }, []);

  // Content bounding box size in scene coords (for sizing the embed to hug content).
  const getContentSize = useCallback(() => {
    const scene = initialDataRef.current;
    if (!scene || !Array.isArray(scene.elements)) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
    for (const el of scene.elements) {
      if (el?.isDeleted) continue;
      if (typeof el.x !== "number" || typeof el.y !== "number") continue;
      const ew = typeof el.width === "number" ? el.width : 0;
      const eh = typeof el.height === "number" ? el.height : 0;
      minX = Math.min(minX, el.x); minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + ew); maxY = Math.max(maxY, el.y + eh);
      has = true;
    }
    if (!has) return null;
    return { w: maxX - minX, h: maxY - minY };
  }, []);

  // Size the embed canvas height to hug the content (scale to fit width, then derive
  // the needed height at that zoom), so there's no big empty area under a small
  // drawing. Falls back to keeping the current height when bounds are unknown.
  // After a fit, hug the container height to the content so there's no big empty
  // area under a small drawing. Only applies when the user hasn't set a custom
  // height (node.__height === null) — once the user drags the resize handle, the
  // saved height wins and we stop auto-resizing, so dragging isn't fought.
  const fitHeightToContent = useCallback(() => {
    const a = apiRef.current;
    const size = getContentSize();
    if (!a || !size || size.w <= 0 || size.h <= 0) return;
    // Respect a user-set height: never override what they dragged. Read the CURRENT
    // node (via ref) — after a fullscreen save the node is replaced, and a stale
    // closure would otherwise see the old height/hash.
    if (nodeRef.current.__height != null) return;
    try {
      const st = a.getAppState();
      // scrollToContent({fitToContent:true}) already applied the fitted zoom; read
      // it back so we size the container to the ACTUAL displayed content height.
      const zv = typeof st.zoom === "number" ? st.zoom : st.zoom?.value ?? 1;
      const pad = 16;
      const displayH = size.h * (Number.isFinite(zv) && zv > 0 ? zv : 1) + pad * 2;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(displayH)));
      // Only AUTO-shrink the container to hug content; never let it inflate from a
      // not-yet-fitted zoom (which would make the embed huge instead of centered).
      // A user-dragged height stays via node.__height; init height stays otherwise.
      if (next < heightRef.current - 2) {
        heightRef.current = next;
        setHeight(next);
      }
    } catch {
      /* best-effort */
    }
  }, [getContentSize]);

  // Zoom to the target factor and CENTER the content without auto-fitting. Excalidraw's
  // scene→viewport mapping is `sceneX = scrollX + canvasX - canvasX/zoom`, so to place
  // the content center at the viewport center we set `scrollX = ccx - w/2 + w/(2·zoom)`.
  const zoomTo = useCallback(
    (targetZoom: number) => {
      const a = apiRef.current;
      if (!a) return;
      const st = a.getAppState();
      const w = typeof st.width === "number" && st.width > 0 ? st.width : 1;
      const h = typeof st.height === "number" && st.height > 0 ? st.height : 1;
      const raw = Number.isFinite(targetZoom) ? targetZoom : 1;
      const nz = Math.min(16, Math.max(0.05, raw));
      const center = getContentCenter();
      try {
        // Excalidraw maps canvas→scene as `sceneX = canvasX/zoom - scrollX`. To place
        // the content center at the viewport center (canvasX = w/2), solve scrollX:
        //   center.x = (w/2)/zoom - scrollX  ⇒  scrollX = w/(2·zoom) - center.x.
        const appState: Record<string, unknown> = { zoom: { value: nz } };
        if (center) {
          appState.scrollX = w / (2 * nz) - center.x;
          appState.scrollY = h / (2 * nz) - center.y;
        }
        a.updateScene({ appState, captureUpdate: CaptureUpdateAction.NEVER });
      } catch {
        /* best-effort */
      }
      setZoomPct(Math.round(nz * 100));
    },
    [getContentCenter],
  );

  // The appState.zoom is a `{ value }` object (and can be undefined before the
  // canvas settles); coerce to a positive number (default 1) so zoom always steps
  // from a sane base.
  const baseZoom = useCallback(() => {
    const a = apiRef.current;
    if (!a) return 1;
    const z = a.getAppState().zoom;
    const v = typeof z === "number" ? z : z?.value;
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 1;
  }, []);

  const zoomIn = useCallback(() => zoomTo(baseZoom() * 1.25), [zoomTo, baseZoom]);

  const zoomOut = useCallback(() => zoomTo(baseZoom() / 1.25), [zoomTo, baseZoom]);

  const zoomReset = useCallback(() => zoomTo(1), [zoomTo]);

  // Fit the whole drawing content into the embed. Excalidraw's scrollToContent uses
  // its internal setState to zoom+center — the reliable way to change the view. We
  // must pass the elements Excalidraw ACTUALLY reports via onChange (liveRef), not
  // our load-time initialData snapshot nor getSceneElements() (which returns [] in
  // view-only mode). Using the live scene is what lets scrollToContent find the
  // elements and fit/center the drawing.
  const fitNow = useCallback(() => {
    const a = apiRef.current;
    // Prefer the elements Excalidraw reported (onChange); fall back to loaded scene.
    const scene = (liveRef.current?.elements && liveRef.current.elements.length > 0)
      ? liveRef.current
      : initialDataRef.current;
    if (!a || !scene || !Array.isArray(scene.elements) || scene.elements.length === 0) return;
    try {
      a.scrollToContent(scene.elements, { fitToContent: true, animate: false });
      // After the fit, hug the container height to the fitted content.
      requestAnimationFrame(fitHeightToContent);
    } catch {
      /* best-effort */
    }
  }, [fitHeightToContent]);

  // Fit on load, retrying for a while: right after a fullscreen edit-and-save the
  // Excalidraw gets remounted (keyed by hash) and its scene elements are parsed
  // asynchronously, so a fit immediately after mount can no-op. Retry more frames
  // (the scene can take a beat to settle) so the fit lands once the drawing is on the
  // canvas. A manual ◎ 适配 button still does one shot.
  const fitContent = useCallback(() => {
    if (savedViewRef.current) return;
    let tries = 0;
    const attempt = () => {
      const a = apiRef.current;
      // Wait until Excalidraw has REPORTED the scene via onChange (liveRef) — that's
      // when scrollToContent can actually find the elements to fit. getSceneElements()
      // returns [] in view-only mode, so we can't use it as the readiness signal.
      const scene = liveRef.current;
      const hasContent = !!(a && scene && Array.isArray(scene.elements) && scene.elements.length > 0);
      if (hasContent) {
        fitNow();
        return;
      }
      if (tries++ < 20) requestAnimationFrame(attempt);
    };
    attempt();
  }, [fitNow]);

  // Stable ref-backed callback so the memoized Excalidraw doesn't see a new
  // function identity on every parent render. Registers the scroll/view callback
  // (so pan/zoom auto-saves) and triggers the initial fit once Excalidraw has
  // mounted (and the scene is loaded).
  const setApi = useCallback(
    (a: any) => {
      apiRef.current = a;
      a?.onScrollChange?.((scrollX: number, scrollY: number, zoom: { value: number }) => {
        const zv = typeof zoom === "number" ? zoom : zoom?.value;
        // Guard against a transient NaN zoom (before the canvas settles): never
        // persist it or paint it into the label, or the block locks into NaN%.
        if (typeof zv === "number" && isFinite(zv) && zv > 0) {
          scheduleViewSave({ zoom: zv, scrollX, scrollY });
          setZoomPct(Math.round(zv * 100));
        }
      });
      requestAnimationFrame(fitContent);
    },
    [fitContent, scheduleViewSave],
  );

  // Re-fit & center whenever the scene loads (initial load, or after the
  // fullscreen editor saves a new version), so the read-only block always shows
  // the drawing fitted & centered.
  useEffect(() => {
    if (!initialData) return;
    const id = requestAnimationFrame(fitContent);
    return () => cancelAnimationFrame(id);
  }, [initialData, fitContent]);

  // Clear any pending viewport-save timer on unmount.
  useEffect(() => {
    return () => {
      if (viewTimerRef.current !== null) window.clearTimeout(viewTimerRef.current);
    };
  }, []);

  const persistHeight = useCallback(
    (h: number) => {
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const n = $getNodeByKey(node.getKey());
          if (n && $isDrawingNode(n)) n.setDrawing({ height: h });
        });
      }
    },
    [node],
  );

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = heightRef.current;
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)));
        heightRef.current = next;
        setHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        persistHeight(heightRef.current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [persistHeight],
  );

  const downloadSvg = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    try {
      const svgEl = await exportToSvg({ elements: scene.elements, appState: scene.appState, files: scene.files, exportPadding: 16 });
      downloadBlob(new Blob([new XMLSerializer().serializeToString(svgEl)], { type: "image/svg+xml" }), "drawing.svg");
      toast("已导出 SVG", "success");
    } catch (e) {
      setErr(`导出 SVG 失败：${e}`);
    }
  }, []);

  const downloadPng = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    try {
      const blob = await exportToBlob({ elements: scene.elements, appState: scene.appState, files: scene.files, mimeType: "image/png", exportPadding: 16 });
      downloadBlob(blob, "drawing.png");
      toast("已导出 PNG", "success");
    } catch (e) {
      setErr(`导出 PNG 失败：${e}`);
    }
  }, []);

  const copyPng = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    try {
      await exportToClipboard({ elements: scene.elements, appState: scene.appState, files: scene.files, type: "png" });
      toast("已复制到剪贴板", "success");
    } catch (e) {
      setErr(`复制失败：${e}`);
    }
  }, []);

  const fullscreen = useCallback(() => {
    useEditorStore.getState().openDrawingEdit({ nodeKey: node.getKey(), hash: node.__hash, mime: node.__mime, text: node.__text });
  }, [node]);

  if (!ready || !initialData) {
    return <div className="inline-drawing-loading">加载绘图…</div>;
  }

  return (
    <div className="inline-drawing-wrap" contentEditable={false}>
      <div className="inline-drawing-bar">
        <button className="inline-drawing-btn" onClick={fullscreen} title="编辑（全屏）">编辑</button>
        <button className="inline-drawing-btn inline-drawing-zoom-btn" onClick={zoomOut} title="缩小"><ZoomOutIcon /></button>
        <button className="inline-drawing-btn inline-drawing-pct" onClick={zoomReset} title="重置为 100%">{zoomPct}%</button>
        <button className="inline-drawing-btn inline-drawing-zoom-btn" onClick={zoomIn} title="放大"><ZoomInIcon /></button>
        <button className="inline-drawing-btn" onClick={fitNow} title="适配内容">◎</button>
        <button className="inline-drawing-btn" onClick={downloadSvg} title="导出 SVG">⇩</button>
        <button className="inline-drawing-btn" onClick={downloadPng} title="导出 PNG">⭳</button>
        <button className="inline-drawing-btn" onClick={copyPng} title="复制">⧉</button>
        {err ? <span className="inline-drawing-err">{err}</span> : null}
      </div>
      <div className="inline-drawing">
        <div className="inline-drawing-canvas" style={{ height }}>
          <InlineExcalidraw
            // Excalidraw only reads `initialData` on MOUNT; it won't reload when the
            // prop changes. After a fullscreen edit-and-save the blob hash (and thus
            // the scene) changes — keying by hash forces Excalidraw to remount with
            // the NEW scene, so the read-only embed actually shows the updated drawing
            // (then auto-fits on load). Without this, the memoized component is reused
            // and keeps rendering the previous (now-stale) empty canvas.
            key={hash}
            initialData={initialData}
            viewMode={true}
            isDark={isDark}
            onChange={onChange}
            onApi={setApi}
          />
        </div>
        <div className="inline-drawing-resize" onPointerDown={onResizeDown} title="拖拽调整高度" />
      </div>
    </div>
  );
}

export default InlineDrawing;
