import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, restore, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { api } from "../lib/api";
import { blobStore } from "../lib/platform/blobStore";
import { $isDrawingNode } from "../editor/nodes/DrawingNode";

interface SceneSnapshot {
  elements: any[];
  appState: any;
  files: any;
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

  useEffect(() => {
    if (!drawingEdit) return;
    let alive = true;
    setErr(null);
    setReady(false);
    setInitialData(null);
    const load = async () => {
      let scene: SceneSnapshot = { elements: [], appState: {}, files: {} };
      if (drawingEdit.hash) {
        try {
          const bytes = await blobStore.get(drawingEdit.hash);
          if (bytes) {
            const parsed = JSON.parse(new TextDecoder().decode(bytes) || "{}");
            const elems = Array.isArray(parsed?.elements) ? parsed.elements : [];
            const restored = await restore(elems, parsed?.appState ?? {}, parsed?.files ?? {});
            scene = { elements: restored.elements, appState: restored.appState, files: restored.files };
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
  }, []);

  const save = useCallback(async () => {
    const d = useEditorStore.getState().drawingEdit;
    const scene = liveRef.current;
    if (!d || !scene) return;
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
      const text = (scene.elements as { type?: string; text?: string }[])
        .filter((e) => e.type === "text" && typeof e.text === "string")
        .map((e) => e.text ?? "")
        .join(" ");
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
  }, [close]);

  if (!drawingEdit) return null;
  if (!ready || !initialData) return null;

  return createPortal(
    <div className="drawing-modal">
      <div className="drawing-modal-head">
        <span className="drawing-modal-title">绘图（Excalidraw）</span>
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
          initialData={initialData}
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
