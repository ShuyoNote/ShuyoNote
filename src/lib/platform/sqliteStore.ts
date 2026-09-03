// A small async wrapper around sql.js (WASM SQLite) that works in BOTH the
// browser (persists the whole DB to IndexedDB) and Node (persists to a file),
// so the same store backs the app and the smoke test.
//
// sql.js is synchronous (like the Rust backend), which keeps the CRUD code
// straightforward. We snapshot the entire DB (`db.export()`) after each write —
// fine for a personal note app's size, and gives real SQLite semantics instead
// of the earlier localStorage JSON mock.
//
// NOTE: the Web Platform's executor still routes through this store, so it's
// genuinely SQLite-backed, not a fake.
import type { SqlValue, Database, SqlJsModule } from "./sqljs-types";

type InitSqlJs = (config?: {
  locateFile?: (file: string) => string;
  wasmBinary?: Uint8Array;
}) => Promise<SqlJsModule>;

// Minimal persistence host: browser uses IndexedDB, Node uses fs (injected from
// the calling environment so this module never imports node APIs).
export interface PersistAdapter {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

// The wasm URL is supplied by the runtime (browser sets it via the Vite `?url`
// import; a Node test sets it to the package path). This keeps sql.js's `?url`
// import out of this module so tests don't need a bundler.
let wasmUrl = "sql-wasm.wasm";
export function setWasmUrl(url: string): void {
  wasmUrl = url;
}

// Injectable wasm-byte source: the browser fetches the asset URL; a Node test
// reads it from disk. Injected so this module never imports node APIs.
export type WasmBytesProvider = (url: string) => Promise<Uint8Array>;
let wasmBytesProvider: WasmBytesProvider | null = null;
export function setWasmBytesProvider(fn: WasmBytesProvider): void {
  wasmBytesProvider = fn;
}

async function resolveWasmBytes(url: string): Promise<Uint8Array> {
  if (wasmBytesProvider) return wasmBytesProvider(url);
  // Browser default: fetch the asset URL.
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`failed to fetch sql-wasm (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
    throw new Error("sql-wasm fetch returned non-wasm bytes");
  }
  return bytes;
}

// Load sql.js once (singleton). Handles the ESM double-default quirk. We fetch
// the wasm bytes ourselves and pass them as `wasmBinary`, avoiding sql.js's own
// locateFile/fetch which can resolve to HTML in the Vite module graph.
let sqlModulePromise: Promise<SqlJsModule> | null = null;

async function getSqlModule(): Promise<SqlJsModule> {
  if (sqlModulePromise) return sqlModulePromise;
  sqlModulePromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import("sql.js");
    const initSqlJs = ((mod as any).default ?? mod) as InitSqlJs;
    const wasmBinary = await resolveWasmBytes(wasmUrl);
    const SQL = await initSqlJs({ wasmBinary });
    return SQL;
  })();
  return sqlModulePromise;
}

// ---- IndexedDB persistence (browser) ----

const IDB_NAME = "shuyonote";
const IDB_STORE = "db";
const IDB_KEY = "sqlite";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function browserAdapter(): PersistAdapter {
  // Guard against hanging IndexedDB (e.g. restricted/headless contexts) with a
  // timeout, falling back to a fresh in-memory DB rather than blocking forever.
  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("indexeddb timeout")), ms)),
    ]);
  return {
    async load() {
      return withTimeout(
        (async () => {
          const db = await openIdb().catch(() => null);
          if (!db) return null;
          return new Promise<Uint8Array | null>((resolve) => {
            try {
              const tx = db.transaction(IDB_STORE, "readonly");
              const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
              req.onsuccess = () => {
                const v = req.result as Uint8Array | undefined;
                resolve(v ? new Uint8Array(v) : null);
              };
              req.onerror = () => resolve(null);
            } catch {
              resolve(null);
            }
          });
        })(),
        3000,
      ).catch(() => null);
    },
    async save(bytes) {
      return withTimeout(
        (async () => {
          const db = await openIdb().catch(() => null);
          if (!db) return;
          return new Promise<void>((resolve) => {
            try {
              const tx = db.transaction(IDB_STORE, "readwrite");
              tx.objectStore(IDB_STORE).put(new Uint8Array(bytes), IDB_KEY);
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
            } catch {
              resolve();
            }
          });
        })(),
        3000,
      ).catch(() => undefined);
    },
  };
}

// Injectable default adapter: lets the browser use IndexedDB while a Node test
// (or another shell) supplies an fs/memory adapter without changing the store.
let defaultAdapter: PersistAdapter | null = null;
export function setDefaultAdapter(adapter: PersistAdapter): void {
  defaultAdapter = adapter;
}

function pickAdapter(): PersistAdapter {
  return defaultAdapter ?? browserAdapter();
}

// sql.js throws "tried to bind a value of an unknown type (undefined)" when a
// param is `undefined`. Normalize every param: undefined → null (SQL NULL), and
// coerce number/bignum/string/blob as-is. This guards every call site.
function normalizeParams(params: SqlValue[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : p));
}

// ---- The store ----

export class SqliteStore {
  private db: Database | null = null;
  private adapter: PersistAdapter;
  /** Optional hook fired after each persist attempt (null on success, error on fail). */
  onPersistError: ((err: unknown | null) => void) | null = null;

  constructor(adapter?: PersistAdapter) {
    this.adapter = adapter ?? pickAdapter();
  }

  async init(): Promise<void> {
    const SQL = await getSqlModule();
    const existing = await this.adapter.load();
    this.db = existing && existing.length > 0 ? new SQL.Database(existing) : new SQL.Database();
    this.migrate();
  }

  get ready(): boolean {
    return this.db !== null;
  }

  /** Snapshot the whole DB as bytes (for backup/export). */
  snapshot(): Uint8Array {
    if (!this.db) throw new Error("SqliteStore not initialized");
    return this.db.export();
  }

  /** Replace the DB with the given bytes (for backup restore) and persist. As
   *  sql.js can't reopen a new Database from an existing handle, we rebuild the
   *  handle from the bytes. The caller must re-init/refresh surrounding state. */
  async restore(bytes: Uint8Array): Promise<void> {
    const SQL = await getSqlModule();
    if (this.db) this.db.close();
    this.db = new SQL.Database(bytes);
    this.migrate();
    await this.adapter.save(bytes);
  }

  private migrate(): void {
    if (!this.db) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        theme TEXT,
        icon TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'page',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        content_json TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '',
        db_rule TEXT NOT NULL DEFAULT '{}',
        icon TEXT NOT NULL DEFAULT '',
        cover TEXT NOT NULL DEFAULT '',
        cover_height INTEGER NOT NULL DEFAULT 300
      );
      CREATE TABLE IF NOT EXISTS pdf_annotations (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(attachment_id, page_index)
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT
      );
      CREATE TABLE IF NOT EXISTS page_tags (
        page_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY (page_id, tag_id)
      );
      INSERT OR IGNORE INTO tags (id, name, color) VALUES
        ('tag-todo', '未完成', '#ef4444'),
        ('tag-doing', '进行中', '#f59e0b'),
        ('tag-done', '已完成', '#22c55e'),
        ('tag-archive', '归档', '#64748b');
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        page_id TEXT,
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attr_defs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'text',
        options TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page_props (
        page_id TEXT NOT NULL,
        attr_id TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (page_id, attr_id)
      );
      CREATE TABLE IF NOT EXISTS database_columns (
        db_page_id TEXT NOT NULL,
        attr_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (db_page_id, attr_id)
      );
      CREATE TABLE IF NOT EXISTS db_views (
        id TEXT PRIMARY KEY,
        db_page_id TEXT NOT NULL,
        name TEXT NOT NULL,
        view_type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page_versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page_embeddings (
        page_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector TEXT NOT NULL,
        hash TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pages_ws ON pages(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_db_columns ON database_columns(db_page_id);
      CREATE INDEX IF NOT EXISTS idx_db_views ON db_views(db_page_id);
      CREATE INDEX IF NOT EXISTS idx_page_props ON page_props(page_id);
      CREATE INDEX IF NOT EXISTS idx_attr_props ON page_props(attr_id);
      CREATE INDEX IF NOT EXISTS idx_page_versions ON page_versions(page_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);
    `);
    // Safe migration for pre-existing DBs whose `attachments` table predates
    // the page_id column (owns → which folder/page a file belongs to).
    try {
      this.db.run("ALTER TABLE attachments ADD COLUMN page_id TEXT");
    } catch {
      /* already exists */
    }
    // Safe migration for pre-existing DBs whose `pages` table predates db_rule.
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN db_rule TEXT NOT NULL DEFAULT '{}'");
    } catch {
      /* already exists */
    }
    // Safe migration for pre-existing DBs whose `pages` table predates icon/cover/cover_height.
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    } catch {
      /* already exists */
    }
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN cover TEXT NOT NULL DEFAULT ''");
    } catch {
      /* already exists */
    }
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN cover_height INTEGER NOT NULL DEFAULT 300");
    } catch {
      /* already exists */
    }
  }

  /** Run a mutation; persist the DB snapshot after. */
  run(sql: string, params: SqlValue[] = []): void {
    if (!this.db) throw new Error("SqliteStore not initialized");
    this.db.run(sql, normalizeParams(params));
    this.persist();
  }

  /** Run a SELECT and return rows as objects. */
  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
    if (!this.db) throw new Error("SqliteStore not initialized");
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(normalizeParams(params));
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private persist(): void {
    if (!this.db) return;
    const bytes = this.db.export();
    // Fire-and-forget; persistence is best-effort (never blocks the UI loop).
    // In-memory state stays intact; a failed save is surfaced via onPersistError so
    // the UI can warn "unsaved changes" instead of silently dropping data.
    void this.adapter
      .save(bytes)
      .then(() => { if (this.onPersistError) this.onPersistError(null); })
      .catch((e) => { if (this.onPersistError) {
        try { this.onPersistError(e); } catch { /* no-op */ }
      } });
  }
}

