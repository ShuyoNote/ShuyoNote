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
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

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
    if (cmd === "resolve_refs") return {} as T;
    if (cmd === "get_backlinks" || cmd === "list_block_backlinks") return [] as T;
    if (cmd === "resolve_block") return { block_id: "", page_id: "", page_title: "", snippet: "", content: "" } as T;
    if (cmd === "get_page_blocks") return [] as T;

    // ---- Graph (nodes from non-deleted pages) ----
    if (cmd === "get_graph") {
      const rows = store.query("SELECT id, title FROM pages WHERE deleted_at IS NULL");
      return { pages: rows.map((r: any) => ({ id: r.id, title: r.title, tags: [], props: [] })), edges: [], blocks: [], block_edges: [] } as T;
    }

    // ---- Attachments (data-URI backed so pasted images preview) ----
    if (cmd === "save_image") {
      const data = (a.data as number[]) ?? [];
      const mime = String(a.mime || "image/png");
      const name = String(a.name ?? "image.png");
      const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
      const path = `data:${mime};base64,${base64}`;
      const att = { id: uid(), name, hash: uid(), mime, size: data.length, path };
      store.run("INSERT INTO attachments (id, name, hash, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)", [
        att.id, att.name, att.hash, att.mime, att.size, att.path,
      ]);
      return att as T;
    }
    if (cmd === "attachment_path") {
      const rows = store.query("SELECT path FROM attachments WHERE hash = ?", [a.hash]);
      return (rows[0]?.path ?? "") as T;
    }
    if (cmd === "get_attachment") return null as T;
    if (cmd === "list_page_attachments") {
      return store.query("SELECT * FROM attachments") as T;
    }
    if (cmd === "import_attachment_files") return [] as T;
    if (cmd === "remove_attachment" || cmd === "move_attachment" || cmd === "copy_attachment") return undefined as T;
    if (cmd === "remove_attachments") return 0 as T;
    if (cmd === "restore_attachment") return null as T;

    // ---- Bookmark metadata (browser can't fetch OG reliably; return the URL) ----
    if (cmd === "fetch_bookmark_metadata") {
      const url = String(a.url ?? "");
      return { url, title: url, description: "", site_name: "", image_hash: "", image_mime: "" } as T;
    }

    // ---- Properties / attributes / database ----
    if (cmd === "list_attr_defs" || cmd === "get_page_props" || cmd === "get_db_columns") return [] as T;
    if (cmd === "query_database") return { columns: [], rows: [] } as T;
    if (cmd === "list_db_views") return [] as T;
    if (cmd === "board_data" || cmd === "board_by_attr") return [] as T;
    if (cmd === "get_db_rule") return "" as T;
    if (cmd === "set_db_rule" || cmd === "set_page_prop" || cmd === "remove_page_prop" || cmd === "move_card") {
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
      const pages = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL")[0]?.n ?? 0;
      const trash = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL")[0]?.n ?? 0;
      const atts = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM attachments")[0]?.n ?? 0;
      return {
        db_bytes: 0, attachment_bytes: 0, attachment_count: atts,
        trash_count: trash, trash_bytes: 0, version_count: pages,
        version_bytes: 0, deleted_workspace_count: 0, temp_bytes: 0,
      } as T;
    }
    if (cmd === "clear_trash") {
      store.run("DELETE FROM pages WHERE deleted_at IS NOT NULL");
      return 0 as T;
    }
    if (cmd === "cleanup_orphan_attachments" || cmd === "cleanup_old_versions" || cmd === "cleanup_temp_files") return 0 as T;
    if (cmd === "purge_deleted_workspaces") return { freed: 0, workspaces: 0 } as T;

    // ---- Versions ----
    if (cmd === "list_versions") return [] as T;
    if (cmd === "restore_version") return null as T;

    // ---- Backup / export / import (browser: no-op, no real file I/O) ----
    if (cmd === "export_backup") return { path: "", size: 0 } as T;
    if (cmd === "import_backup") return undefined as T;
    if (cmd === "export_workspace") return { path: "", size: 0, pages: 0, attachments: 0 } as T;
    if (cmd === "import_workspace") return null as T;
    if (cmd === "write_text_file") return undefined as T;
    if (cmd === "read_text_file") return "" as T;
    if (cmd === "open_page_window") return undefined as T;

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

export function createWebPlatform(): Platform {
  return {
    executor: {
      invoke: <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
        invokeWhenReady<T>(cmd, args),
    },
    dialog: {
      open: async () => null,
      save: async () => null,
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

