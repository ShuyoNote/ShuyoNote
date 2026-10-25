// Resolve a media node's display URL lazily from the content-addressed blob store.
//
// Images/videos should NOT embed a base64 data-URL in the editor content — that
// bloats the DB snapshot and memory for large files. Instead the node stores a
// stable `hash`; on render we resolve the bytes and create an object URL (Web) or
// the platform asset URL (desktop). The result is recreated on every mount, so it
// survives reload.
//
// ⭐ 2026-10-24（owner 报「图片块同步不正常」）：**桌面也要按 hash 解析** —— 原来只有 Web
// 走 blobStore；桌面直接回落 `src`，而 `src` 是**本机绝对地址**（会随页面同步到别的机器）
// ⇒ 对面永远碎图。现在桌面走 `hash → attachmentPath → convertFileSrc`，本地没字节就先
// `ensureAttachmentBytes`（服务端/对端两条路）再解析一次。顺序与回落全在 `lib/mediaUrl.ts`
// （纯逻辑 + 判据）；这里只负责把平台能力注入进去、管 object URL 的生命周期。
import { useEffect, useState } from "react";
import { blobStore } from "../../lib/platform/blobStore";
import { isDesktopPlatform, platform } from "../../lib/platform";
import { api } from "../../lib/api";
import { ensureAttachmentBytes } from "../../lib/attachmentBytes";
import { resolveMediaUrl } from "../../lib/mediaUrl";

export interface MediaProps {
  hash?: string | null;
  mime?: string | null;
  /** Fallback src used when the hash can't resolve (legacy data-URL / already-local path). */
  src?: string;
  render: (url: string) => React.ReactNode;
}

export function MediaResolver({ hash, mime, src, render }: MediaProps): React.ReactNode {
  const [url, setUrl] = useState<string>(src ?? "");

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(src ?? "");

    if (!hash) {
      // No hash — use the fallback src as-is (legacy content).
      return;
    }

    void resolveMediaUrl(
      { hash, mime, src },
      {
        desktop: isDesktopPlatform(),
        localPathForHash: (h) => api.attachmentPath(h),
        urlForPath: (path) => platform.asset.convertFileSrc(path),
        fetchBytes: (h) => ensureAttachmentBytes(h, { quiet: true }),
        readBlob: (h) => blobStore.get(h),
        objectUrl: (bytes, m) => {
          // `blobStore.get` 回的是 `Uint8Array`；但注入面允许 `ArrayBuffer`（判据两种都喂）
          const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          const buf = new Uint8Array(view.byteLength);
          buf.set(view);
          objectUrl = URL.createObjectURL(
            new Blob([buf], { type: m || "application/octet-stream" }),
          );
          return objectUrl;
        },
      },
    )
      .then((resolved) => {
        if (alive) setUrl(resolved);
      })
      .catch(() => {
        /* 解析失败 ⇒ 保持回落 src（与旧行为一致） */
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hash, mime, src]);

  return <>{render(url)}</>;
}
