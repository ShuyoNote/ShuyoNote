import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, restore, exportToBlob, exportToSvg, serializeAsJSON, exportToClipboard } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { useResolvedTheme } from "../store/theme";
import { api } from "../lib/api";
import { blobStore } from "../lib/platform/blobStore";
import { toast } from "../store/toast";
import { excalidrawSceneText } from "../lib/drawingText";
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
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [height, setHeight] = useState<number>(node.__height ?? DEFAULT_HEIGHT);
  const heightRef = useRef<number>(height);
  const isDark = useResolvedTheme() === "dark";

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
    const load = async () => {
      // Grid is off by default; a fresh inline drawing shows a clean canvas.
      let scene: SceneSnapshot = { elements: [], appState: { gridModeEnabled: false }, files: {} };
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
            scene = { elements: restored.elements, appState: { ...restored.appState, gridModeEnabled: false }, files: restored.files };
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

  const onChange = useCallback((elements: any, appState: any, files: any) => {
    liveRef.current = { elements, appState, files };
  }, []);

  // Fit & center the whole drawing content in the embed (auto zoom-to-fit) so the
  // drawing isn't stuck at the default canvas zoom. No-op for an empty scene.
  const fitContent = useCallback(() => {
    const a = apiRef.current;
    const scene = liveRef.current;
    if (!a || !scene || !Array.isArray(scene.elements) || scene.elements.length === 0) return;
    try {
      a.scrollToContent(scene.elements, { fitToContent: true, animate: false });
    } catch {
      /* best-effort */
    }
  }, []);

  // Stable ref-backed callback so the memoized Excalidraw doesn't see a new
  // function identity on every parent render. Also triggers the initial fit once
  // Excalidraw has mounted (and the scene is loaded).
  const setApi = useCallback(
    (a: any) => {
      apiRef.current = a;
      requestAnimationFrame(fitContent);
    },
    [fitContent],
  );

  // Re-fit & center when returning to read-only view (after editing), so the
  // content stays neatly fitted. Not applied while editing (user controls zoom).
  useEffect(() => {
    if (editing) return;
    const id = requestAnimationFrame(fitContent);
    return () => cancelAnimationFrame(id);
  }, [editing, fitContent]);

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

  const save = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    setBusy(true);
    setErr(null);
    try {
      const json = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
      const jsonMeta = await api.saveImage({
        page_id: null,
        name: "drawing.excalidraw",
        mime: "application/json",
        data: Array.from(new TextEncoder().encode(json)),
      });
      const png = await exportToBlob({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files,
        mimeType: "image/png",
        exportPadding: 16,
      });
      const pngBytes = new Uint8Array(await png.arrayBuffer());
      const pngMeta = await api.saveImage({
        page_id: null,
        name: "drawing-thumb.png",
        mime: "image/png",
        data: Array.from(pngBytes),
      });
      const text = excalidrawSceneText(scene.elements);
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const n = $getNodeByKey(node.getKey());
          if (n && $isDrawingNode(n)) {
            n.setDrawing({
              hash: jsonMeta.hash,
              mime: "application/json",
              thumbHash: pngMeta.hash,
              thumbMime: "image/png",
              text,
            });
          }
        });
      }
      setEditing(false);
      toast("已保存", "success");
    } catch (e) {
      setErr(`保存失败：${e}`);
      setBusy(false);
    }
  }, [node]);

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
    <div className={`inline-drawing${editing ? " editing" : ""}`} contentEditable={false}>
      <div className="inline-drawing-bar">
        <button className="inline-drawing-btn" onClick={() => setEditing((v) => !v)} title="编辑 / 只读">
          {editing ? "完成" : "编辑"}
        </button>
        {editing ? (
          <button className="inline-drawing-btn" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        ) : null}
        <button className="inline-drawing-btn" onClick={downloadSvg} title="导出 SVG">⇩</button>
        <button className="inline-drawing-btn" onClick={downloadPng} title="导出 PNG">⭳</button>
        <button className="inline-drawing-btn" onClick={copyPng} title="复制">⧉</button>
        <button className="inline-drawing-btn" onClick={fullscreen} title="全屏编辑">⛶</button>
        {err ? <span className="inline-drawing-err">{err}</span> : null}
      </div>
      <div className="inline-drawing-canvas" style={{ height }}>
        <InlineExcalidraw
          initialData={initialData}
          viewMode={!editing}
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
