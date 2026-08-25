import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, restore, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { api } from "../lib/api";
import { blobStore } from "../lib/platform/blobStore";
import { excalidrawText } from "../lib/drawing";
import { $isDrawingNode } from "../editor/nodes/DrawingNode";

interface SavedScene {
  type: string;
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

const EMPTY: SavedScene = { type: "excalidraw", elements: [], appState: {}, files: {} };

export default function DrawingEditorModal() {
  const drawingEdit = useEditorStore((s) => s.drawingEdit);
  const close = useEditorStore((s) => s.closeDrawingEdit);
  const [scene, setScene] = useState<SavedScene>(EMPTY);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load the saved scene whenever the modal opens.
  useEffect(() => {
    if (!drawingEdit) return;
    let alive = true;
    setErr(null);
    const load = async () => {
      if (!drawingEdit.hash) {
        setScene(EMPTY);
        return;
      }
      try {
        const bytes = await blobStore.get(drawingEdit.hash);
        if (!bytes) {
          setScene(EMPTY);
          return;
        }
        const parsed = JSON.parse(new TextDecoder().decode(bytes) || "{}");
        const elements = Array.isArray(parsed?.elements) ? parsed.elements : [];
        const restored = await restore(elements, parsed?.appState ?? {}, parsed?.files ?? {});
        if (alive) {
          setScene({ type: "excalidraw", elements: restored.elements, appState: restored.appState, files: restored.files });
        }
      } catch (e) {
        if (alive) {
          setErr(`读取绘图失败：${e}`);
          setScene(EMPTY);
        }
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, [drawingEdit]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      setScene({ type: "excalidraw", elements: [...elements], appState, files });
    },
    [],
  );

  const save = useCallback(async () => {
    const d = useEditorStore.getState().drawingEdit;
    if (!d) return;
    setBusy(true);
    setErr(null);
    try {
      const json = JSON.stringify(scene);
      const jsonMeta = await api.saveImage({
        page_id: null,
        name: "drawing.json",
        mime: "application/json",
        data: Array.from(new TextEncoder().encode(json)),
      });
      const png = await exportToBlob({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files,
        mimeType: "image/png",
        exportPadding: 16,
        maxWidthOrHeight: 1400,
        background: true,
      });
      const pngBytes = new Uint8Array(await png.arrayBuffer());
      const pngMeta = await api.saveImage({
        page_id: null,
        name: "drawing-thumb.png",
        mime: "image/png",
        data: Array.from(pngBytes),
      });

      const text = excalidrawText(scene.elements);
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const node = $getNodeByKey(d.nodeKey);
          if (node && $isDrawingNode(node)) {
            node.setDrawing({
              hash: jsonMeta.hash,
              mime: "application/json",
              thumbHash: pngMeta.hash,
              thumbMime: "image/png",
              text,
            });
          }
        });
      }
      close();
    } catch (e) {
      setErr(`保存绘图失败：${e}`);
      setBusy(false);
    }
  }, [scene, close]);

  if (!drawingEdit) return null;

  return createPortal(
    <div className="drawing-modal">
      <div className="drawing-modal-head">
        <span className="drawing-modal-title">绘图</span>
        <span className="drawing-modal-actions">
          <button className="drawing-modal-btn" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
          <button className="drawing-modal-btn" onClick={close}>
            取消
          </button>
        </span>
      </div>
      <div className="drawing-modal-body">
        <Excalidraw
          onChange={onChange}
          initialData={{ elements: scene.elements, appState: scene.appState as AppState, files: scene.files }}
          excalidrawAPI={(api) => (apiRef.current = api)}
          UIOptions={{ canvasActions: { export: false } }}
          langCode="zh-CN"
        />
        {err ? <div className="drawing-modal-err">{err}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
