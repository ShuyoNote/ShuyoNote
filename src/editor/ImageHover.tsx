import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DownloadIcon, MaximizeIcon, XIcon } from "../components/icons";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
import { toast } from "../store/toast";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";

/** 从 mime / 文件名 / URL 里挑一个像样的扩展名（给“保存图片”用）。 */
export function imageFileExtension(mime?: string, alt?: string, src?: string): string {
  const fromAlt = alt?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromAlt) return fromAlt.toLowerCase();
  const fromSrc = src?.split(/[?#]/)[0]?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromSrc) return fromSrc.toLowerCase();
  const m = (mime ?? "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("svg")) return "svg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("avif")) return "avif";
  return "png";
}

export function imageFileName(alt: string | undefined, mime?: string, src?: string, hash?: string): string {
  const ext = imageFileExtension(mime, alt, src);
  const raw = (alt ?? "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80);
  const base = raw && !raw.includes(".") ? raw : raw.replace(/\.[a-z0-9]{2,5}$/i, "");
  return `${base || (hash ? `image-${hash.slice(0, 8)}` : "image")}.${ext}`;
}

function saveBlobUrl(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return Uint8Array.from(raw as ArrayLike<number>);
}

/** 笔记内图片的下载：先取到字节，再走**保存对话框**（外链不允许跨域读取时明确报错，不静默丢到 Downloads）。 */
export async function downloadNoteImage(opts: {
  src: string;
  alt?: string;
  hash?: string | null;
  mime?: string | null;
}): Promise<void> {
  const name = imageFileName(opts.alt, opts.mime ?? undefined, opts.src, opts.hash ?? undefined);
  try {
    let bytes: Uint8Array;
    if (opts.hash) {
      bytes = toBytes(await api.readAttachmentBytes(opts.hash));
    } else {
      const resp = await fetch(opts.src);
      if (!resp.ok) throw new Error(`读取图片失败（HTTP ${resp.status}）`);
      bytes = new Uint8Array(await resp.arrayBuffer());
    }

    const path = await platform.dialog.save({
      title: "保存图片",
      defaultPath: name,
      filters: [{ name: "图片", extensions: [name.split(".").pop() || "png"] }],
    });
    if (!path) return; // 用户取消目录选择
    try {
      await api.writeBinaryFile(path, Array.from(bytes));
      toast("图片已保存", "success");
      return;
    } catch {
      // Web/PWA 没有本地写盘命令：退回浏览器下载（目录由浏览器设置决定）。
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: opts.mime || "application/octet-stream" }));
      saveBlobUrl(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast("已交给浏览器下载", "success");
    }
  } catch (e) {
    toast(`保存图片失败：${String(e)}。外链图片可能禁止跨域读取，可在浏览器打开原图后另存。`, "error");
  }
}

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useOverlayLayer("imageLightbox", true, onClose);
  useOverlayScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="image-lightbox-overlay" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
      <div className="image-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} draggable={false} />
        <button
          type="button"
          className="image-lightbox-close"
          aria-label="关闭图片预览"
          title="关闭"
          onClick={onClose}
        >
          <XIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 笔记里的一张图片：悬停时出现「查看大图 / 下载」，点大图打开全屏预览。
 * ⚠️ 按钮必须 `preventDefault`（否则 contenteditable 会把焦点抢走、点击被吞）。
 */
export function NoteImage(props: {
  src: string;
  alt: string;
  hash?: string | null;
  mime?: string | null;
  imgClassName?: string;
  style?: React.CSSProperties;
}) {
  const { src, alt, hash, mime, imgClassName, style } = props;
  const [zoom, setZoom] = useState(false);
  const close = useCallback(() => setZoom(false), []);

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <span className="editor-image-hover">
        <img
          src={src}
          alt={alt}
          className={imgClassName}
          style={style}
          draggable={false}
          onError={(e) => e.currentTarget.classList.add("editor-image-broken")}
          onLoad={(e) => e.currentTarget.classList.remove("editor-image-broken")}
        />
        <span className="editor-image-actions">
          <button
            type="button"
            className="editor-image-action"
            aria-label="查看大图"
            title="查看大图"
            onMouseDown={stop}
            onClick={(e) => {
              stop(e);
              setZoom(true);
            }}
          >
            <MaximizeIcon />
          </button>
          <button
            type="button"
            className="editor-image-action"
            aria-label="下载图片"
            title="下载图片"
            onMouseDown={stop}
            onClick={(e) => {
              stop(e);
              void downloadNoteImage({ src, alt, hash, mime });
            }}
          >
            <DownloadIcon />
          </button>
        </span>
      </span>
      {zoom ? <ImageLightbox src={src} alt={alt} onClose={close} /> : null}
    </>
  );
}
