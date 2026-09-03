import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, restore, exportToBlob, exportToSvg, exportToClipboard, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
import { blobStore } from "../lib/platform/blobStore";
import { toast } from "../store/toast";
import { inputDialog } from "../store/input";
import { useNotes } from "../store/notes";
import { excalidrawSceneText } from "../lib/drawingText";
import { $isDrawingNode } from "../editor/nodes/DrawingNode";

interface SceneSnapshot {
  elements: any[];
  appState: any;
  files: any;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, name: string, mime = "image/svg+xml") {
  downloadBlob(new Blob([text], { type: mime }), name);
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A minimal but valid Excalidraw image element (base fields + image extras).
function makeImageEl(fileId: string, x: number, y: number, w: number, h: number, mime: string): any {
  const seed = Math.floor(Math.random() * 1e9);
  return {
    type: "image",
    id: makeId(),
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    opacity: 100,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    fileId,
    status: "saved",
    scale: [1, 1],
    mimeType: mime,
  };
}

function preloadImg(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = dataUrl;
  });
}

export default function DrawingEditorModal() {
  const drawingEdit = useEditorStore((s) => s.drawingEdit);
  const close = useEditorStore((s) => s.closeDrawingEdit);
  const apiRef = useRef<any>(null);
  const liveRef = useRef<SceneSnapshot | null>(null);
  // `initialData` is set ONCE when the modal opens and never mutated; Excalidraw
  // re-initializes loops if it changes across renders.
  const [initialData, setInitialData] = useState<SceneSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">("auto");
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedRef = useRef<string[]>([]);

  useEffect(() => {
    if (!drawingEdit) return;
    let alive = true;
    setErr(null);
    setReady(false);
    setInitialData(null);
    const load = async () => {
      let scene: SceneSnapshot = { elements: [], appState: { gridModeEnabled: false }, files: {} };
      if (drawingEdit.hash) {
        try {
          const bytes = await blobStore.get(drawingEdit.hash);
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
          if (alive) setErr(`读取绘图失败：${e}`);
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
  }, [drawingEdit]);

  const onChange = useCallback((elements: any, appState: any, files: any) => {
    liveRef.current = { elements, appState, files };
    if (appState?.selectedElementIds && typeof appState.selectedElementIds === "object") {
      selectedRef.current = Object.keys(appState.selectedElementIds).filter((k) => appState.selectedElementIds[k]);
    }
  }, []);

  const save = useCallback(async () => {
    const d = useEditorStore.getState().drawingEdit;
    const scene = liveRef.current;
    if (!d || !scene) return;
    setBusy(true);
    setErr(null);
    try {
      // 1) Persist the drawing CONTENT (.excalidraw JSON) — fast and deterministic
      //    (content-hashded blob store). This is what makes the drawing recoverable,
      //    so we save it first and close the modal as soon as it lands.
      const json = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
      const jsonMeta = await api.saveImage({
        page_id: null,
        name: "drawing.excalidraw",
        mime: "application/json",
        data: Array.from(new TextEncoder().encode(json)),
      });
      const text = excalidrawSceneText(scene.elements);
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const node = $getNodeByKey(d.nodeKey);
          if (node && $isDrawingNode(node)) {
            // After any fullscreen edit-and-save, the read-only inline embed should
            // AUTO-FIT the whole drawing (show the updated scene fitted & centered).
            // Clear any previously-saved viewport so InlineDrawing's fitContent runs
            // on reload instead of restoring an old (now-stale) zoom/pan.
            node.setDrawing({ hash: jsonMeta.hash, mime: "application/json", text, zoom: null, scrollX: null, scrollY: null });
          }
        });
      }
      close();
      setBusy(false);
      // 2) Render + persist the PNG thumbnail in the BACKGROUND (never blocks the
      //    modal, so the Save button can't get stuck at "保存中…"). PNG export of a
      //    large scene can be slow; making it non-blocking keeps saving responsive.
      exportToBlob({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files,
        mimeType: "image/png",
        exportPadding: 16,
      })
        .then(async (png: Blob) => {
          const pngBytes = new Uint8Array(await png.arrayBuffer());
          const pngMeta = await api.saveImage({
            page_id: null,
            name: "drawing-thumb.png",
            mime: "image/png",
            data: Array.from(pngBytes),
          });
          const ed = useEditorStore.getState().editor;
          if (ed) {
            ed.update(() => {
              const node = $getNodeByKey(d.nodeKey);
              if (node && $isDrawingNode(node)) {
                node.setDrawing({ thumbHash: pngMeta.hash, thumbMime: "image/png" });
              }
            });
          }
        })
        .catch(() => {
          // Thumbnail is best-effort; a failed PNG export must never break saving.
        });
    } catch (e) {
      setErr(`保存绘图失败：${e}`);
      setBusy(false);
    }
  }, [close]);

  const exportSvg = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    setErr(null);
    try {
      const svgEl = await exportToSvg({ elements: scene.elements, appState: scene.appState, files: scene.files, exportPadding: 16 });
      downloadText(new XMLSerializer().serializeToString(svgEl), "drawing.svg");
      toast("已导出 SVG", "success");
    } catch (e) {
      setErr(`导出 SVG 失败：${e}`);
    }
  }, []);

  const exportPng = useCallback(async () => {
    const scene = liveRef.current;
    if (!scene) return;
    setErr(null);
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
    setErr(null);
    try {
      await exportToClipboard({ elements: scene.elements, appState: scene.appState, files: scene.files, type: "png" });
      toast("已复制到剪贴板", "success");
    } catch (e) {
      setErr(`复制失败：${e}`);
    }
  }, []);

  // Inject an image (data URL) as an Excalidraw image element near the scene.
  const injectImage = useCallback(async (dataUrl: string, mime: string) => {
    const a = apiRef.current;
    if (!a) return;
    setErr(null);
    try {
      const img = await preloadImg(dataUrl);
      const scale = Math.min(640 / img.naturalWidth, 480 / img.naturalHeight, 2);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const existing = a.getSceneElements();
      const fileId = makeId();
      a.addFiles([{ id: fileId, dataURL: dataUrl, mimeType: mime, created: Date.now() }]);
      const el = makeImageEl(fileId, 40 + (existing.length % 6) * 60, 40 + (existing.length % 6) * 60, w, h, mime);
      a.updateScene({ elements: [...existing, el] });
      toast("已插入到画布", "success");
    } catch (e) {
      setErr(`插入图片失败：${e}`);
    }
  }, []);

  const insertImage = useCallback(async () => {
    const picked = await platform.dialog.open({ title: "插入图片", multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    try {
      const metas = await api.importAttachmentFiles(null, [path]);
      const src = platform.asset.convertFileSrc(metas[0].path ?? "");
      const bytes = await (await fetch(src)).arrayBuffer();
      const dataUrl = `data:${metas[0].mime};base64,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`;
      await injectImage(dataUrl, metas[0].mime);
    } catch (e) {
      toast(`插入图片失败：${e}`, "error");
    }
  }, [injectImage]);

  const mermaidDraw = useCallback(async () => {
    inputDialog({
      title: "流程图 / 思维导图",
      placeholder: "graph TD\n  A[开始] --> B[结束]",
      okLabel: "生成",
      onSubmit: async (srcText) => {
        const src = (srcText ?? "").trim();
        if (!src) return;
        try {
          const mod = await import("mermaid");
          const mermaid = mod.default;
          mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { htmlLabels: false, curve: "basis" } });
          const id = `sn-${Math.random().toString(36).slice(2, 10)}`;
          const { svg } = await mermaid.render(id, src);
          const blob = new Blob([svg], { type: "image/svg+xml" });
          const url = URL.createObjectURL(blob);
          const dataUrl = await new Promise<string>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = img.naturalWidth + 20;
              c.height = img.naturalHeight + 20;
              const ctx = c.getContext("2d");
              if (ctx) ctx.drawImage(img, 10, 10);
              resolve(c.toDataURL("image/png"));
              URL.revokeObjectURL(url);
            };
            img.src = url;
          });
          await injectImage(dataUrl, "image/png");
        } catch (e) {
          toast(`生成流程图失败：${e}`, "error");
        }
      },
    });
  }, [injectImage]);

  // Link the selected element(s) to a ShuyoNote page (stored on the element link).
  const linkSelected = useCallback(async () => {
    const a = apiRef.current;
    if (!a) return;
    if (selectedRef.current.length === 0) {
      toast("请先选中一个图形", "error");
      return;
    }
    inputDialog({
      title: "链接到页面",
      placeholder: "输入要链接的页面标题…",
      okLabel: "链接",
      onSubmit: (title) => {
        const t = (title ?? "").trim();
        if (!t) return;
        const notes = useNotes.getState();
        const page = notes.pages.find((p) => p.title === t) ?? notes.pages.find((p) => p.title.includes(t));
        if (!page) {
          toast(`未找到页面「${t}」`, "error");
          return;
        }
        const link = `shuyonote://page/${page.id}`;
        const els = a.getSceneElements();
        const next = els.map((e: any) => (selectedRef.current.includes(e.id) ? { ...e, link } : e));
        a.updateScene({ elements: next });
        toast(`已链接到「${page.title}」`, "success");
      },
    });
  }, []);

  // In read-only mode, clicking a linked element navigates to the page in-app.
  const handlePointerDown = useCallback(
    (_activeTool: any, state: any) => {
      if (!readOnly) return;
      const a = apiRef.current;
      if (!a) return;
      const origin = state?.origin;
      if (!origin || typeof origin.x !== "number" || typeof origin.y !== "number") return;
      try {
        const els = a.getSceneElements();
        for (const el of els) {
          if (el?.isDeleted) continue;
          const left = el.x;
          const top = el.y;
          const right = el.x + (el.width ?? 0);
          const bottom = el.y + (el.height ?? 0);
          if (origin.x >= left && origin.x <= right && origin.y >= top && origin.y <= bottom) {
            const link = el?.link;
            if (typeof link === "string" && link.startsWith("shuyonote://page/")) {
              const pageId = link.slice("shuyonote://page/".length);
              close();
              useNotes.getState().openPage(pageId);
              return;
            }
          }
        }
      } catch {
        /* hit-test requires scene coords; ignore misses */
      }
    },
    [readOnly, close],
  );

  if (!drawingEdit) return null;
  if (!ready || !initialData) return null;
  const systemDark = (document.documentElement.getAttribute("data-theme") ?? "") === "dark";
  const isDark = themeMode === "dark" || (themeMode === "auto" && systemDark);

  return createPortal(
    <div className="drawing-modal">
      <div className="drawing-modal-head">
        <div className="drawing-modal-title-box">
          <span className="drawing-modal-title">画板</span>
          <button className={`drawing-modal-tool ${readOnly ? "drawing-modal-tool-on" : ""}`} onClick={() => setReadOnly((v) => !v)} title="只读 / 编辑切换">
            {readOnly ? "✏️" : "👁"}
          </button>
        </div>
        <div className="drawing-modal-actions">
          <div className="drawing-modal-group">
            <button className="drawing-modal-tool" onClick={insertImage} title="插入图片">🖼</button>
            <button className="drawing-modal-tool" onClick={() => setMenuOpen((v) => !v)} title="绘图 / 主题 / Mermaid">＋</button>
            <button className="drawing-modal-tool" onClick={linkSelected} title="链接选中的图形到页面">🔗</button>
          </div>
          <span className="drawing-modal-sep" />
          <div className="drawing-modal-group">
            <button className="drawing-modal-tool" onClick={exportSvg} title="导出 SVG">⇩</button>
            <button className="drawing-modal-tool" onClick={exportPng} title="导出 PNG">⭳</button>
            <button className="drawing-modal-tool" onClick={copyPng} title="复制到剪贴板">⧉</button>
          </div>
          <span className="drawing-modal-sep" />
          <div className="drawing-modal-group">
            <button className="drawing-modal-btn drawing-modal-btn-primary" onClick={save} disabled={busy || readOnly}>
              {busy ? "保存中…" : "保存"}
            </button>
            <button className="drawing-modal-btn drawing-modal-btn-ghost" onClick={close}>
              取消
            </button>
          </div>
        </div>
      </div>
      <div className="drawing-modal-body">
        {menuOpen ? (
          <div className="drawing-menu" onMouseLeave={() => setMenuOpen(false)}>
            <div className="drawing-menu-title">绘图 / 主题</div>
            <button className="drawing-menu-item" onClick={() => { setThemeMode("auto"); setMenuOpen(false); }}>
              主题 · 跟随系统 {themeMode === "auto" ? "✓" : ""}
            </button>
            <button className="drawing-menu-item" onClick={() => { setThemeMode("light"); setMenuOpen(false); }}>
              主题 · 浅色 {themeMode === "light" ? "✓" : ""}
            </button>
            <button className="drawing-menu-item" onClick={() => { setThemeMode("dark"); setMenuOpen(false); }}>
              主题 · 深色 {themeMode === "dark" ? "✓" : ""}
            </button>
            <div className="drawing-menu-sep" />
            <button className="drawing-menu-item" onClick={() => { setMenuOpen(false); mermaidDraw(); }}>
              Mermaid 绘图
            </button>
          </div>
        ) : null}
        <Excalidraw
          onChange={onChange}
          initialData={initialData}
          excalidrawAPI={(api) => (apiRef.current = api)}
          viewModeEnabled={readOnly}
          onPointerDown={handlePointerDown}
          theme={isDark ? "dark" : "light"}
          UIOptions={{ canvasActions: { export: false } }}
          langCode="zh-CN"
        />
        {err ? <div className="drawing-modal-err">{err}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
