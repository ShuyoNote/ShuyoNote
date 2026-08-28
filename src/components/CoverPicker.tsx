import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COVER_PRESETS } from "../lib/covers";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";

// Read a file's bytes (via its asset URL) into a downscaled cover data-URI.
async function fileToCoverDataUrl(src: string): Promise<string | null> {
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
  const raw = await new Promise<string>((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => res("");
    r.readAsDataURL(new Blob([bytes]));
  });
  if (!raw) return null;
  return await new Promise<string>((res) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      const scale = Math.min(1, MAX / (img.naturalWidth || 1));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => res(raw);
    img.src = raw;
  });
}

// M25/页面封面 — a small gallery to pick a built-in cover (or clear / custom).
export function CoverPicker({ onClose, onPick, current }: { onClose: () => void; onPick: (css: string) => void; current?: string }) {
  const [custom, setCustom] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const uploadCover = async () => {
    if (uploading) return;
    try {
      const picked = await platform.dialog.open({
        title: "选择封面图片",
        multiple: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      setUploading(true);
      // Import as a content-addressed attachment so the bytes are readable on both
      // desktop (disk path) and web (blobStore), then encode a downscaled data-URI.
      const metas = await api.importAttachmentFiles(null, [path]);
      if (!metas.length) {
        toast("未读到图片", "error");
        return;
      }
      const src = platform.asset.convertFileSrc(metas[0].path ?? "");
      const dataUrl = await fileToCoverDataUrl(src);
      if (!dataUrl) {
        toast("读取图片失败", "error");
        return;
      }
      onPick(`url("${dataUrl}")`);
    } catch (e) {
      toast(`上传封面失败：${e}`, "error");
    } finally {
      setUploading(false);
    }
  };

  return createPortal(
    <div
      className="cover-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cover-picker">
        <div className="cover-picker-head">
          <span className="cover-picker-title">选择题头图</span>
          <span className="cover-picker-sub">内置封面</span>
        </div>
        <div className="cover-picker-grid">
          {COVER_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`cover-swatch ${current === p.css ? "active" : ""}`}
              style={{ backgroundImage: p.css }}
              title={p.name}
              onClick={() => onPick(p.css)}
            />
          ))}
        </div>
        <div className="cover-picker-custom">
          <input
            ref={inputRef}
            className="cover-picker-input"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                onPick(custom.trim());
              }
            }}
            placeholder="自定义 CSS 渐变，如 linear-gradient(135deg, #667eea, #764ba2)；回车应用"
            spellCheck={false}
          />
        </div>
        <div className="cover-picker-actions">
          <button className="cover-picker-upload" onClick={uploadCover} disabled={uploading}>
            {uploading ? "上传中…" : "上传图片"}
          </button>
          <div className="cover-picker-actions-right">
            <button className="cover-picker-clear" onClick={() => onPick("")}>
              清除
            </button>
            <button className="cover-picker-btn" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
