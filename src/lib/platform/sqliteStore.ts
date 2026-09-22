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
import { DERIVED_SCHEMA_DDL } from "../extract/schema";
import { createAttachmentTextStore } from "../extract/store";
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
  /** 事务嵌套深度；> 0 时 `persist()` 挂起（由最外层 `transaction()` 统一快照一次）。 */
  private persistDepth = 0;
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
        cover_height INTEGER NOT NULL DEFAULT 300,
        cover_pos REAL NOT NULL DEFAULT 50,
        sync_seq INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        -- 阶段 1（B1）：正文列"待重建"（合并/裁决之后由补算器重建）。本地状态：不同步、不进导出。
        text_stale INTEGER NOT NULL DEFAULT 0
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
        color TEXT,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS page_tags (
        page_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY (page_id, tag_id)
      );
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
        sort_order INTEGER NOT NULL DEFAULT 0,
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
      -- 阶段 1 · 冲突留痕（本地表，不同步/不进备份导出）：远端应用时报出的"同一块被两端改过"。
      -- ⚠️ 只是**本机证据**，不能解释跨机器差异：别的设备上可能没有这一行，服务端也没有这张表。
      CREATE TABLE IF NOT EXISTS page_conflicts (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        local_json TEXT NOT NULL DEFAULT '',
        remote_json TEXT NOT NULL DEFAULT '',
        detected_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_choice TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_page_conflicts_page ON page_conflicts(page_id, resolved_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id);
      -- Sync engine tables (S8: per-workspace profiles / auth sessions / change log).
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_seq INTEGER NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_profiles (
        ws_id TEXT PRIMARY KEY,
        server_url TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        space_id TEXT NOT NULL DEFAULT '',
        last_pushed_seq INTEGER NOT NULL DEFAULT 0,
        last_pulled_seq INTEGER NOT NULL DEFAULT 0,
        -- P6.1「每空间开关」：1 = 同步附件字节（默认）；0 = 只同步元数据、字节按需。
        sync_attachments INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        server_url TEXT PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        token TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      -- C1/C2 设备级设置（2026-09-15）：与桌面同名的 KV 表（桌面是 meta.sync_state）。
      -- 目前只放预算刹车与「仅 Wi-Fi」这几个键；做成 KV 而不是建专表，是为了以后
      -- 再加设备级开关时**不用再来一次迁移**。
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // 派生文本层（「全库 AI 覆盖」方案 §6.1）：`attachment_text` / `chunks` / `chunk_embeddings`。
    //
    // **DDL 不在这里重抄一遍**，而是从 `src/lib/extract/schema.ts` 取——那是 TS 侧的单一事实源。
    // 理由（见方案 §6.1）：桌面（Rust `db.rs`）与 Web 都要建这三张表，**两份 DDL 漂移的后果是
    // "同一份数据在两个平台上读不出来"，而且不会有任何编译期报错**。
    //
    // 分层上这是"平台层 import 了功能模块"，看着略反常；但按仓库既有做法，表结构本来就集中声明在
    // 这个 migrate() 里（`page_embeddings` 就是这样）。为了不出现"TS 里也写两份"，选择 import 而非复制。
    for (const stmt of DERIVED_SCHEMA_DDL) this.db.run(stmt);
    // P6.1「每空间开关」：老浏览器库补列。**`DEFAULT 1` 是有意的**——升级不能静默改变
    // 同步范围（见 docs/plans/2026-09-15-attachment-on-demand-plan.md §五.4）。
    try {
      this.db.run("ALTER TABLE sync_profiles ADD COLUMN sync_attachments INTEGER NOT NULL DEFAULT 1");
    } catch {
      /* already exists */
    }
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
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN cover_pos REAL NOT NULL DEFAULT 50");
    } catch {
      /* already exists */
    }
    // seq-based LWW: sync_seq = last accepted remote change seq; dirty = unsynced
    // local edits (protects local edits from being overwritten on clock drift).
    // See plans/2026-09-09-sync-seq-lww.md.
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    // 阶段 1（B1，2026-09-22）· 正文列"待重建"标记：合并产物 / 冲突裁决之后那一页的正文与索引要按
    // 编辑器语义重算。**本地状态：不同步、不进导出**（与 page_conflicts 同族）。见 `lib/docContent.ts`。
    try {
      this.db.run("ALTER TABLE pages ADD COLUMN text_stale INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    // 旧库的 `tags` 表可能缺 color / sort_order（标签颜色/排序）——补齐列，否则
    // list_tags / 建库时报 "no such column: t.color"。
    try {
      this.db.run("ALTER TABLE tags ADD COLUMN color TEXT");
    } catch {
      /* already exists */
    }
    try {
      this.db.run("ALTER TABLE tags ADD COLUMN sort_order REAL NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    try {
      this.db.run("ALTER TABLE attr_defs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    // 去掉系统预置的三个状态标签（未完成/进行中/已完成）——含旧库已插入的。
    try {
      this.db.run("DELETE FROM page_tags WHERE tag_id IN ('tag-todo','tag-doing','tag-done')");
    } catch {
      /* ignore */
    }
    try {
      this.db.run("DELETE FROM tags WHERE id IN ('tag-todo','tag-doing','tag-done')");
    } catch {
      /* ignore */
    }
  }

  /** 派生文本存储（「全库 AI 覆盖」P1）。表已由上面的 migrate() 建好。
   *
   *  **批量写已收口**：适配器把 `transaction` 透传下去，于是 `replace()` 的
   *  "一次 DELETE + N 次 INSERT" 走本类的 `transaction()` = **一次事务 + 一次全库快照**
   *  （否则是 501 次快照，平方级开销；见 `transaction()` 的说明与方案 §7）。 */
  derivedTextStore() {
    if (!this.db) throw new Error("SqliteStore not initialized");
    return createAttachmentTextStore({
      run: (sql, params = []) => this.run(sql, params as SqlValue[]),
      query: <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
        this.query<T>(sql, params as SqlValue[]),
      transaction: <T>(fn: () => T) => this.transaction(fn),
    });
  }

  /** Run a mutation; persist the DB snapshot after. */
  run(sql: string, params: SqlValue[] = []): void {
    if (!this.db) throw new Error("SqliteStore not initialized");
    this.db.run(sql, normalizeParams(params));
    this.persist();
  }

  /**
   * 把一组写操作包成**一次事务 + 一次快照**。
   *
   * 为什么需要它（实测成本，方案 §7）：`run()` 每写一条就 `db.export()` 全库快照。
   * 而派生文本落库是"一次 DELETE + N 次 INSERT"，**一份抽 500 段的文档 = 501 次全库快照**，
   * 全库抽取时是平方级开销 —— 慢到不可用。
   *
   * 语义：
   *  - 进入时 `BEGIN`、并把 persist **挂起**（`run()` 不再逐条快照）；
   *  - 正常退出时 `COMMIT` + **只快照一次**；
   *  - 抛错时 `ROLLBACK` **并仍快照一次**——把已经成功落库的部分保留住（回滚的是未提交的那次事务），
   *    而不是让内存状态与磁盘快照长期不一致。
   *  - **可重入**：只有最外层发 `BEGIN/COMMIT`（SQLite 不允许嵌套 `BEGIN`，实测会直接报错）。
   *  - ⚠️ **嵌套是"扁平"语义，不是 SAVEPOINT**：内层失败会冒泡到最外层**一起回滚**。
   *    需要"内层失败但外层继续"的语义得用 SAVEPOINT，本类暂不提供（没有这个需求，加了反而复杂）。
   */
  transaction<T>(fn: () => T): T {
    if (!this.db) throw new Error("SqliteStore not initialized");
    const outermost = this.persistDepth === 0;
    if (outermost) this.db.run("BEGIN");
    this.persistDepth++;
    try {
      const r = fn();
      if (outermost) this.db.run("COMMIT");
      return r;
    } catch (e) {
      if (outermost) {
        try {
          this.db.run("ROLLBACK");
        } catch {
          /* 回滚失败也要把快照落下去，否则磁盘上会停在一个更旧的状态 */
        }
      }
      throw e;
    } finally {
      this.persistDepth--;
      if (this.persistDepth === 0) this.persist();
    }
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
    // 事务区间内挂起：由 transaction() 在提交时统一快照一次（见那里的成本说明）。
    if (this.persistDepth > 0) return;
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

