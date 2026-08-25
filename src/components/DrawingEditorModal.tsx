import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { $getNodeByKey } from "lexical";
import { useEditorStore } from "../store/editor";
import { api } from "../lib/api";
import { blobStore } from "../lib/platform/blobStore";
import { bytesToDataUrl } from "../lib/ai/imageGen";
import { $isDrawingNode } from "../editor/nodes/DrawingNode";
import { DrawCanvas, type DrawCanvasHandle } from "./DrawCanvas";

export default function DrawingEditorModal() {
  const drawingEdit = useEditorStore((s) => s.drawingEdit);
  const close = useEditorStore((s) => s.closeDrawingEdit);
  const drawRef = useRef<DrawCanvasHandle | null>(null);
  const [initialImage, setInitialImage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load the existing drawing (PNG) as a data URL when the modal opens.
  useEffect(() => {
    if (!drawingEdit) return;
    let alive = true;
    setErr(null);
    setReady(false);
    setInitialImage(null);
    const load = async () => {
      if (drawingEdit.hash) {
        try {
          const bytes = await blobStore.get(drawingEdit.hash);
          if (bytes && alive) {
            setInitialImage(bytesToDataUrl(bytes, drawingEdit.mime ?? "image/png"));
            if (alive) setReady(true);
            return;
          }
        } catch (e) {
          if (alive) setErr(`读取绘图失败：${e}`);
        }
      }
      if (alive) setReady(true);
    };
    load();
    return () => {
      alive = false;
    };
  }, [drawingEdit]);

  const save = useCallback(async () => {
    const d = useEditorStore.getState().drawingEdit;
    if (!d || !drawRef.current) return;
    setBusy(true);
    setErr(null);
    try {
      const pngBlob = await drawRef.current.exportBlob();
      if (!pngBlob) throw new Error("绘图内容为空");
      const bytes = new Uint8Array(await pngBlob.arrayBuffer());
      const pngMeta = await api.saveImage({
        page_id: null,
        name: "drawing.png",
        mime: "image/png",
        data: Array.from(bytes),
      });
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const node = $getNodeByKey(d.nodeKey);
          if (node && $isDrawingNode(node)) {
            node.setDrawing({
              hash: pngMeta.hash,
              mime: "image/png",
              thumbHash: pngMeta.hash,
              thumbMime: "image/png",
              text: "",
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
  if (!ready) return null;

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
        <DrawCanvas ref={drawRef} initialImage={initialImage} />
        {err ? <div className="drawing-modal-err">{err}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
