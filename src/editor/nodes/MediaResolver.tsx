// Resolve a media node's display URL lazily from the content-addressed blob store.
//
// Images/videos should NOT embed a base64 data-URL in the editor content — that
// bloats the DB snapshot and memory for large files. Instead the node stores a
// stable `hash`; on render we fetch the bytes from blobStore and create an object
// URL (Blob URL). A blob URL is session-scoped but we recreate it on every mount,
// so it survives reload. When `hash` is unknown (legacy content or a platform
// without the blob store, e.g. desktop which stores bytes on disk and passes a
// real path via `src`), we fall back to the provided `src` directly.
import { useEffect, useState } from "react";
import { blobStore } from "../../lib/platform/blobStore";

export interface MediaProps {
  hash?: string | null;
  mime?: string | null;
  /** Fallback src used when the hash can't resolve (desktop path, legacy data-URL). */
  src?: string;
  render: (url: string) => React.ReactNode;
}

export function MediaResolver({ hash, mime, src, render }: MediaProps): React.ReactNode {
  const [url, setUrl] = useState<string>(src ?? "");

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(src ?? "");

    if (hash) {
      blobStore
        .get(hash)
        .then((bytes) => {
          if (!alive || !bytes) return;
          const buf = new Uint8Array(bytes.byteLength);
          buf.set(bytes);
          objectUrl = URL.createObjectURL(new Blob([buf], { type: mime || "application/octet-stream" }));
          setUrl(objectUrl);
        })
        .catch(() => {});
    } else {
      // No hash — use the fallback src as-is.
      setUrl(src ?? "");
    }

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hash, mime, src]);

  return <>{render(url)}</>;
}
