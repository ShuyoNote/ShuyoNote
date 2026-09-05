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
// NOTE: the sync-server + desktop key attachments by 64-hex SHA-256, so we MUST
// output SHA-256 even on http:// (no crypto.subtle). The pure-JS fallback below is
// always correct; FNV is kept only as an unreachable last resort.
function rotr(n: number, b: number): number {
  return (n >>> b) | (n << (32 - b));
}

// Self-contained SHA-256 (no Web Crypto dependency). Returns lowercase 64-hex.
export function sha256Hex(msg: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ] as const;
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = msg.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0);
  const w = new Int32Array(64);
  for (let i = 0; i < paddedLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const dv2 = new DataView(new ArrayBuffer(32));
  for (let i = 0; i < 8; i++) dv2.setUint32(i * 4, h[i]);
  let out = "";
  for (let i = 0; i < 32; i++) out += dv2.getUint8(i).toString(16).padStart(2, "0");
  return out;
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    /* fall through to pure-JS SHA-256 */
  }
  // Pure-JS SHA-256 (always works, even over http://) — matches sync-server/desktop.
  try {
    return sha256Hex(bytes);
  } catch {
    /* unreachable last resort below */
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
  async put(hash: string, data: Uint8Array | Blob): Promise<void> {
    const db = await openDb();
    const storeData = data instanceof Blob ? data : new Uint8Array(data);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readwrite");
      tx.objectStore(BLOB_OS).put(storeData, hash);
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
        const v = req.result as Uint8Array | Blob | undefined;
        if (!v) { resolve(null); return; }
        if (v instanceof Blob) {
          v.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
        } else {
          resolve(new Uint8Array(v as Uint8Array));
        }
      };
      req.onerror = () => reject(req.error);
    });
  },
  /** Return the stored blob as a Blob (zero-copy when stored as Blob) for streaming upload. */
  async getBlob(hash: string): Promise<Blob | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_OS, "readonly");
      const req = tx.objectStore(BLOB_OS).get(hash);
      req.onsuccess = () => {
        const v = req.result as Uint8Array | Blob | undefined;
        if (!v) { resolve(null); return; }
        resolve(v instanceof Blob ? v : new Blob([new Uint8Array(v as Uint8Array)]));
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
            const v = getReq.result as Uint8Array | Blob | undefined;
            if (v) {
              if (v instanceof Blob) {
                v.arrayBuffer().then((ab) => { out.push({ hash: k, bytes: new Uint8Array(ab) }); done++; if (done === keys.length) resolve(out); }).catch(() => { done++; if (done === keys.length) resolve(out); });
              } else {
                out.push({ hash: k, bytes: new Uint8Array(v as Uint8Array) });
                done++;
                if (done === keys.length) resolve(out);
              }
            } else { done++; if (done === keys.length) resolve(out); }
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
