import { create } from "zustand";

// Binaries + metadata for multi-space support on the Web platform.
//
// The Web platform uses a single live SqliteStore (sql.js) which at any moment
// holds ONE workspace's database. To support multiple workspaces side by side
// we keep a separate IndexedDB catalog that stores, per workspace id:
//   - the workspace metadata (name/theme/icon/order),
//   - a full DB snapshot (Uint8Array) of that workspace's data.
//
// Switching workspaces = snapshot the live store's current DB under the current
// id, then restore the target id's snapshot into the live store. The live store's
// own default adapter also persists the active DB, so a reload keeps it intact.
const SPACE_DB = "shuyonote-spaces";
const CATALOG_OS = "catalog"; // key = workspace id → WorkspaceMeta
const SNAP_OS = "snapshots";  // key = workspace id → Uint8Array (DB snapshot)
const KV_OS = "kv";           // key = "active" → active workspace id

export interface SpaceMeta {
  id: string;
  name: string;
  theme: string | null;
  icon: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function openDb(createStore: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SPACE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CATALOG_OS)) db.createObjectStore(CATALOG_OS);
      if (!db.objectStoreNames.contains(SNAP_OS)) db.createObjectStore(SNAP_OS);
      if (!db.objectStoreNames.contains(KV_OS)) db.createObjectStore(KV_OS);
      createStore(db);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readOne<T>(os: string, key: string): Promise<T> {
  return new Promise((resolve) => {
    openDb(() => {}).then((db) => {
      try {
        const tx = db.transaction(os, "readonly");
        const req = tx.objectStore(os).get(key);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => resolve(null as T);
      } catch {
        resolve(null as T);
      }
    }).catch(() => resolve(null as T));
  });
}

function writeOne(os: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    openDb(() => {}).then((db) => {
      try {
        const tx = db.transaction(os, "readwrite");
        tx.objectStore(os).put(value as any, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    }).catch(() => resolve());
  });
}

function deleteOne(os: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    openDb(() => {}).then((db) => {
      try {
        const tx = db.transaction(os, "readwrite");
        tx.objectStore(os).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    }).catch(() => resolve());
  });
}

function readAll<T>(os: string): Promise<T[]> {
  return new Promise((resolve) => {
    openDb(() => {}).then((db) => {
      try {
        const tx = db.transaction(os, "readonly");
        const req = tx.objectStore(os).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as T[]);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    }).catch(() => resolve([]));
  });
}

// zustand store mirroring the live state so the platform layer and (optionally)
// UI can read active id / space list synchronously after a reload.
interface SpaceCatalogState {
  activeId: string | null;
  /** Current in-memory copy of the catalog (loaded on boot). */
  loaded: boolean;
  setActiveId: (id: string | null) => void;
  markLoaded: () => void;
}
export const useSpaceCatalog = create<SpaceCatalogState>((set) => ({
  activeId: null,
  loaded: false,
  setActiveId: (id) => set({ activeId: id }),
  markLoaded: () => set({ loaded: true }),
}));

export const spaceStore = {
  /** Load all workspace metas from the catalog. */
  async listMetas(): Promise<SpaceMeta[]> {
    const metas = await readAll<SpaceMeta>(CATALOG_OS);
    return metas.sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
  },
  async getMeta(id: string): Promise<SpaceMeta | null> {
    return readOne<SpaceMeta>(CATALOG_OS, id);
  },
  async putMeta(meta: SpaceMeta): Promise<void> {
    await writeOne(CATALOG_OS, meta.id, meta);
  },
  async deleteMeta(id: string): Promise<void> {
    await deleteOne(CATALOG_OS, id);
  },

  async getActiveId(): Promise<string | null> {
    return readOne<string>(KV_OS, "active");
  },
  async setActiveId(id: string): Promise<void> {
    await writeOne(KV_OS, "active", id);
    useSpaceCatalog.getState().setActiveId(id);
  },

  async getSnapshot(id: string): Promise<Uint8Array | null> {
    const v = await readOne<Uint8Array>(SNAP_OS, id);
    return v ? new Uint8Array(v) : null;
  },
  async putSnapshot(id: string, bytes: Uint8Array): Promise<void> {
    await writeOne(SNAP_OS, id, new Uint8Array(bytes));
  },
  async deleteSnapshot(id: string): Promise<void> {
    await deleteOne(SNAP_OS, id);
  },

  /** Remove every record for a workspace (meta + snapshot). */
  async purge(id: string): Promise<void> {
    await this.deleteMeta(id);
    await this.deleteSnapshot(id);
  },
};
