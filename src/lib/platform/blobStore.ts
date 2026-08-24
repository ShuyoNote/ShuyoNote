// Binary blob store for content-addressed attachment bytes (images/video/audio).
//
// The Web platform keeps attachment *bytes* OUT of the SQLite database (which
// only stores id/name/hash/mime/size metadata) and in an IndexedDB object store
// keyed by content hash. This mirrors the desktop model (bytes on disk, DB only
// references them) and prevents the DB from bloating with base64 as images grow.
//
// The hash is content-addressed (a 32-byte hex digest over the bytes), so the
// same bytes store once and dedupe across pages.
//
// NOTE: this uses its OWN database name, distinct from the SQLite store's DB
// (which is also "shuyonote" but uses the "db" object store). Sharing one DB
// name across two stores at the same version means whichever opens first wins
// the upgrade, and the other's object store is never created → NotFoundError on
// transaction. A separate DB name isolates them cleanly.
const BLOB_DB = "shuyonote-blobs";
const BLOB_OS = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLOB_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BLOB_OS)) {
        req.result.createObjectStore(BLOB_OS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// FNV-1a-ish quick content fingerprint. For the demo this is enough to dedupe by
// content; a stronger hash would use crypto.subtle.digest (async). We jump to
// SHA-256 when available, falling back to an FNV-1a 64-bit hex digest otherwise.
export async function contentHash(bytes: Uint8Array): Promise<string> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    /* fall through to FNV */
  }
  // FNV-1a 64-bit (two 32-bit halves) — not cryptographic, fine for dedupe only.
  let lo = 0x811c9dc5;
  let hi = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    lo ^= bytes[i];
    lo = Math.imul(lo, 0x01000193);
    hi = Math.imul(hi, 0x01000193) ^ (lo >>> 0);
  }
  return (
    (hi >>> 0).toString(16).padStart(8, "0") +
    (lo >>> 0).toString(16).padStart(8, "0")
  );
}

export const blobStore = {
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readwrite");
      tx.objectStore(BLOB_OS).put(new Uint8Array(bytes), hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async get(hash: string): Promise<Uint8Array | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readonly");
      const req = tx.objectStore(BLOB_OS).get(hash);
      req.onsuccess = () => {
        const v = req.result as Uint8Array | undefined;
        resolve(v ? new Uint8Array(v) : null);
      };
      req.onerror = () => reject(req.error);
    });
  },
  async has(hash: string): Promise<boolean> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readonly");
      const req = tx.objectStore(BLOB_OS).getKey(hash);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    });
  },
  /** Remove a blob entry (used when an attachment's bytes have no remaining refs). */
  async delete(hash: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readwrite");
      tx.objectStore(BLOB_OS).delete(hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  /** Enumerate all (hash, bytes) for backup/export. */
  async entries(): Promise<{ hash: string; bytes: Uint8Array }[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readonly");
      const store = tx.objectStore(BLOB_OS);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = (keysReq.result ?? []) as string[];
        if (keys.length === 0) {
          resolve([]);
          return;
        }
        const out: { hash: string; bytes: Uint8Array }[] = [];
        let done = 0;
        for (const k of keys) {
          const getReq = store.get(k);
          getReq.onsuccess = () => {
            const v = getReq.result as Uint8Array | undefined;
            if (v) out.push({ hash: k, bytes: new Uint8Array(v) });
            done++;
            if (done === keys.length) resolve(out);
          };
          getReq.onerror = () => {
            done++;
            if (done === keys.length) resolve(out);
          };
        }
      };
      keysReq.onerror = () => reject(keysReq.error);
    });
  },
};
