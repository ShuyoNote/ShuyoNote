// Browser (non-Tauri) implementation of the Platform drivers.
//
// This makes the app runnable in a plain browser (and, later, any non-Tauri
// WebView such as ArkWeb / Android / iOS) WITHOUT a Rust/SQLite backend:
//   - `executor.invoke` is backed by a *real* SQLite database via sql.js (WASM),
//     persisted to IndexedDB in the browser. Core note CRUD (pages / tags /
//     page-tags / attachments / image saves) runs real SQL; the remaining
//     backend commands return safe, correctly-typed defaults (never throws).
//   - dialog/opener/event/asset/webview use browser-native equivalents.
//
// This is a *portability/demo* backend: feature parity for attachment disk
// storage, sync, encryption, plugins, database lens... still lives in the Rust
// backend. Commands that need it return empty/no-op here so the UI degrades
// gracefully instead of crashing.
import type { Platform } from "./types";
import { SqliteStore, setWasmUrl, setWasmBytesProvider, setDefaultAdapter } from "./sqliteStore";
import { blobStore, contentHash } from "./blobStore";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // avoid stack overflow on large images
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Re-export the sqlite store hooks so a test harness (or another shell) can wire
// the wasm URL + bytes and an fs/memory persist adapter without importing
// sqliteStore directly.
export { SqliteStore, setWasmUrl, setWasmBytesProvider, setDefaultAdapter };

// Wire the browser's bundled sql.js wasm URL into the store (Vite resolves the
// `?url` import to an asset URL). No-op outside the browser where setWasmUrl is
// provided by the test harness instead.
if (typeof window !== "undefined") {
  setWasmUrl(sqlWasmUrl);
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function welcomeContent(): string {
  return JSON.stringify({
    root: {
      children: [
        {
          children: [
            {
              type: "text",
              text: "欢迎使用 ShuyoNote 网页演示版（Web Platform）。",
              detail: 0,
              format: 0,
              mode: "normal",
              style: "",
              version: 1,
            },
          ],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
        },
      ],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}

// Seed a fresh (empty) database with a welcome page + onboarding page + tag.
function seedIfEmpty(store: SqliteStore): void {
  const count = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages")[0]?.n ?? 0;
  if (count > 0) return;
  const wsId = uid();
  const welcomeId = uid();
  const demoId = uid();
  const tagId = uid();
  const now = Date.now();
  store.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
     VALUES (?, ?, NULL, ?, 'page', 0, ?, ?, NULL, ?, ?)`,
    [welcomeId, wsId, "欢迎页", now, now, welcomeContent(), "欢迎使用 ShuyoNote 网页演示版（Web Platform）。"],
  );
  store.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
     VALUES (?, ?, NULL, ?, 'page', 1, ?, ?, NULL, '', ?)`,
    [demoId, wsId, "快速上手", now, now, "点击左侧新建页面，输入内容会自动保存到浏览器本地。"],
  );
  store.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tagId, "入门"]);
  store.run("INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)", [demoId, tagId]);
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function parseOptions(json: unknown): string[] {
  try {
    const v = JSON.parse(str(json));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toAttrDef(row: any) {
  return { id: row.id, name: row.name, attr_type: row.type, options: parseOptions(row.options) };
}

function attrDefById(store: SqliteStore, id: string) {
  const r = store.query("SELECT id, name, type, options FROM attr_defs WHERE id = ?", [id])[0];
  return r ? toAttrDef(r) : null;
}

function dbColumns(store: SqliteStore, dbPageId: string): any[] {
  const rows = store.query(
    `SELECT a.id, a.name, a.type, a.options FROM database_columns dc
     JOIN attr_defs a ON a.id = dc.attr_id
     WHERE dc.db_page_id = ? ORDER BY dc.sort_order ASC, a.name`,
    [dbPageId],
  );
  return rows.map(toAttrDef);
}

function dbRuleOf(store: SqliteStore, dbPageId: string): string {
  const r = store.query("SELECT db_rule FROM pages WHERE id = ?", [dbPageId])[0];
  const v = r && r.db_rule ? String(r.db_rule) : "{}";
  return v && v.trim() ? v : "{}";
}

// Evaluate a rule JSON `{ "prop":{name,value}, "tag":"name" }` (AND) → matching page ids.
function matchingPageIds(store: SqliteStore, rule: string): string[] | null {
  const trimmed = rule.trim();
  if (!trimmed || trimmed === "{}") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  let all: string[] | null = null;
  const intersect = (next: string[]) => {
    all = all === null ? next : all.filter((id) => next.includes(id));
  };
  if (parsed.prop && parsed.prop.name) {
    const name = String(parsed.prop.name);
    const value = String(parsed.prop.value ?? "");
    const ids = store
      .query("SELECT pp.page_id FROM page_props pp JOIN attr_defs a ON a.id = pp.attr_id WHERE a.name = ? AND pp.value = ?", [name, value])
      .map((r) => String((r as any).page_id));
    intersect(ids);
  }
  if (parsed.tag) {
    const ids = store
      .query("SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?", [String(parsed.tag)])
      .map((r) => String((r as any).page_id));
    intersect(ids);
  }
  return all;
}

function pageTagsJoined(store: SqliteStore, pageId: string): string {
  return store
    .query("SELECT t.name FROM tags t JOIN page_tags pt ON pt.tag_id = t.id WHERE pt.page_id = ? ORDER BY t.name", [pageId])
    .map((r) => String((r as any).name))
    .join(", ");
}

function resolveRefLabels(store: SqliteStore, values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    if (v.startsWith("p:")) {
      const pid = v.slice(2);
      const r = store.query("SELECT title FROM pages WHERE id = ? AND deleted_at IS NULL", [pid])[0];
      out[v] = r ? `⇄ ${String((r as any).title)}` : "已失效引用";
    } else {
      out[v] = v;
    }
  }
  return out;
}

// Snapshot a page's content into page_versions before it is mutated. Dedups
// identical consecutive snapshots and caps history at MAX per page.
const MAX_VERSIONS_PER_PAGE = 50;
function snapshotBeforeSave(store: SqliteStore, pageId: string, title: string, contentJson: string, contentText: string): void {
  const last = store.query<{ title: string; content_json: string; content_text: string }>(
    "SELECT title, content_json, content_text FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1",
    [pageId],
  )[0];
  if (last && last.title === title && last.content_json === contentJson && last.content_text === contentText) return;
  const id = uid();
  store.run("INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id, pageId, title ?? "", contentJson ?? "", contentText ?? "", Date.now(),
  ]);
  // Cap history: keep the newest MAX per page.
  store.run(
    "DELETE FROM page_versions WHERE page_id = ? AND id NOT IN (SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?)",
    [pageId, pageId, MAX_VERSIONS_PER_PAGE],
  );
}

function toPageVersion(row: any) {
  return { id: row.id, page_id: row.page_id, title: row.title, content_text: row.content_text, created_at: row.created_at };
}

// ---- Browser file picker & download helpers (web platform) ----
// Because the browser has no filesystem paths, we bridge the path-string API
// with a session registry keyed by the file's base name. `dialog.open` reads a
// File into memory (registered by name) and returns that name as a "path";
// `read_text_file`/`import_attachment_files` look it up there. `dialog.save`
// returns the default name, and `write_text_file` turns it into a real download.
const fileRegistry = new Map<string, { bytes: Uint8Array; mime: string; name: string }>();

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function pickBrowserFiles(options: { multiple?: boolean; directory?: boolean; accept?: string }): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!options.multiple;
    if (!options.directory && options.accept) input.accept = options.accept;
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = () => {
      input.remove();
      document.body.removeChild(input);
    };
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const names: string[] = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        // Register by both the file name and a stable synthetic path so the
        // path-string API can resolve it later.
        fileRegistry.set(f.name, { bytes, mime: f.type || "application/octet-stream", name: f.name });
        names.push(f.name);
      }
      cleanup();
      resolve(options.multiple ? names : names[0] ?? null);
    };
    input.oncancel = () => {
      cleanup();
      resolve(null);
    };
    input.click();
  });
}

function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  // Copy into a clean ArrayBuffer so Blob typing is satisfied (TS7 strict).
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const blob = new Blob([buf.buffer], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadText(name: string, text: string): void {
  downloadBytes(name, new TextEncoder().encode(text), "text/plain;charset=utf-8");
}

// ---- The executor. Core CRUD runs real SQL; everything else degrades safely. ----

function makeInvoke(store: SqliteStore) {
  // Workspace is single-user in the browser demo; its settings live in a KV row.
  const WS_KEY = "active";
  const getWs = () =>
    store.query<{ id: string; name: string; theme: string | null; icon: string }>(
      "SELECT id, name, theme, icon FROM workspaces WHERE id = ?",
      [WS_KEY],
    )[0] ?? null;

  const seedWorkspaceMeta = () => {
    const ws = getWs();
    if (!ws) {
      store.run("INSERT INTO workspaces (id, name, theme, icon) VALUES (?, ?, NULL, '')", [WS_KEY, "我的工作空间"]);
    }
  };

  return async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const a = (args ?? {}) as Record<string, any>;
    seedWorkspaceMeta();

    // ---- Core note CRUD (real SQL) ----
    if (cmd === "list_pages") {
      const rows = store.query(
        `SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at
         FROM pages WHERE deleted_at IS NULL ORDER BY sort_order, created_at`,
      );
      return rows as T;
    }
    if (cmd === "get_page") {
      const rows = store.query("SELECT * FROM pages WHERE id = ?", [a.id]);
      return (rows[0] ?? null) as T;
    }
    if (cmd === "create_page" || cmd === "create_folder" || cmd === "create_database") {
      const kind = cmd === "create_folder" ? "folder" : cmd === "create_database" ? "database" : "page";
      const id = uid();
      const wsId = getWs()?.id ?? WS_KEY;
      const now = Date.now();
      const title = kind === "folder" ? "新建文件夹" : kind === "database" ? "新建数据库" : "未命名";
      store.run(
        `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
        [id, wsId, a.parent_id ?? null, title, kind, now, now, a.content_json ?? "", a.content_text ?? ""],
      );
      return store.query("SELECT * FROM pages WHERE id = ?", [id])[0] as T;
    }
    if (cmd === "save_page") {
      const p = store.query<{ id: string }>("SELECT id FROM pages WHERE id = ?", [a.id])[0];
      if (p) {
        // Snapshot the current content BEFORE we overwrite it (version history).
        snapshotBeforeSave(store, a.id, str(a.title ?? p.id), str(a.content_json ?? ""), str(a.content_text ?? ""));
        store.run(
          `UPDATE pages SET title = ?, content_json = ?, content_text = ?, updated_at = ?
           WHERE id = ?`,
          [str(a.title ?? p.id), str(a.content_json ?? ""), str(a.content_text ?? ""), Date.now(), a.id],
        );
        return store.query("SELECT * FROM pages WHERE id = ?", [a.id])[0] as T;
      }
      return null as T;
    }
    if (cmd === "delete_page" || cmd === "purge_page") {
      store.run("UPDATE pages SET deleted_at = ? WHERE id = ?", [Date.now(), a.id]);
      return undefined as T;
    }
    if (cmd === "restore_page") {
      store.run("UPDATE pages SET deleted_at = NULL WHERE id = ?", [a.id]);
      return undefined as T;
    }
    if (cmd === "move_page") {
      const p = store.query<{ id: string }>("SELECT id FROM pages WHERE id = ?", [a.id])[0];
      if (p) {
        store.run("UPDATE pages SET parent_id = ?, sort_order = ? WHERE id = ?", [
          a.new_parent_id ?? null,
          typeof a.sort_order === "number" ? a.sort_order : 0,
          a.id,
        ]);
      }
      return undefined as T;
    }
    if (cmd === "list_deleted") {
      return store.query(
        `SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at
         FROM pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at`,
      ) as T;
    }

    // ---- Workspaces (single-user demo) ----
    if (cmd === "list_workspaces") {
      const ws = getWs();
      return [
        {
          id: ws?.id ?? WS_KEY,
          name: ws?.name ?? "我的工作空间",
          theme: ws?.theme,
          icon: ws?.icon,
          sort_order: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ] as T;
    }
    if (cmd === "get_workspace_name") return (getWs()?.name ?? "我的工作空间") as T;
    if (cmd === "get_active_workspace_id") return (getWs()?.id ?? WS_KEY) as T;
    if (cmd === "set_active_workspace_id") return undefined as T;
    if (cmd === "rename_workspace") {
      if (typeof a.name === "string") {
        store.run("UPDATE workspaces SET name = ? WHERE id = ?", [a.name, WS_KEY]);
      }
      return undefined as T;
    }
    if (cmd === "set_workspace_settings") {
      store.run("UPDATE workspaces SET theme = ?, icon = ? WHERE id = ?", [
        typeof a.theme === "string" ? a.theme : null,
        typeof a.icon === "string" ? a.icon : "",
        WS_KEY,
      ]);
      return undefined as T;
    }
    if (cmd === "create_workspace") {
      return { id: uid(), name: String(a.name ?? "新工作空间"), created_at: Date.now(), updated_at: Date.now() } as T;
    }
    if (cmd === "copy_page_to_workspace" || cmd === "delete_workspace") return undefined as T;

    // ---- Tags (real SQL) ----
    if (cmd === "list_tags") {
      return store.query(
        `SELECT t.id, t.name, COUNT(pt.page_id) AS page_count
         FROM tags t LEFT JOIN page_tags pt ON pt.tag_id = t.id
         GROUP BY t.id, t.name ORDER BY t.name`,
      ) as T;
    }
    if (cmd === "create_tag") {
      const tag = { id: uid(), name: String(a.name ?? "新标签") };
      store.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tag.id, tag.name]);
      return tag as T;
    }
    if (cmd === "rename_tag") {
      store.run("UPDATE tags SET name = ? WHERE id = ?", [str(a.name), a.id]);
      const row = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE id = ?", [a.id])[0];
      return (row ?? null) as T;
    }
    if (cmd === "delete_tag") {
      store.run("DELETE FROM page_tags WHERE tag_id = ?", [a.id]);
      store.run("DELETE FROM tags WHERE id = ?", [a.id]);
      return undefined as T;
    }
    if (cmd === "add_tag") {
      if (typeof a.page_id === "string" && typeof a.tag_id === "string") {
        const exists = store.query("SELECT 1 AS ok FROM page_tags WHERE page_id = ? AND tag_id = ?", [a.page_id, a.tag_id])[0];
        if (!exists) {
          store.run("INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)", [a.page_id, a.tag_id]);
        }
      }
      return undefined as T;
    }
    if (cmd === "remove_tag") {
      store.run("DELETE FROM page_tags WHERE page_id = ? AND tag_id = ?", [a.page_id, a.tag_id]);
      return undefined as T;
    }
    if (cmd === "page_tags") {
      return store.query(
        `SELECT t.id, t.name FROM tags t
         JOIN page_tags pt ON pt.tag_id = t.id WHERE pt.page_id = ? ORDER BY t.name`,
        [a.page_id],
      ) as T;
    }
    if (cmd === "pages_by_tag") {
      return store.query(
        `SELECT p.id, p.workspace_id, p.parent_id, p.title, p.kind, p.sort_order, p.created_at, p.updated_at, p.deleted_at
         FROM pages p JOIN page_tags pt ON pt.page_id = p.id
         WHERE pt.tag_id = ? AND p.deleted_at IS NULL`,
        [a.tag_id],
      ) as T;
    }

    // ---- Search (SQL LIKE over title + text) ----
    if (cmd === "search") {
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? a.query ?? "").toLowerCase();
      const lim = Number(req.limit ?? a.limit ?? 50);
      if (!query) return [] as T;
      const like = `%${query}%`;
      const rows = store.query(
        `SELECT id, title, content_text FROM pages
         WHERE deleted_at IS NULL AND (LOWER(title) LIKE ? OR LOWER(content_text) LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`,
        [like, like, lim],
      );
      return rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        snippet: String(r.content_text ?? "").slice(0, 120),
        space: getWs()?.name ?? "",
      })) as T;
    }
    if (cmd === "search_blocks") {
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? "").toLowerCase();
      if (!query) return [] as T;
      const like = `%${query}%`;
      const rows = store.query("SELECT id, title, content_text FROM pages WHERE deleted_at IS NULL AND LOWER(content_text) LIKE ?", [like]);
      return rows.map((r: any) => ({ block_id: "", page_id: r.id, page_title: r.title, snippet: String(r.content_text ?? "").slice(0, 120) })) as T;
    }
    if (cmd === "get_backlinks" || cmd === "list_block_backlinks") return [] as T;
    if (cmd === "resolve_block") return { block_id: "", page_id: "", page_title: "", snippet: "", content: "" } as T;
    if (cmd === "get_page_blocks") return [] as T;

    // ---- Graph (nodes from non-deleted pages) ----
    if (cmd === "get_graph") {
      const rows = store.query("SELECT id, title FROM pages WHERE deleted_at IS NULL");
      return { pages: rows.map((r: any) => ({ id: r.id, title: r.title, tags: [], props: [] })), edges: [], blocks: [], block_edges: [] } as T;
    }

    // ---- Attachments (bytes in IndexedDB blob store; SQLite holds metadata only,
    //      so the DB never bloats with base64 as images grow) ----
    if (cmd === "save_image") {
      const data = (a.data as number[]) ?? [];
      const bytes = new Uint8Array(data);
      const mime = String(a.mime || "image/png");
      const name = String(a.name ?? "image.png");
      const hash = await contentHash(bytes);
      await blobStore.put(hash, bytes);
      // Durable, self-contained URL for immediate display (survives reload).
      const path = `data:${mime};base64,${bytesToBase64(bytes)}`;
      const att = { id: uid(), name, hash, mime, size: data.length, path };
      const existing = store.query("SELECT id FROM attachments WHERE hash = ?", [hash])[0];
      if (!existing) {
        store.run("INSERT INTO attachments (id, name, hash, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)", [
          att.id, att.name, att.hash, att.mime, att.size, "",
        ]);
      }
      return att as T;
    }
    if (cmd === "attachment_path") {
      const rows = store.query("SELECT path, hash, mime FROM attachments WHERE hash = ?", [a.hash]);
      if (rows[0] && rows[0].path) return (rows[0].path as string) as T;
      const bytes = await blobStore.get(String(a.hash));
      if (bytes) {
        const mime = String(rows[0]?.mime ?? "image/png");
        return (`data:${mime};base64,${bytesToBase64(bytes)}`) as T;
      }
      return "" as T;
    }
    if (cmd === "get_attachment") return null as T;
    if (cmd === "list_page_attachments") {
      const rows = store.query("SELECT * FROM attachments");
      // Resolve a display path from the byte store (which survives reload) so the
      // file-manager previews/images render even after a refresh.
      const resolved = await Promise.all(
        rows.map(async (r: any) => {
          if (r.path) return r;
          const bytes = await blobStore.get(String(r.hash));
          if (!bytes) return r;
          return { ...r, path: `data:${r.mime};base64,${bytesToBase64(bytes)}` };
        }),
      );
      return resolved as T;
    }
    if (cmd === "import_attachment_files") {
      // paths are file names registered by dialog.open → blobStore, metadata row.
      const paths = (a.paths ?? []).map(String);
      const metas = [];
      for (const p of paths) {
        const reg = fileRegistry.get(baseName(p));
        if (!reg) continue;
        const hash = await contentHash(reg.bytes);
        await blobStore.put(hash, reg.bytes);
        const att = { id: uid(), name: reg.name, hash, mime: reg.mime, size: reg.bytes.length, path: "" };
        const existing = store.query("SELECT id FROM attachments WHERE hash = ?", [hash])[0];
        if (!existing) {
          store.run("INSERT INTO attachments (id, name, hash, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)", [
            att.id, att.name, att.hash, att.mime, att.size, "",
          ]);
        }
        fileRegistry.delete(baseName(p));
        metas.push(att);
      }
      return metas as T;
    }
    if (cmd === "copy_attachment") {
      // Copy an attachment's bytes to a save location (download in the browser).
      const rows = store.query("SELECT hash, name, mime FROM attachments WHERE hash = ?", [a.hash ?? a.hash]);
      if (rows[0]) {
        const bytes = await blobStore.get(String((rows[0] as any).hash));
        if (bytes) downloadBytes(String((rows[0] as any).name ?? "file"), bytes, String((rows[0] as any).mime ?? ""));
      }
      return undefined as T;
    }
    if (cmd === "remove_attachment" || cmd === "move_attachment") return undefined as T;
    if (cmd === "remove_attachments") return 0 as T;
    if (cmd === "restore_attachment") return null as T;

    // ---- Bookmark metadata (browser can't fetch OG reliably; return the URL) ----
    if (cmd === "fetch_bookmark_metadata") {
      const url = String(a.url ?? "");
      return { url, title: url, description: "", site_name: "", image_hash: "", image_mime: "" } as T;
    }

    // ---- Properties / attributes / database ----
    if (cmd === "list_attr_defs") {
      const rows = store.query("SELECT id, name, type, options FROM attr_defs ORDER BY name");
      return rows.map(toAttrDef) as T;
    }
    if (cmd === "create_attr") {
      const args = a.args ?? {};
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("属性名不能为空");
      const exists = store.query("SELECT COUNT(*) AS n FROM attr_defs WHERE name = ?", [name])[0]?.n ?? 0;
      if (Number(exists) > 0) throw new Error("属性已存在");
      const attrType = String(args.attr_type ?? "text");
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      const id = uid();
      const now = Date.now();
      store.run("INSERT INTO attr_defs (id, name, type, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
        id, name, attrType, JSON.stringify(options), now, now,
      ]);
      return { id, name, attr_type: attrType, options } as T;
    }
    if (cmd === "update_attr") {
      const args = a.args ?? {};
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      store.run("UPDATE attr_defs SET options = ?, updated_at = ? WHERE id = ?", [JSON.stringify(options), Date.now(), args.id]);
      const row = store.query("SELECT id, name, type, options FROM attr_defs WHERE id = ?", [args.id])[0];
      if (!row) throw new Error("属性不存在");
      return toAttrDef(row) as T;
    }
    if (cmd === "delete_attr") {
      store.run("DELETE FROM page_props WHERE attr_id = ?", [a.id]);
      store.run("DELETE FROM database_columns WHERE attr_id = ?", [a.id]);
      store.run("DELETE FROM attr_defs WHERE id = ?", [a.id]);
      return undefined as T;
    }
    if (cmd === "set_page_prop") {
      const args = a.args ?? {};
      store.run(
        "INSERT INTO page_props (page_id, attr_id, value) VALUES (?, ?, ?) ON CONFLICT(page_id, attr_id) DO UPDATE SET value = excluded.value",
        [args.page_id, args.attr_id, String(args.value ?? "")],
      );
      return undefined as T;
    }
    if (cmd === "remove_page_prop") {
      store.run("DELETE FROM page_props WHERE page_id = ? AND attr_id = ?", [a.pageId ?? a.page_id, a.attrId ?? a.attr_id]);
      return undefined as T;
    }
    if (cmd === "get_page_props") {
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const props = store
        .query(
          "SELECT a.id, a.name, a.type, a.options, p.value FROM page_props p JOIN attr_defs a ON a.id = p.attr_id WHERE p.page_id = ? AND a.type != 'tag'",
          [pageId],
        )
        .map((r: any) => ({ attr_id: r.id, name: r.name, attr_type: r.type, options: parseOptions(r.options), value: r.value }));
      const tagRows = store.query("SELECT id, name, type, options FROM attr_defs WHERE type = 'tag' ORDER BY name");
      const joined = pageTagsJoined(store, pageId);
      for (const t of tagRows as any[]) {
        props.push({ attr_id: t.id, name: t.name, attr_type: t.type, options: parseOptions(t.options), value: joined });
      }
      props.sort((x, y) => x.name.localeCompare(y.name));
      return props as T;
    }
    if (cmd === "get_db_columns") return dbColumns(store, String(a.dbPageId ?? a.db_page_id ?? "")) as T;
    if (cmd === "add_db_column") {
      const args = a.args ?? {};
      const dbPageId = String(args.db_page_id ?? "");
      const attrId = String(args.attr_id ?? "");
      const idx = store.query<{ n: number }>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM database_columns WHERE db_page_id = ?", [dbPageId])[0]?.n ?? 1;
      store.run("INSERT OR IGNORE INTO database_columns (db_page_id, attr_id, sort_order) VALUES (?, ?, ?)", [dbPageId, attrId, idx]);
      return dbColumns(store, dbPageId) as T;
    }
    if (cmd === "remove_db_column") {
      const args = a.args ?? {};
      store.run("DELETE FROM database_columns WHERE db_page_id = ? AND attr_id = ?", [args.db_page_id, args.attr_id]);
      return dbColumns(store, String(args.db_page_id ?? "")) as T;
    }
    if (cmd === "query_database") {
      const dbPageId = String(a.dbPageId ?? a.db_page_id ?? "");
      const columns = dbColumns(store, dbPageId);
      const attrIds = columns.map((c) => c.id);
      const pages = store.query("SELECT id, title FROM pages WHERE kind = 'page' AND deleted_at IS NULL ORDER BY updated_at DESC");
      const allProps = store.query("SELECT page_id, attr_id, value FROM page_props");
      const propMap: Record<string, Record<string, string>> = {};
      for (const p of allProps as any[]) {
        if (attrIds.includes(p.attr_id)) (propMap[p.page_id] ??= {})[p.attr_id] = String(p.value ?? "");
      }
      const rows = pages.map((pg: any) => ({ page_id: pg.id, title: pg.title, values: propMap[pg.id] ?? {} }));
      // tag columns read from the real tags system.
      const tagCols = columns.filter((c) => c.attr_type === "tag").map((c) => c.id);
      if (tagCols.length > 0) {
        const tagRows = store.query("SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id ORDER BY t.name");
        const tagMap: Record<string, string[]> = {};
        for (const tr of tagRows as any[]) (tagMap[tr.page_id] ??= []).push(String(tr.name));
        for (const row of rows) {
          const names = tagMap[row.page_id];
          if (names) for (const colId of tagCols) row.values[colId] = names.join(", ");
        }
      }
      // membership rule (query-type database): keep matching pages only.
      const rule = dbRuleOf(store, dbPageId);
      const match = matchingPageIds(store, rule);
      if (match) {
        return { columns, rows: rows.filter((r) => match.includes(r.page_id)) } as T;
      }
      return { columns, rows } as T;
    }
    if (cmd === "list_db_views") {
      const rows = store.query("SELECT id, db_page_id, name, view_type, config, sort_order, created_at FROM db_views WHERE db_page_id = ? ORDER BY sort_order ASC, created_at ASC", [a.dbPageId ?? a.db_page_id ?? ""]);
      return rows as T;
    }
    if (cmd === "save_db_view") {
      const args = a.args ?? {};
      const id = uid();
      const now = Date.now();
      const next = store.query<{ n: number }>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM db_views WHERE db_page_id = ?", [args.db_page_id])[0]?.n ?? 1;
      store.run("INSERT INTO db_views (id, db_page_id, name, view_type, config, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        id, String(args.db_page_id ?? ""), String(args.name ?? ""), String(args.view_type ?? ""), String(args.config ?? ""), next, now,
      ]);
      return { id, db_page_id: String(args.db_page_id), name: String(args.name), view_type: String(args.view_type), config: String(args.config), sort_order: next, created_at: now } as T;
    }
    if (cmd === "delete_db_view") {
      store.run("DELETE FROM db_views WHERE id = ?", [a.id]);
      return undefined as T;
    }
    if (cmd === "set_db_rule") {
      try {
        JSON.parse(String(a.rule ?? "{}"));
      } catch {
        throw new Error("规则格式错误");
      }
      store.run("UPDATE pages SET db_rule = ? WHERE id = ? AND kind = 'database'", [String(a.rule ?? "{}"), a.dbPageId ?? a.db_page_id ?? ""]);
      return undefined as T;
    }
    if (cmd === "get_db_rule") return dbRuleOf(store, String(a.dbPageId ?? a.db_page_id ?? "")) as T;
    if (cmd === "resolve_refs") return resolveRefLabels(store, (a.values ?? []).map(String)) as T;
    if (cmd === "board_data") {
      const tags = store.query("SELECT id, name FROM tags ORDER BY name");
      const columns = tags.map((t: any) => {
        const pageIds = store.query("SELECT page_id FROM page_tags WHERE tag_id = ?", [t.id]).map((r) => String((r as any).page_id));
        const pages = pageIds.length
          ? store.query(
              "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at FROM pages WHERE deleted_at IS NULL AND id IN (" + pageIds.map(() => "?").join(",") + ")",
              pageIds,
            )
          : [];
        return { tag: { id: t.id, name: t.name }, pages };
      });
      return columns as T;
    }
    if (cmd === "board_by_attr") {
      const attrId = String(a.attrId ?? a.attr_id ?? "");
      const def = attrDefById(store, attrId);
      if (!def) throw new Error("属性不存在");
      const options = def.options;
      const pages = store.query("SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at FROM pages WHERE kind = 'page' AND deleted_at IS NULL");
      const values = store.query("SELECT page_id, value FROM page_props WHERE attr_id = ?", [attrId]);
      const valMap: Record<string, string> = {};
      for (const v of values as any[]) valMap[v.page_id] = String(v.value ?? "");
      const groups = options.map((o) => ({ id: o, name: o, pages: [] as any[] }));
      const unset: any[] = [];
      for (const pg of pages as any[]) {
        const v = valMap[pg.id];
        if (v && v.length > 0) {
          const g = groups.find((x) => x.id === v);
          if (g) g.pages.push(pg);
        } else {
          unset.push(pg);
        }
      }
      groups.push({ id: "__none", name: "未设置", pages: unset });
      return groups as T;
    }
    if (cmd === "move_card") {
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const tagId = String(a.tagId ?? a.tag_id ?? "");
      store.run("DELETE FROM page_tags WHERE page_id = ?", [pageId]);
      if (tagId) store.run("INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)", [pageId, tagId]);
      return undefined as T;
    }

    // ---- Templates (built-in demos) ----
    if (cmd === "list_templates") {
      const now = Date.now();
      const base = { built_in: 1, space_id: null, sort_order: 0, created_at: now, updated_at: now };
      return [
        {
          ...base, id: uid(), name: "会议纪要", category: "效率", kind: "page", icon: "📝", cover: "",
          summary: "会议主题 / 结论 / 待办的标准结构。",
          content_json: '{"root":{"children":[{"children":[{"type":"text","text":"会议主题","detail":0,"format":0,"mode":"normal","style":"","version":1}],"direction":"ltr","format":"","indent":0,"type":"heading","tag":"h1","version":1},{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}',
          content_text: "会议主题",
        },
        {
          ...base, id: uid(), name: "读书笔记", category: "学习", kind: "page", icon: "📚", cover: "",
          summary: "书名 / 金句 / 思考的模板。",
          content_json: '{"root":{"children":[{"children":[{"type":"text","text":"书名","detail":0,"format":0,"mode":"normal","style":"","version":1}],"direction":"ltr","format":"","indent":0,"type":"heading","tag":"h1","version":1},{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}',
          content_text: "书名",
        },
      ] as T;
    }

    // ---- Plugins ----
    if (cmd === "list_plugins") return [] as T;
    if (cmd === "open_plugin_dir") return "" as T;
    if (cmd === "run_plugin_command") return { message: "", insert: null } as T;

    // ---- Sync ----
    if (cmd === "get_sync_config") return { server_url: "", token: "", device_id: "", last_pushed_seq: 0, last_pulled_seq: 0 } as T;
    if (cmd === "set_sync_config") return undefined as T;
    if (cmd === "sync_now") return { pushed: 0, pulled: 0, last_pushed_seq: 0, last_pulled_seq: 0 } as T;

    // ---- Encryption ----
    if (cmd === "encryption_status") return { enabled: false, locked: false } as T;
    if (cmd === "set_encryption" || cmd === "lock_encryption" || cmd === "unlock_encryption" || cmd === "disable_encryption") {
      return undefined as T;
    }

    // ---- Storage / cleanup ----
    if (cmd === "storage_stats") {
      const trash = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL")[0]?.n ?? 0;
      const atts = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM attachments")[0]?.n ?? 0;
      const versions = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")[0]?.n ?? 0;
      return {
        db_bytes: 0, attachment_bytes: 0, attachment_count: atts,
        trash_count: trash, trash_bytes: 0, version_count: versions,
        version_bytes: 0, deleted_workspace_count: 0, temp_bytes: 0,
      } as T;
    }
    if (cmd === "clear_trash") {
      store.run("DELETE FROM pages WHERE deleted_at IS NOT NULL");
      return 0 as T;
    }
    if (cmd === "cleanup_orphan_attachments" || cmd === "cleanup_temp_files") return 0 as T;
    if (cmd === "cleanup_old_versions") {
      const maxKeep = Number(a.maxKeep ?? 50);
      const before = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")[0]?.n ?? 0;
      store.run(
        `DELETE FROM page_versions WHERE id NOT IN (
           SELECT id FROM page_versions pv
           WHERE (SELECT COUNT(*) FROM page_versions v2 WHERE v2.page_id = pv.page_id AND v2.created_at >= pv.created_at) <= ?
         )`,
        [maxKeep],
      );
      const after = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")[0]?.n ?? 0;
      return (before - after) as T;
    }
    if (cmd === "purge_deleted_workspaces") return { freed: 0, workspaces: 0 } as T;

    // ---- Versions ----
    if (cmd === "list_versions") {
      const rows = store.query(
        "SELECT id, page_id, title, content_text, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 100",
        [a.pageId ?? a.page_id ?? ""],
      );
      return rows.map(toPageVersion) as T;
    }
    if (cmd === "restore_version") {
      const r = store.query<{ page_id: string; title: string; content_json: string; content_text: string }>(
        "SELECT page_id, title, content_json, content_text FROM page_versions WHERE id = ?",
        [a.versionId ?? a.id ?? ""],
      )[0];
      if (!r) throw new Error("版本不存在");
      store.run("UPDATE pages SET title = ?, content_json = ?, content_text = ?, updated_at = ? WHERE id = ?", [
        r.title, r.content_json, r.content_text, Date.now(), r.page_id,
      ]);
      return store.query("SELECT * FROM pages WHERE id = ?", [r.page_id])[0] as T;
    }

    // ---- Backup / export / import (browser: no-op, no real file I/O) ----
    if (cmd === "export_backup") return { path: "", size: 0 } as T;
    if (cmd === "import_backup") return undefined as T;
    if (cmd === "export_workspace") return { path: "", size: 0, pages: 0, attachments: 0 } as T;
    if (cmd === "import_workspace") return null as T;
    if (cmd === "write_text_file") {
      // Write text to a browser-side "file": trigger a real download named after
      // the target so content actually leaves the browser.
      const path = String(a.path ?? "output.txt");
      const content = String(a.content ?? "");
      if (typeof document !== "undefined") downloadText(baseName(path), content);
      // Register in-memory so later reads (same session) can round-trip.
      fileRegistry.set(baseName(path), { bytes: new TextEncoder().encode(content), mime: "text/plain;charset=utf-8", name: baseName(path) });
      return undefined as T;
    }
    if (cmd === "read_text_file") {
      const reg = fileRegistry.get(baseName(String(a.path ?? "")));
      if (reg) return new TextDecoder().decode(reg.bytes) as T;
      return "" as T;
    }
    if (cmd === "open_page_window") return undefined as T;

    // ---- Persistent storage ----
    // Ask the browser to mark this origin as persistent so it won't auto-evict
    // the database (which would lose the user's notes). Returns the outcome and
    // the current quota/usage so the UI can surface it.
    if (cmd === "request_persistent_storage") {
      return (await requestPersistentStorage()) as T;
    }

    // ---- Unknown: return an empty object so the UI never crashes ----
    return {} as T;
  };
}

// ---- Shared store + lazy init (async wasm load) ----

let sharedInit: Promise<SqliteStore> | null = null;

function getSharedStore(): Promise<SqliteStore> {
  if (!sharedInit) {
    const store = new SqliteStore();
    sharedInit = store.init().then(() => {
      seedIfEmpty(store);
      return store;
    });
  }
  return sharedInit;
}

function invokeWhenReady<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return getSharedStore()
    .then((store) => makeInvoke(store)<T>(cmd, args))
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[web] invoke error", cmd, e);
      throw e;
    });
}

// Result of a persistent-storage request: whether the browser granted it, and
// the current quota/usage (so the app can show "X used of Y").
export interface PersistentStorageInfo {
  persisted: boolean;
  persistedBefore: boolean;
  quota: number; // bytes
  usage: number; // bytes
  supported: boolean;
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

async function requestPersistentStorage(): Promise<{
  persisted: boolean;
  persistedBefore: boolean;
  quota: number;
  usage: number;
  supported: boolean;
}> {
  const storage = typeof navigator !== "undefined" ? (navigator as any).storage : undefined;
  if (!storage || typeof storage.persisted !== "function") {
    return {
      persisted: false,
      persistedBefore: false,
      quota: 0,
      usage: 0,
      supported: false,
    };
  }
  try {
    const persistedBefore = Boolean(await storage.persisted());
    // Advance: request persistence so the browser won't evict our notes DB.
    const persisted = (await storage.persist()) || persistedBefore;
    const est = (await storage.estimate()) ?? {};
    return {
      persisted,
      persistedBefore,
      quota: Number(est.quota ?? 0),
      usage: Number(est.usage ?? 0),
      supported: true,
    };
  } catch {
    return {
      persisted: false,
      persistedBefore: false,
      quota: 0,
      usage: 0,
      supported: true,
    };
  }
}

/** Human-readable helper for surfaces that want a "持久化" label. */
export function formatPersistentSummary(info: PersistentStorageInfo): string {
  const used = humanBytes(info.usage);
  const quota = humanBytes(info.quota);
  if (!info.supported) return "浏览器不支持持久化存储";
  if (info.persisted) return `已持久化（${used} / ${quota}）`;
  return `未持久化（${used} / ${quota}）`;
}

// Request persistence as soon as the Web platform loads (fire-and-forget). This
// is keyed on the same module so it runs once per page.
if (typeof window !== "undefined") {
  requestPersistentStorage().catch(() => {});
}

export function createWebPlatform(): Platform {
  return {
    executor: {
      invoke: <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
        invokeWhenReady<T>(cmd, args),
    },
    dialog: {
      open: async (options) => {
        // Non-browser (Node test) or `directory` has no browser mapping.
        if (typeof document === "undefined") return null;
        if (options.directory) return null;
        const accept =
          options.filters && options.filters.length > 0
            ? options.filters.map((f) => f.extensions.map((e) => "." + e).join(",")).join(",")
            : undefined;
        return pickBrowserFiles({ multiple: options.multiple, accept });
      },
      save: async (options) => {
        // Non-browser returns null; browser returns the default name.
        if (typeof document === "undefined") return null;
        return options.defaultPath ?? null;
      },
    },
    opener: {
      openUrl: async (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      openPath: async () => {},
      revealItemInDir: async () => {},
    },
    event: {
      listen: async () => () => {},
    },
    asset: {
      convertFileSrc: (path) => path,
    },
    webview: {
      onDragDropEvent: async () => () => {},
    },
  };
}

