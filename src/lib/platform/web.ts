// Browser (non-Tauri) implementation of the Platform drivers.
//
// This makes the app runnable in a plain browser (and, later, any non-Tauri
// WebView such as ArkWeb / Android / iOS) WITHOUT a Rust/SQLite backend:
//   - `executor.invoke` is backed by a localStorage-persisted in-memory store
//     that implements the core note CRUD and returns safe, correctly-typed
//     defaults (never throws) for the remaining backend commands.
//   - dialog/opener/event/asset/webview use browser-native equivalents.
//
// This is a *demo/portability* backend: full feature parity (attachments on
// disk, sync, encryption, plugins, database lens...) still lives in the Rust
// backend. Commands that need it return empty/no-op here so the UI degrades
// gracefully instead of crashing.
import type { Platform } from "./types";

const STORAGE_KEY = "shuyonote.web.v1";

interface MockPage {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  content_json: string;
  content_text: string;
}

interface MockDb {
  workspaceId: string;
  workspaceName: string;
  workspaceTheme: string | null;
  workspaceIcon: string;
  pages: MockPage[];
  tags: { id: string; name: string }[];
  pageTags: { page_id: string; tag_id: string }[];
  attachments: { id: string; name: string; hash: string; mime: string; size: number; path: string }[];
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

function seed(): MockDb {
  const id = uid();
  const demoId = uid();
  const readTagId = uid();
  const now = Date.now();
  return {
    workspaceId: id,
    workspaceName: "我的工作空间",
    workspaceTheme: null,
    workspaceIcon: "",
    pages: [
      {
        id,
        workspace_id: id,
        parent_id: null,
        title: "欢迎页",
        kind: "page",
        sort_order: 0,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        content_json: welcomeContent(),
        content_text: "欢迎使用 ShuyoNote 网页演示版（Web Platform）。",
      },
      {
        id: demoId,
        workspace_id: id,
        parent_id: null,
        title: "快速上手",
        kind: "page",
        sort_order: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        content_json: "",
        content_text: "点击左侧新建页面，输入内容会自动保存到浏览器本地。",
      },
    ],
    tags: [{ id: readTagId, name: "入门" }],
    pageTags: [{ page_id: demoId, tag_id: readTagId }],
    attachments: [],
  };
}

function loadDb(): MockDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb;
      if (parsed && parsed.workspaceId && Array.isArray(parsed.pages)) return parsed;
    }
  } catch {
    /* fall through to seed */
  }
  const db = seed();
  saveDb(db);
  return db;
}

function saveDb(db: MockDb): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* quota/storage unavailable — keep in-memory only */
  }
}

// --- Helpers to build the various DTOs returned by backend commands ---

function toPageMeta(p: MockPage) {
  return {
    id: p.id,
    workspace_id: p.workspace_id,
    parent_id: p.parent_id,
    title: p.title,
    kind: p.kind,
    sort_order: p.sort_order,
    created_at: p.created_at,
    updated_at: p.updated_at,
    deleted_at: p.deleted_at,
  };
}

function toPageDetail(p: MockPage) {
  return {
    id: p.id,
    workspace_id: p.workspace_id,
    parent_id: p.parent_id,
    title: p.title,
    content_json: p.content_json,
    content_text: p.content_text,
    kind: p.kind,
    sort_order: p.sort_order,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

// The executor. Returns a safe, correctly-typed default for every command the app
// might dispatch, and never throws (the UI degrades gracefully for Tauri-only
// features). Core note CRUD persists to localStorage.
function makeInvoke(db: MockDb) {
  return async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const a = (args ?? {}) as Record<string, any>;

    // ---- Core note CRUD (persisted) ----
    if (cmd === "list_pages") {
      return db.pages.filter((p) => p.deleted_at === null).map(toPageMeta) as T;
    }
    if (cmd === "get_page") {
      const p = db.pages.find((x) => x.id === a.id);
      return (p ? toPageDetail(p) : null) as T;
    }
    if (cmd === "create_page" || cmd === "create_folder" || cmd === "create_database") {
      const kind = cmd === "create_folder" ? "folder" : cmd === "create_database" ? "database" : "page";
      const now = Date.now();
      const page: MockPage = {
        id: uid(),
        workspace_id: db.workspaceId,
        parent_id: a.parent_id ?? null,
        title: kind === "folder" ? "新建文件夹" : kind === "database" ? "新建数据库" : "未命名",
        kind,
        sort_order: db.pages.length,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        content_json: a.content_json ?? "",
        content_text: a.content_text ?? "",
      };
      db.pages.push(page);
      saveDb(db);
      return toPageDetail(page) as T;
    }
    if (cmd === "save_page") {
      const p = db.pages.find((x) => x.id === a.id);
      if (p) {
        if (typeof a.title === "string") p.title = a.title;
        if (typeof a.content_json === "string") p.content_json = a.content_json;
        if (typeof a.content_text === "string") p.content_text = a.content_text;
        p.updated_at = Date.now();
        saveDb(db);
      }
      return (p ? toPageDetail(p) : null) as T;
    }
    if (cmd === "delete_page" || cmd === "purge_page") {
      const p = db.pages.find((x) => x.id === a.id);
      if (p) p.deleted_at = Date.now();
      saveDb(db);
      return undefined as T;
    }
    if (cmd === "restore_page") {
      const p = db.pages.find((x) => x.id === a.id);
      if (p) p.deleted_at = null;
      saveDb(db);
      return undefined as T;
    }
    if (cmd === "move_page") {
      const p = db.pages.find((x) => x.id === a.id);
      if (p) {
        if (a.new_parent_id !== undefined) p.parent_id = a.new_parent_id;
        if (typeof a.sort_order === "number") p.sort_order = a.sort_order;
        saveDb(db);
      }
      return undefined as T;
    }
    if (cmd === "list_deleted") {
      return db.pages.filter((p) => p.deleted_at !== null).map(toPageMeta) as T;
    }

    // ---- Workspaces ----
    if (cmd === "list_workspaces") {
      return [
        {
          id: db.workspaceId,
          name: db.workspaceName,
          theme: db.workspaceTheme,
          icon: db.workspaceIcon,
          sort_order: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ] as T;
    }
    if (cmd === "get_workspace_name") return db.workspaceName as T;
    if (cmd === "get_active_workspace_id") return db.workspaceId as T;
    if (cmd === "set_active_workspace_id") return undefined as T;
    if (cmd === "rename_workspace") {
      if (typeof a.name === "string") {
        db.workspaceName = a.name;
        saveDb(db);
      }
      return undefined as T;
    }
    if (cmd === "set_workspace_settings") {
      if (typeof a.theme === "string") db.workspaceTheme = a.theme || null;
      if (typeof a.icon === "string") db.workspaceIcon = a.icon || "";
      saveDb(db);
      return undefined as T;
    }
    if (cmd === "create_workspace") {
      const ws = {
        id: uid(),
        name: String(a.name ?? "新工作空间"),
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      return ws as T;
    }
    if (cmd === "copy_page_to_workspace" || cmd === "delete_workspace") {
      return undefined as T;
    }

    // ---- Tags ----
    if (cmd === "list_tags") {
      return db.tags.map((t) => ({
        id: t.id,
        name: t.name,
        page_count: db.pageTags.filter((x) => x.tag_id === t.id).length,
      })) as T;
    }
    if (cmd === "create_tag") {
      const tag = { id: uid(), name: String(a.name ?? "新标签") };
      db.tags.push(tag);
      saveDb(db);
      return tag as T;
    }
    if (cmd === "rename_tag") {
      const t = db.tags.find((x) => x.id === a.id);
      if (t && typeof a.name === "string") {
        t.name = a.name;
        saveDb(db);
      }
      return (t ? { id: t.id, name: t.name } : null) as T;
    }
    if (cmd === "delete_tag") {
      db.tags = db.tags.filter((x) => x.id !== a.id);
      db.pageTags = db.pageTags.filter((x) => x.tag_id !== a.id);
      saveDb(db);
      return undefined as T;
    }
    if (cmd === "add_tag") {
      if (typeof a.page_id === "string" && typeof a.tag_id === "string") {
        if (!db.pageTags.some((x) => x.page_id === a.page_id && x.tag_id === a.tag_id)) {
          db.pageTags.push({ page_id: a.page_id, tag_id: a.tag_id });
          saveDb(db);
        }
      }
      return undefined as T;
    }
    if (cmd === "remove_tag") {
      db.pageTags = db.pageTags.filter(
        (x) => !(x.page_id === a.page_id && x.tag_id === a.tag_id),
      );
      saveDb(db);
      return undefined as T;
    }
    if (cmd === "page_tags") {
      const ids = db.pageTags.filter((x) => x.page_id === a.page_id).map((x) => x.tag_id);
      return db.tags.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, name: t.name })) as T;
    }
    if (cmd === "pages_by_tag") {
      const pageIds = db.pageTags.filter((x) => x.tag_id === a.tag_id).map((x) => x.page_id);
      return db.pages
        .filter((p) => p.deleted_at === null && pageIds.includes(p.id))
        .map(toPageMeta) as T;
    }

    // ---- Search (FTS-lite: title + text contains) ----
    if (cmd === "search") {
      const q = String(a.query ?? "").toLowerCase();
      const limit = Number(a.limit ?? 50);
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? q).toLowerCase();
      const lim = Number(req.limit ?? limit);
      if (!query) return [] as T;
      return db.pages
        .filter((p) => p.deleted_at === null)
        .filter((p) => p.title.toLowerCase().includes(query) || p.content_text.toLowerCase().includes(query))
        .slice(0, lim)
        .map((p) => ({ id: p.id, title: p.title, snippet: p.content_text.slice(0, 120), space: db.workspaceName })) as T;
    }
    if (cmd === "search_blocks") {
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? "").toLowerCase();
      if (!query) return [] as T;
      return db.pages
        .filter((p) => p.deleted_at === null && p.content_text.toLowerCase().includes(query))
        .map((p) => ({ block_id: "", page_id: p.id, page_title: p.title, snippet: p.content_text.slice(0, 120) })) as T;
    }
    if (cmd === "resolve_refs") return {} as T;
    if (cmd === "get_backlinks" || cmd === "list_block_backlinks") return [] as T;
    if (cmd === "resolve_block") return { block_id: "", page_id: "", page_title: "", snippet: "", content: "" } as T;
    if (cmd === "get_page_blocks") return [] as T;

    // ---- Graph (nodes from pages; no edges in the browser demo) ----
    if (cmd === "get_graph") {
      const pages = db.pages
        .filter((p) => p.deleted_at === null)
        .map((p) => ({ id: p.id, title: p.title, tags: [], props: [] }));
      return { pages, edges: [], blocks: [], block_edges: [] } as T;
    }

    // ---- Attachments (browser: data-URI backed so pasted images preview) ----
    if (cmd === "save_image") {
      const data = (a.data as number[]) ?? [];
      const mime = String(a.mime || "image/png");
      const name = String(a.name ?? "image.png");
      const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
      const path = `data:${mime};base64,${base64}`;
      const att = { id: uid(), name, hash: uid(), mime, size: data.length, path };
      db.attachments.push(att);
      saveDb(db);
      return att as T;
    }
    if (cmd === "attachment_path") {
      const att = db.attachments.find((x) => x.hash === a.hash);
      return (att ? att.path : "") as T;
    }
    if (cmd === "get_attachment") return null as T;
    if (cmd === "list_page_attachments") return db.attachments as T;
    if (cmd === "import_attachment_files") return [] as T;
    if (cmd === "remove_attachment" || cmd === "move_attachment" || cmd === "copy_attachment") {
      return undefined as T;
    }
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

    // ---- Templates (built-in demos so the template center shows content) ----
    if (cmd === "list_templates") {
      const now = Date.now();
      const base = {
        built_in: 1,
        space_id: null,
        sort_order: 0,
        created_at: now,
        updated_at: now,
      };
      return [
        {
          ...base,
          id: uid(),
          name: "会议纪要",
          category: "效率",
          kind: "page",
          icon: "📝",
          cover: "",
          summary: "会议主题 / 结论 / 待办的标准结构。",
          content_json:
            '{"root":{"children":[{"children":[{"type":"text","text":"会议主题","detail":0,"format":0,"mode":"normal","style":"","version":1}],"direction":"ltr","format":"","indent":0,"type":"heading","tag":"h1","version":1},{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}',
          content_text: "会议主题",
        },
        {
          ...base,
          id: uid(),
          name: "读书笔记",
          category: "学习",
          kind: "page",
          icon: "📚",
          cover: "",
          summary: "书名 / 金句 / 思考的模板。",
          content_json:
            '{"root":{"children":[{"children":[{"type":"text","text":"书名","detail":0,"format":0,"mode":"normal","style":"","version":1}],"direction":"ltr","format":"","indent":0,"type":"heading","tag":"h1","version":1},{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}',
          content_text: "书名",
        },
      ] as T;
    }

    // ---- Plugins ----
    if (cmd === "list_plugins") return [] as T;
    if (cmd === "open_plugin_dir") return "" as T;
    if (cmd === "run_plugin_command") return { message: "", insert: null } as T;

    // ---- Sync ----
    if (cmd === "get_sync_config") {
      return { server_url: "", token: "", device_id: "", last_pushed_seq: 0, last_pulled_seq: 0 } as T;
    }
    if (cmd === "set_sync_config") return undefined as T;
    if (cmd === "sync_now") return { pushed: 0, pulled: 0, last_pushed_seq: 0, last_pulled_seq: 0 } as T;

    // ---- Encryption ----
    if (cmd === "encryption_status") return { enabled: false, locked: false } as T;
    if (cmd === "set_encryption" || cmd === "lock_encryption" || cmd === "unlock_encryption" || cmd === "disable_encryption") {
      return undefined as T;
    }

    // ---- Storage / cleanup ----
    if (cmd === "storage_stats") {
      return {
        db_bytes: 0,
        attachment_bytes: 0,
        attachment_count: 0,
        trash_count: 0,
        trash_bytes: 0,
        version_count: 0,
        version_bytes: 0,
        deleted_workspace_count: 0,
        temp_bytes: 0,
      } as T;
    }
    if (cmd === "clear_trash" || cmd === "cleanup_orphan_attachments" || cmd === "cleanup_old_versions" || cmd === "cleanup_temp_files") {
      return 0 as T;
    }
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

export function createWebPlatform(): Platform {
  const db = loadDb();
  return {
    executor: {
      invoke: makeInvoke(db),
    },
    dialog: {
      // Browser can't pick host paths; return null (cancel) so callers no-op.
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
      // Paths from the mock backend are already data:/blob URLs; pass through.
      convertFileSrc: (path) => path,
    },
    webview: {
      onDragDropEvent: async () => () => {},
    },
  };
}
