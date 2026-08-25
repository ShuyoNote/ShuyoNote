import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restore, exportToBlob, exportToSvg, exportToClipboard } from "@excalidraw/excalidraw";
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

export function InlineDrawing({ node }: { node: DrawingNode }) {
  const apiRef = useRef<any>(null);
  const liveRef = useRef<SceneSnapshot | null>(null);
  // `initialData` is set once and never mutated; Excalidraw re-initializes loops if it changes.
  const [initialData, setInitialData] = useState<SceneSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(node.__height ?? DEFAULT_HEIGHT);
  const heightRef = useRef<number>(height);
  const isDark = useResolvedTheme() === "dark";
  const savedViewRef = useRef(false);
  const viewTimerRef = useRef<number | null>(null);

  const hash = node.__hash;

  // Load the saved scene whenever the node's blob hash changes.
  useEffect(() => {
    let alive = true;
    setErr(null);
    setReady(false);
    // Sync resize height to the node's persisted value.
    const nextH = node.__height ?? DEFAULT_HEIGHT;
    heightRef.current = nextH;
    setHeight(nextH);
    // Remember whether a viewport (zoom/scroll) was previously saved so we restore
    // it instead of re-fitting to content.
    const hasSavedView = node.__zoom != null || node.__scrollX != null || node.__scrollY != null;
    savedViewRef.current = hasSavedView;
    const savedView =
      node.__zoom != null || node.__scrollX != null || node.__scrollY != null
        ? {
            ...(node.__zoom != null ? { zoom: node.__zoom } : {}),
            ...(node.__scrollX != null ? { scrollX: node.__scrollX } : {}),
            ...(node.__scrollY != null ? { scrollY: node.__scrollY } : {}),
          }
        : {};
    const load = async () => {
      // Grid is off by default; a fresh inline drawing shows a clean canvas.
      let scene: SceneSnapshot = { elements: [], appState: { gridModeEnabled: false, ...savedView }, files: {} };
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
            scene = { elements: restored.elements, appState: { ...restored.appState, gridModeEnabled: false, ...savedView }, files: restored.files };
          }
        } catch (e) {
          if (alive) setErr(String(e));
        }
      }
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
      const z = appState?.zoom;
      const sx = appState?.scrollX;
      const sy = appState?.scrollY;
      if (typeof z !== "number" && typeof sx !== "number" && typeof sy !== "number") return;
      const editor = useEditorStore.getState().editor;
      if (!editor) return;
      editor.update(() => {
        const n = $getNodeByKey(node.getKey());
        if (n && $isDrawingNode(n)) {
          n.setDrawing({
            zoom: typeof z === "number" ? z : null,
            scrollX: typeof sx === "number" ? sx : null,
            scrollY: typeof sy === "number" ? sy : null,
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

  // Zoom around the current canvas viewport center (keeps the center fixed).
  const zoomTo = useCallback((targetZoom: number) => {
    const a = apiRef.current;
    if (!a) return;
    const st = a.getAppState();
    const w = st.width || 0;
    const h = st.height || 0;
    const cz = st.zoom || 1;
    const nz = Math.min(16, Math.max(0.05, targetZoom));
    const sceneCx = st.scrollX + w / 2 / cz;
    const sceneCy = st.scrollY + h / 2 / cz;
    try {
      a.updateScene({
        appState: { zoom: nz, scrollX: sceneCx - w / 2 / nz, scrollY: sceneCy - h / 2 / nz },
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const zoomIn = useCallback(() => {
    const a = apiRef.current;
    if (a) zoomTo((a.getAppState().zoom || 1) * 1.25);
  }, [zoomTo]);

  const zoomOut = useCallback(() => {
    const a = apiRef.current;
    if (a) zoomTo((a.getAppState().zoom || 1) / 1.25);
  }, [zoomTo]);

  const zoomReset = useCallback(() => zoomTo(1), [zoomTo]);

  // Fit & center the whole drawing content in the embed (used by the 适配 button
  // and for the initial view when no viewport has been saved yet).
  const fitNow = useCallback(() => {
    const a = apiRef.current;
    const scene = liveRef.current;
    if (!a || !scene || !Array.isArray(scene.elements) || scene.elements.length === 0) return;
    try {
      a.scrollToContent(scene.elements, { fitToContent: true, animate: false });
    } catch {
      /* best-effort */
    }
  }, []);

  // Automatic fit on load only when the user hasn't previously saved their view.
  const fitContent = useCallback(() => {
    if (savedViewRef.current) return;
    fitNow();
  }, [fitNow]);

  // Stable ref-backed callback so the memoized Excalidraw doesn't see a new
  // function identity on every parent render. Registers the scroll/view callback
  // (so pan/zoom auto-saves) and triggers the initial fit once Excalidraw has
  // mounted (and the scene is loaded).
  const setApi = useCallback(
    (a: any) => {
      apiRef.current = a;
      a?.onScrollChange?.((scrollX: number, scrollY: number, zoom: number) => {
        scheduleViewSave({ zoom, scrollX, scrollY });
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
    <div className="inline-drawing" contentEditable={false}>
      <div className="inline-drawing-bar">
        <button className="inline-drawing-btn" onClick={fullscreen} title="编辑（全屏）">编辑</button>
        <button className="inline-drawing-btn" onClick={zoomIn} title="放大">＋</button>
        <button className="inline-drawing-btn" onClick={zoomOut} title="缩小">－</button>
        <button className="inline-drawing-btn" onClick={zoomReset} title="重置为 100%">100%</button>
        <button className="inline-drawing-btn" onClick={fitNow} title="适配内容">◎</button>
        <button className="inline-drawing-btn" onClick={downloadSvg} title="导出 SVG">⇩</button>
        <button className="inline-drawing-btn" onClick={downloadPng} title="导出 PNG">⭳</button>
        <button className="inline-drawing-btn" onClick={copyPng} title="复制">⧉</button>
        {err ? <span className="inline-drawing-err">{err}</span> : null}
      </div>
      <div className="inline-drawing-canvas" style={{ height }}>
        <InlineExcalidraw
          initialData={initialData}
          viewMode={true}
          isDark={isDark}
          onChange={onChange}
          onApi={setApi}
        />
      </div>
      <div className="inline-drawing-resize" onPointerDown={onResizeDown} title="拖拽调整高度" />
    </div>
  );
}

export default InlineDrawing;
