import { semanticScore } from "../searchSemantic";
import { readEmbedConfig, embedText, cosineSim, VECTOR_BONUS, embeddingText, embedHash } from "../semanticEmbed";
import { buildWikiExport } from "../wikiExport";
import type { WikiPageInput } from "../wikiExport";
import { DEFAULT_COVER } from "../covers";

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
import { spaceStore, useSpaceCatalog } from "./spaceStore";
import { unzipSync, Zip, ZipDeflate } from "fflate";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { createOllamaTransport, createOpenAICompatTransport, testOllamaConnection, testOpenAICompatConnection } from "../ai/llm";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // avoid stack overflow on large images
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Cheap, lazy display URL for a media blob. Unlike a base64 data-URL this does
// NOT expand the file ~1.33x into a JS string, so it's safe for large images/videos.
// A blob URL is session-scoped; editors resolve from the content hash instead and
// only use this for one-off previews (file-manager), so a reload isn't affected.
function blobUrl(bytes: Uint8Array, mime: string): string {
  try {
    if (typeof URL !== "undefined" && URL.createObjectURL) {
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      return URL.createObjectURL(new Blob([buf], { type: mime || "application/octet-stream" }));
    }
  } catch {
    /* fall back to data URL */
  }
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// ---- schema-aware attachments helpers ----
// The web-native `attachments` table is `id/page_id/name/hash/mime/size/path`,
// while a desktop-format DB restored by `import_backup` uses
// `id/page_id/name/hash/mime/size/created_at` (no `path`, has `created_at`).
// Rather than assume one shape, read the live columns and only touch what exists
// (same pattern as `seedWorkspaceMeta`), so both schemas work after a restore.
const attachmentColumns = (store: SqliteStore): Set<string> => {
  try {
    return new Set((store.query("PRAGMA table_info(attachments)") as any[]).map((c) => String(c.name)));
  } catch {
    return new Set();
  }
};

// Insert an attachment row compatibly with whichever `attachments` schema is live.
export const insertAttachmentRow = (
  store: SqliteStore,
  fields: { id: string; page_id?: string | null; name: string; hash: string; mime: string; size: number; path?: string },
): void => {
  const cols = attachmentColumns(store);
  const ids: string[] = [];
  const vals: (string | number | null)[] = [];
  const add = (name: string, val: string | number | null) => {
    if (cols.has(name)) {
      ids.push(name);
      vals.push(val);
    }
  };
  add("id", fields.id);
  add("page_id", fields.page_id ?? null);
  add("name", fields.name);
  add("hash", fields.hash);
  add("mime", fields.mime);
  add("size", fields.size);
  // `path` is only meaningful in the web schema; stored as "" since display bytes
  // live in the blob store (see list_page_attachments resolution).
  add("path", fields.path ?? "");
  // Desktop schema requires `created_at INTEGER NOT NULL` (no default); supply it.
  add("created_at", Date.now());
  if (ids.length === 0) throw new Error("attachments 表没有可用列");
  store.run(`INSERT INTO attachments (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`, vals);
};

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
  const t = (s: string) => ({ type: "text", text: s, detail: 0, format: 0, mode: "normal", style: "", version: 1 });
  const para = (s: string) => ({ type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [t(s)] });
  const h = (tag: "h1" | "h2", s: string) => ({ type: "heading", tag, version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [t(s)] });
  const li = (s: string) => ({ type: "listitem", value: 1, version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [t(s)] });
  const bull = (items: string[]) => ({ type: "list", tag: "ul", listType: "bullet", start: 1, version: 1, direction: "ltr", format: "", indent: 0, style: "", children: items.map(li) });
  const quote = (s: string) => ({ type: "quote", version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [t(s)] });
  const callout = (s: string) => ({ type: "callout", version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [para(s)] });
  const hr = () => ({ type: "horizontalrule", version: 1, direction: "ltr", format: "", indent: 0, style: "" });

  return JSON.stringify({
    root: {
      type: "root",
      version: 1,
      direction: "ltr",
      format: "",
      indent: 0,
      children: [
        h("h1", "欢迎来到你的新空间"),
        callout("本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。"),
        h("h2", "从这里开始"),
        bull([
          "新建页面：Ctrl+N 或左侧栏 ＋",
          "插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）",
          "搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴",
        ]),
        h("h2", "常用快捷键"),
        quote("Ctrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图"),
        hr(),
        callout("用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。"),
        { type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [] },
      ],
    },
  });
}

// Seed a fresh (empty) database with a welcome page + onboarding page.
function seedIfEmpty(store: SqliteStore, wsId: string): void {
  const count = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages")[0]?.n ?? 0;
  if (count > 0) return;
  const welcomeId = uid();
  const demoId = uid();
  const now = Date.now();
  store.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, content_json, content_text)
     VALUES (?, ?, NULL, ?, 'page', 0, ?, ?, NULL, ?, ?, ?, ?)`,
    [welcomeId, wsId, "欢迎页", now, now, "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzg4MTg1NDc5MzUyIiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE2NjIiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTY5NC4yNzIgMjIwLjY3MmMtMTcuMDY2NjY3LTg1LjMzMzMzMy04MS4wNjY2NjctMTYyLjEzMzMzMy0xNzQuOTMzMzMzLTE1My42LTkzLjg2NjY2NyAxMi44LTI0My4yIDgxLjA2NjY2Ny0yMjEuODY2NjY3IDM1NC4xMzMzMzNzNzYuOCA0MDEuMDY2NjY3IDI0Ny40NjY2NjcgNDA5LjYgMzA3LjItMTc0LjkzMzMzMyAzMjguNTMzMzMzLTI2MC4yNjY2NjZjMTcuMDY2NjY3LTY0IDQ2LjkzMzMzMy0xMjMuNzMzMzMzIDg5LjYtMTc0LjkzMzMzNCAyNS42LTM4LjQtNjguMjY2NjY3LTk4LjEzMzMzMy0xMjgtMzQuMTMzMzMzLTU5LjczMzMzMyA2OC4yNjY2NjctNTkuNzMzMzMzIDExMC45MzMzMzMtMTEwLjkzMzMzMyAxMzIuMjY2NjY3LTguNTMzMzMzLTQ2LjkzMzMzMy0xMi44LTE4Ny43MzMzMzMtMjkuODY2NjY3LTI3My4wNjY2Njd6IiBmaWxsPSIjRkZDNjJBIiBvcGFjaXR5PSIuNCIgcC1pZD0iMTY2MyI+PC9wYXRoPjxwYXRoIGQ9Ik03NS42MDUzMzMgNjI2LjAwNTMzM2MyOS44NjY2NjcgNTUuNDY2NjY3IDY4LjI2NjY2NyAxMDYuNjY2NjY3IDExNS4yIDE1My42IDY4LjI2NjY2NyA4MS4wNjY2NjcgMTQwLjggMTgzLjQ2NjY2NyAyMDkuMDY2NjY3IDIxMy4zMzMzMzQgODUuMzMzMzMzIDM4LjQgMTQ1LjA2NjY2NyAxMi44IDIzNC42NjY2NjctMzQuMTMzMzM0IDExOS40NjY2NjctNTkuNzMzMzMzIDE3NC45MzMzMzMtMTU3Ljg2NjY2NyAxMzIuMjY2NjY2LTI5OC42NjY2NjYtMjkuODY2NjY3LTEwNi42NjY2NjctNDYuOTMzMzMzLTIxNy42LTU1LjQ2NjY2Ni0zMjguNTMzMzM0LTQuMjY2NjY3LTU1LjQ2NjY2Ny0xMTkuNDY2NjY3LTM4LjQtMTMyLjI2NjY2NyA1NS40NjY2NjctMTIuOCA5OC4xMzMzMzMgMjUuNiAxMzIuMjY2NjY3LTQuMjY2NjY3IDE4My40NjY2NjctMzguNC0zNC4xMzMzMzMtOTguMTMzMzMzLTg5LjYtMTM2LjUzMzMzMy0xMjMuNzMzMzM0cy0xNzAuNjY2NjY3LTE2Ni40LTIzOC45MzMzMzMtMTY2LjRjLTI5Ljg2NjY2NyAwLTY0IDguNTMzMzMzLTg5LjYgMjUuNi0yNS42IDIxLjMzMzMzMy0zOC40IDQ2LjkzMzMzMy00Ni45MzMzMzQgNzYuOCAwIDU1LjQ2NjY2Ny0xNy4wNjY2NjcgMTY2LjQgMTIuOCAyNDMuMnoiIGZpbGw9IiNGRkM2MkEiIHAtaWQ9IjE2NjQiPjwvcGF0aD48cGF0aCBkPSJNMjU0LjgwNTMzMyAxMS42MDUzMzNsNTkuNzMzMzM0IDE2Mi4xMzMzMzQgMjEuMzMzMzMzLTE2Mi4xMzMzMzRoLTgxLjA2NjY2N3ogbS0yMDAuNTMzMzMzIDE2Mi4xMzMzMzRsMTQwLjggMzguNC04MS4wNjY2NjctMTIzLjczMzMzNC01OS43MzMzMzMgODUuMzMzMzM0eiIgZmlsbD0iIzE1NDRGRiIgb3BhY2l0eT0iLjYiIHAtaWQ9IjE2NjUiPjwvcGF0aD48L3N2Zz4=", DEFAULT_COVER, welcomeContent(), "欢迎来到你的新空间\n本地优先 · 离线可用。你的笔记都保存在本机，改动即存，无需手动保存。\n从这里开始\n新建页面：Ctrl+N 或左侧栏 ＋\n插入内容：输入 / 打开块菜单（标题·表格·分栏·绘图…）\n搭建数据库：创建为数据表格，属性页做看板 / 日历 / 时间轴\n常用快捷键\nCtrl+K 命令面板 · Ctrl+/ 快捷键面板 · Ctrl+Shift+F 搜索 · Ctrl+E 切换笔记/看板/关系图\n用 / 插入块或从模板中心创建；命令面板 Ctrl+K 找到所有能力；/帮助 打开完整使用指南。"],
  );
  store.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
     VALUES (?, ?, NULL, ?, 'page', 1, ?, ?, NULL, '', ?)`,
    [demoId, wsId, "快速上手", now, now, "点击左侧新建页面，输入内容会自动保存到浏览器本地。"],
  );
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

// Whether `candidateId` is `rootId` itself or one of its (non-deleted)
// descendants. Used by move_page to forbid moving a node under its own subtree.
function isSelfOrDescendant(store: SqliteStore, rootId: string, candidateId: string): boolean {
  if (candidateId === rootId) return true;
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = store.query<{ id: string }>("SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL", [parent]);
    for (const c of children) {
      if (c.id === candidateId) return true;
      if (!seen.has(c.id)) {
        seen.add(c.id);
        queue.push(c.id);
      }
    }
  }
  return false;
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
      // `input.remove()` detaches the node and is a no-op if already removed,
      // so it's safe to call once (a second removeChild would throw NotFoundError).
      input.remove();
    };
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const MAX_BYTES = 50 * 1024 * 1024; // 50MB — guard against OOM from huge files
      const names: string[] = [];
      for (const f of files) {
        if (f.size > MAX_BYTES) {
          // Too large to safely buffer in memory for the Web platform; skip it and
          // surface a clear message instead of risking a crash on a huge blob.
          try { window.alert(`「${f.name}」过大（单个文件超过 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB），Web 版暂不支持。请用桌面版。`); } catch { /* no-op */ }
          continue;
        }
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

// ---- Block-level helpers (parse serialized Lexical JSON) ----

function parseJson(text: string): any {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { root: { children: [] } };
  }
}

function rootChildren(v: any): any[] {
  return Array.isArray(v?.root?.children) ? v.root.children : [];
}

function nodeText(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(nodeText).join("");
  return "";
}

function topBlockId(node: any): string {
  return typeof node?.blockId === "string" ? node.blockId : "";
}

// M19.2: does `text` contain a page link to `title` — `[[Title]]`, `[[Title|alias]]`,
// `[[Title#block]]` or `[[Title|alias#block]]`? (Alias/block forms are recognized
// so they create real backlinks even though they display differently.)
function backlinkRefMatches(text: string, title: string): boolean {
  const esc = String(title ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return false;
  const re = new RegExp(`\\[\\[${esc}(?:\\|[^\\]]*)?(?:#[^\\]]*)?\\]\\]`);
  return re.test(String(text ?? ""));
}

function truncateChars(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Lightweight relevance tokenizer: split into ASCII words + CJK bigrams so both
// English phrases and Chinese text get useful matches without an external FTS.
function tokenize(q: string): string[] {
  const tokens = new Set<string>();
  const lower = q.toLowerCase();
  const words = lower.split(/[\s,，。.!！?？:：;；'"()\[\]{}<>/\\|_-]+/).filter(Boolean);
  for (const w of words) tokens.add(w);
  // CJK: emit each contiguous run's bigrams + the whole run.
  const cjkRuns = lower.match(/[\u4e00-\u9fff\u3040-\u30ff]+/g) ?? [];
  for (const run of cjkRuns) {
    tokens.add(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
    if (run.length === 1) tokens.add(run);
  }
  return [...tokens];
}

// Keep exported for unit tests (see scripts/smoke-web.mjs).
export { tokenize };

// Rank pages by matched-token score (TF over title/content) with recency tiebreak.
// Returns pages that match at least one token, ordered by relevance.
function rankPagesForSearch(query: string, pages: { id: string; title: string; content_text: string; updated_at: number }[]): { id: string; title: string; content_text: string; score: number }[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const now = Date.now();
  const scored = pages.map((p) => {
    const title = (p.title ?? "").toLowerCase();
    const text = (p.content_text ?? "").toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of tokens) {
      let tf = 0;
      let idx = title.indexOf(t);
      while (idx !== -1) { score += 8; tf++; idx = title.indexOf(t, idx + 1); }
      idx = text.indexOf(t);
      while (idx !== -1) { score += 1; tf++; idx = text.indexOf(t, idx + 1); }
      if (tf > 0) matched++;
    }
    // Require at least one token matched; reward full coverage + recency.
    if (matched === 0) return null;
    const coverage = matched / tokens.length;
    const recency = Math.max(0, 1 - (now - (p.updated_at || now)) / 1000 / 60 / 60 / 24 / 365);
    score = score * (0.5 + 0.5 * coverage) + recency * 6;
    return { id: p.id, title: p.title, content_text: p.content_text, score };
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Build a snippet around the first query-token match in `text`.
function snippetForQuery(text: string, query: string): string {
  const tokens = tokenize(query);
  for (const t of tokens) {
    const idx = text.toLowerCase().indexOf(t);
    if (idx !== -1) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + t.length + 60);
      return truncateChars((start > 0 ? "…" : "") + text.slice(start, end).trim(), 120);
    }
  }
  return truncateChars(text.trim(), 120);
}

function snippetForBlock(contentJson: string, blockId: string): string {
  const v = parseJson(contentJson);
  for (const child of rootChildren(v)) {
    if (topBlockId(child) === blockId) {
      const t = nodeText(child).trim();
      return t ? truncateChars(t, 200) : "(空块)";
    }
  }
  return "(块已删除)";
}

function blockTextOf(contentJson: string, blockId: string): string {
  const v = parseJson(contentJson);
  for (const child of rootChildren(v)) {
    if (topBlockId(child) === blockId) return nodeText(child).trim();
  }
  return "";
}

function collectBlockRefs(node: any, topId: string, out: { source: string; target: string; kind: string }[]): void {
  const ty = node?.type;
  if ((ty === "blockref" || ty === "blockembed") && typeof node?.targetId === "string") {
    out.push({ source: topId, target: node.targetId, kind: ty === "blockembed" ? "embed" : "link" });
  }
  if (Array.isArray(node?.children)) {
    for (const child of node.children) collectBlockRefs(child, topId, out);
  }
}

// ---- The executor. Core CRUD runs real SQL; everything else degrades safely. ----

// Emit a backend-style event to the running page. The web EventDriver's `listen`
// forwards these (via window CustomEvent) so the SAME frontend listener code works
// in-browser and in Tauri (where tauri emits the real event). Returns false when
// the browser has no event bus (e.g. the Node smoke test), so callers can skip.
function emitPageEvent(name: string, payload: unknown): boolean {
  try {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return false;
    window.dispatchEvent(new CustomEvent(name, { detail: payload }));
    return true;
  } catch {
    return false;
  }
}

// Stream a set of `{name,bytes}` entries into a zip using fflate's streaming Zip,
// yielding back to the event loop between files so the UI stays responsive and the
// progress callback updates as each file is compressed (unlike zipSync, which
// blocks the main thread for the entire archive). Resolves with the full zip bytes.
async function streamZip(
  entries: { name: string; bytes: Uint8Array }[],
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    if (data) chunks.push(data);
  });
  const total = entries.length;
  let done = 0;
  for (const e of entries) {
    // Each entry compresses synchronously on the main thread, but yielding after
    // every one keeps a large export from freezing the whole UI at the end.
    const def = new ZipDeflate(e.name);
    zip.add(def);
    def.push(e.bytes, true);
    done++;
    onProgress?.(done, total);
    if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  zip.end();
  // Concatenate the emitted chunks into one buffer.
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function makeInvoke(store: SqliteStore) {
  // The live store represents the ACTIVE workspace only (snapshot isolation — see
  // bootSpaces in getSharedStore). Workspace list/active/id come from the catalog.
  // Each workspace's own DB snapshot carries a single `workspaces` row for itself,
  // so getWs() reads the row keyed by the active id.
  const getActiveWsId = (): string => useSpaceCatalog.getState().activeId ?? "active";
  const getWs = () =>
    store.query<{ id: string; name: string; theme: string | null; icon: string }>(
      "SELECT id, name, theme, icon FROM workspaces WHERE id = ?",
      [getActiveWsId()],
    )[0] ?? null;

  // Whether the workspace table has a created_at column (desktop schema does,
  // the web demo schema may not). Used to insert compatibly across both.
  const workspaceColumns = () => {
    try {
      return (store.query("PRAGMA table_info(workspaces)") as any[]).map((c) => String(c.name));
    } catch {
      return [];
    }
  };

  const seedWorkspaceMeta = () => {
    const ws = getWs();
    if (ws) return;
    const id = getActiveWsId();
    const cols = workspaceColumns();
    const hasCreated = cols.includes("created_at");
    const hasUpdated = cols.includes("updated_at");
    const now = Date.now();
    const ids = ["id", "name", "theme", "icon"];
    const vals: (string | number | null)[] = [id, "我的工作空间", null, ""];
    if (hasCreated) {
      ids.push("created_at");
      vals.push(now);
    }
    if (hasUpdated) {
      ids.push("updated_at");
      vals.push(now);
    }
    store.run(
      `INSERT INTO workspaces (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`,
      vals,
    );
  };

  return async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const a = (args ?? {}) as Record<string, any>;
    seedWorkspaceMeta();

    // ---- Core note CRUD (real SQL) ----
    if (cmd === "list_pages") {
      const rows = store.query(
        `SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height
         FROM pages WHERE deleted_at IS NULL ORDER BY sort_order, created_at`,
      );
      return rows as T;
    }
    if (cmd === "list_workspace_pages") {
      // api sends { workspaceId } flat. List pages of a given workspace. The live
      // DB holds the active workspace; other workspaces live as snapshots (and
      // return [] here as a graceful fallback instead of `{}`).
      const args = a.args ?? a;
      const wsId = String(args.workspaceId ?? args.workspace_id ?? getActiveWsId());
      const rows = store.query(
        `SELECT id, workspace_id, parent_id, title, icon, kind, sort_order, created_at, updated_at, deleted_at
         FROM pages WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
        [wsId],
      );
      return rows as T;
    }
    if (cmd === "list_all_pdf_attachments") {
      const rows = store.query(
        "SELECT id, name, hash, mime, size, path FROM attachments WHERE mime = 'application/pdf' OR LOWER(name) LIKE '%.pdf' ORDER BY name",
      );
      return rows as T;
    }
    if (cmd === "get_page") {
      const rows = store.query("SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL", [a.id]);
      return (rows[0] ?? null) as T;
    }
    if (cmd === "set_page_icon") {
      const args = a.args ?? a;
      store.run("UPDATE pages SET icon = ? WHERE id = ?", [args.icon ?? "", args.id]);
      return (store.query("SELECT * FROM pages WHERE id = ?", [args.id])[0] ?? null) as T;
    }
    if (cmd === "set_page_cover") {
      const args = a.args ?? a;
      store.run("UPDATE pages SET cover = ? WHERE id = ?", [args.cover ?? "", args.id]);
      return (store.query("SELECT * FROM pages WHERE id = ?", [args.id])[0] ?? null) as T;
    }
    if (cmd === "set_page_cover_height") {
      const args = a.args ?? a;
      // Desktop clamps to [120, 720] (commands.rs:333); mirror that so values that
      // would be rejected on desktop don't silently persist on Web.
      const raw = Number(args.height ?? 300);
      const h = Math.max(120, Math.min(720, Number.isFinite(raw) ? raw : 300));
      store.run("UPDATE pages SET cover_height = ? WHERE id = ?", [h, args.id]);
      return (store.query("SELECT * FROM pages WHERE id = ?", [args.id])[0] ?? null) as T;
    }
    if (cmd === "create_page" || cmd === "create_folder" || cmd === "create_database") {
      // api wraps args in `{ args }`.
      const args = a.args ?? a;
      const kind = cmd === "create_folder" ? "folder" : cmd === "create_database" ? "database" : "page";
      const id = uid();
      const wsId = getWs()?.id ?? getActiveWsId();
      const now = Date.now();
      // Honor an explicit title; fall back to a per-kind default (folders/databases
      // get a descriptive name, plain pages get 新页面).
      const fallback = kind === "folder" ? "新建文件夹" : kind === "database" ? "新建数据库" : "新页面";
      const title = typeof args.title === "string" && args.title.trim() ? args.title : fallback;
      // Append after the current last sibling (desktop computes MAX(sort_order)+1 per parent).
      const parentId = args.parent_id ?? null;
      const maxOrder = store.query<{ m: number }>("SELECT COALESCE(MAX(sort_order), -1) AS m FROM pages WHERE parent_id = ? AND deleted_at IS NULL", [parentId])[0]?.m ?? -1;
      const sortOrder = typeof args.sort_order === "number" ? args.sort_order : maxOrder + 1;
      // Desktop defaults content_json to "{}" (a valid empty Lexical doc); keep any
      // real payload (e.g. from a template) but never store an empty/blank string.
      const contentJson = typeof args.content_json === "string" && args.content_json ? args.content_json : "{}";
      store.run(
        `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, wsId, parentId, title, kind, sortOrder, now, now, contentJson, args.content_text ?? ""],
      );
      return store.query("SELECT * FROM pages WHERE id = ?", [id])[0] as T;
    }
    if (cmd === "save_page") {
      const args = a.args ?? a;
      const id = String(args.id ?? "");
      const p = store.query<{ id: string; title: string }>("SELECT id, title FROM pages WHERE id = ?", [id])[0];
      if (p) {
        // Only overwrite the title when a new one is actually provided; otherwise
        // KEEP the existing title (matches the desktop backend's
        // `title = args.title.unwrap_or(cur_title)`). Previously this fell back to
        // `p.id`, so a content-only save (e.g. from the template center, whose
        // auto-save fires with no title) renamed the page to its own UUID.
        const newTitle = typeof args.title === "string" ? args.title : p.title;
        const json = str(args.content_json ?? "");
        const text = str(args.content_text ?? "");
        // Snapshot the current content BEFORE we overwrite it (version history).
        snapshotBeforeSave(store, id, newTitle, json, text);
        store.run(
          `UPDATE pages SET title = ?, content_json = ?, content_text = ?, updated_at = ?
           WHERE id = ?`,
          [newTitle, json, text, Date.now(), id],
        );
        return store.query("SELECT * FROM pages WHERE id = ?", [id])[0] as T;
      }
      return null as T;
    }
    if (cmd === "delete_page") {
      // Soft-delete the page AND recursively all of its descendants (folders'
      // children, databases' pages, ...), so removing a folder empties it from
      // the tree rather than leaving orphaned children behind.
      const rootId = String(a.id ?? "");
      const now = Date.now();
      const all = [rootId];
      const queue = [rootId];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const children = store.query("SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL", [parent]);
        for (const child of children) {
          const cid = String((child as any).id);
          all.push(cid);
          queue.push(cid);
        }
      }
      for (const pid of all) {
        store.run("UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, pid]);
      }
      return undefined as T;
    }
    if (cmd === "purge_page") {
      // Physical purge: also cascade to descendants.
      const rootId = String(a.id ?? "");
      const all = [rootId];
      const queue = [rootId];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const children = store.query("SELECT id FROM pages WHERE parent_id = ?", [parent]);
        for (const child of children) {
          const cid = String((child as any).id);
          all.push(cid);
          queue.push(cid);
        }
      }
      for (const pid of all) {
        store.run("DELETE FROM pages WHERE id = ?", [pid]);
        store.run("DELETE FROM page_tags WHERE page_id = ?", [pid]);
        store.run("DELETE FROM page_props WHERE page_id = ?", [pid]);
        store.run("DELETE FROM page_versions WHERE page_id = ?", [pid]);
      }
      return undefined as T;
    }
    if (cmd === "restore_page") {
      store.run("UPDATE pages SET deleted_at = NULL WHERE id = ?", [a.id]);
      return undefined as T;
    }
    if (cmd === "move_page") {
      // api wraps move args in `{ args }`.
      const args = a.args ?? a;
      const id = String(args.id ?? args.page_id ?? "");
      const parentId = args.new_parent_id !== undefined ? args.new_parent_id : args.parent_id ?? null;
      const sortOrder = typeof args.sort_order === "number" ? args.sort_order : 0;
      const p = store.query<{ id: string }>("SELECT id FROM pages WHERE id = ?", [id])[0];
      if (p) {
        // Guard against cycles: don't move a node under itself or one of its own
        // descendants (a batch move of a folder into its own child would otherwise
        // corrupt the tree). Skip that parent silently.
        if (parentId && parentId !== id && isSelfOrDescendant(store, id, parentId)) {
          return undefined as T;
        }
        const target = parentId ?? null;
        if (target !== id) {
          store.run("UPDATE pages SET parent_id = ?, sort_order = ? WHERE id = ?", [target, sortOrder, id]);
        }
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
      const wsList = await spaceStore.listMetas();
      // If the catalog is empty (e.g. the live DB predates multi-space), fall back
      // to the workspace row present in the live DB so the UI still lists it.
      const metas = wsList.map((m) => ({
        id: m.id,
        name: m.name,
        theme: m.theme,
        icon: m.icon,
        sort_order: m.sort_order,
        created_at: m.created_at,
        updated_at: m.updated_at,
      }));
      if (metas.length === 0 && ws) {
        metas.push({
          id: ws.id, name: ws.name ?? "我的工作空间", theme: ws.theme, icon: ws.icon ?? "",
          sort_order: 0, created_at: Date.now(), updated_at: Date.now(),
        });
      }
      return metas as T;
    }
    if (cmd === "get_workspace_name") return (getWs()?.name ?? "我的工作空间") as T;
    if (cmd === "get_active_workspace_id") return (getActiveWsId()) as T;
    if (cmd === "set_active_workspace_id") {
      // Snapshot isolation: persist the current live DB under the OLD active id,
      // then load the target workspace's snapshot into the live store.
      const targetId = String(a.id ?? a.workspace_id ?? "");
      if (!targetId) return undefined as T;
      const currentId = getActiveWsId();
      if (currentId !== targetId) {
        await spaceStore.putSnapshot(currentId, store.snapshot());
        const snap = await spaceStore.getSnapshot(targetId);
        if (snap) await store.restore(snap);
        await spaceStore.setActiveId(targetId);
        seedWorkspaceMeta();
      }
      return undefined as T;
    }
    if (cmd === "rename_workspace") {
      const id = String(a.id ?? getActiveWsId());
      const name = String(a.name ?? "").trim();
      if (name) {
        // Update the catalog meta AND the workspace row in the live DB (if active).
        const meta = await spaceStore.getMeta(id);
        if (meta) {
          await spaceStore.putMeta({ ...meta, name, updated_at: Date.now() });
        }
        if (id === getActiveWsId()) {
          store.run("UPDATE workspaces SET name = ? WHERE id = ?", [name, id]);
        }
      }
      return undefined as T;
    }
    if (cmd === "set_workspace_settings") {
      const id = String(a.id ?? getActiveWsId());
      const theme = typeof a.theme === "string" ? a.theme : null;
      const icon = typeof a.icon === "string" ? a.icon : "";
      const meta = await spaceStore.getMeta(id);
      if (meta) {
        await spaceStore.putMeta({ ...meta, theme, icon, updated_at: Date.now() });
      }
      if (id === getActiveWsId()) {
        store.run("UPDATE workspaces SET theme = ?, icon = ? WHERE id = ?", [theme, icon, id]);
      }
      return undefined as T;
    }
    if (cmd === "create_workspace") {
      // Create a fresh empty workspace: a brand-new DB (its own workspace row +
      // seed content), snapshotted into the catalog, then made active.
      const id = uid();
      const name = String(a.name ?? "新工作空间");
      const now = Date.now();
      // Persist the CURRENT active space before we clobber the live store with the
      // new workspace (so its recent edits aren't lost on later switch-back).
      await spaceStore.putSnapshot(getActiveWsId(), store.snapshot());
      // Reset the live store to a brand-new database, write the new space's
      // workspace row directly (id = the new space id), seed demo content, snapshot.
      await store.restore(new Uint8Array());
      const cols = workspaceColumns();
      const hasCreated = cols.includes("created_at");
      const hasUpdated = cols.includes("updated_at");
      const ids = ["id", "name", "theme", "icon"];
      const vals: (string | number | null)[] = [id, name, null, ""];
      if (hasCreated) { ids.push("created_at"); vals.push(now); }
      if (hasUpdated) { ids.push("updated_at"); vals.push(now); }
      store.run(`INSERT INTO workspaces (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`, vals);
      seedIfEmpty(store, id);
      await spaceStore.putMeta({ id, name, theme: null, icon: "", sort_order: now, created_at: now, updated_at: now });
      await spaceStore.putSnapshot(id, store.snapshot());
      await spaceStore.setActiveId(id);
      return { id, name, created_at: now, updated_at: now } as T;
    }
    if (cmd === "delete_workspace") {
      // Remove the workspace's catalog entry + snapshot; if it was active, switch
      // to the first remaining space.
      const id = String(a.id ?? "");
      if (id) {
        await spaceStore.purge(id);
        if (id === getActiveWsId()) {
          const remaining = await spaceStore.listMetas();
          const next = remaining[0]?.id ?? "active";
          if (next !== id) {
            const snap = await spaceStore.getSnapshot(next);
            if (snap) await store.restore(snap);
            await spaceStore.setActiveId(next);
            seedWorkspaceMeta();
          }
        }
      }
      return undefined as T;
    }
    if (cmd === "copy_page_to_workspace") {
      // Copy a page subtree from the CURRENT (active) space into another workspace.
      // Web is snapshot-isolated per space, so we read the source from the live
      // store, then write the re-keyed copy into the target (a temp store loaded
      // from the target snapshot, or the live store if same space), and return the
      // new root id. Attachment bytes stay global/content-addressed (shared).
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const targetWsId = String(a.targetWorkspaceId ?? a.target_workspace_id ?? "");
      const newParentId = a.newParentId ?? a.new_parent_id ?? null;
      if (!pageId || !targetWsId) throw new Error("缺少参数");
      const activeId = getActiveWsId();
      const src = store.query<{ id: string; workspace_id: string; parent_id: string | null; title: string; content_json: string; content_text: string; kind: string; sort_order: number; created_at: number }>(
        "SELECT id, workspace_id, parent_id, title, content_json, content_text, kind, sort_order, created_at FROM pages WHERE id = ? AND deleted_at IS NULL",
        [pageId],
      )[0];
      if (!src) throw new Error("源页面不存在");

      // BFS collect subtree (old id → order).
      const queue = [pageId];
      const order: string[] = [];
      const idMap = new Map<string, string>();
      while (queue.length) {
        const pid = queue.shift()!;
        const nid = uid();
        idMap.set(pid, nid);
        order.push(pid);
        for (const kid of store.query<{ id: string }>("SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL", [pid]) as any[]) {
          queue.push(String(kid.id));
        }
      }

      const doCopy = (t: SqliteStore) => {
        const now = Date.now();
        for (const oldId of order) {
          const row = store.query<{ parent_id: string | null; title: string; content_json: string; content_text: string; kind: string; sort_order: number; created_at: number }>(
            "SELECT parent_id, title, content_json, content_text, kind, sort_order, created_at FROM pages WHERE id = ? AND deleted_at IS NULL",
            [oldId],
          )[0] as any;
          if (!row) continue;
          const nid = idMap.get(oldId)!;
          const newParent = oldId === pageId ? newParentId : (row.parent_id ? idMap.get(row.parent_id) ?? null : null);
          t.run(
            `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [nid, targetWsId, newParent, row.title ?? "", row.kind ?? "page", row.sort_order ?? 0, row.created_at ?? now, now, row.content_json ?? "", row.content_text ?? ""],
          );
          // copy props/tags/attachments rows for this page
          for (const p of store.query<{ attr_id: string; value: string }>("SELECT attr_id, value FROM page_props WHERE page_id = ?", [oldId]) as any[]) {
            t.run("INSERT OR IGNORE INTO page_props (page_id, attr_id, value) VALUES (?, ?, ?)", [nid, p.attr_id, p.value ?? ""]);
          }
          for (const tg of store.query<{ tag_id: string }>("SELECT tag_id FROM page_tags WHERE page_id = ?", [oldId]) as any[]) {
            t.run("INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)", [nid, tg.tag_id]);
          }
          for (const att of store.query<{ name: string; hash: string; mime: string; size: number; path?: string }>("SELECT name, hash, mime, size FROM attachments WHERE page_id = ?", [oldId]) as any[]) {
            const aid = uid();
            insertAttachmentRow(t, { id: aid, page_id: nid, name: att.name, hash: att.hash, mime: att.mime, size: att.size });
          }
        }
      };

      if (targetWsId === activeId) {
        // Same-space copy: write into the live store.
        doCopy(store);
        return idMap.get(pageId) as T;
      }
      // Cross-space: load the target snapshot, copy, snapshot back.
      const targetBytes = await spaceStore.getSnapshot(targetWsId);
      if (!targetBytes) throw new Error("目标工作空间不存在或没有快照");
      const tempStore = new SqliteStore();
      await tempStore.init();
      await tempStore.restore(targetBytes);
      doCopy(tempStore);
      await spaceStore.putSnapshot(targetWsId, tempStore.snapshot());
      return idMap.get(pageId) as T;
    }

    // ---- Tags (real SQL) ----
    if (cmd === "list_tags") {
      return store.query(
        `SELECT t.id, t.name, COUNT(pt.page_id) AS page_count
         FROM tags t LEFT JOIN page_tags pt ON pt.tag_id = t.id
         GROUP BY t.id, t.name ORDER BY t.name`,
      ) as T;
    }
    if (cmd === "create_tag") {
      // api sends { name } flat. Desktop get-or-creates: return existing tag if present.
      const args = a.args ?? a;
      const name = str(args.name ?? "新标签");
      const existing = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE name = ?", [name])[0];
      if (existing) return existing as T;
      const tag = { id: uid(), name };
      store.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tag.id, tag.name]);
      return tag as T;
    }
    if (cmd === "rename_tag") {
      // api sends { tagId, name } flat. Desktop merges on collision: if another tag
      // already has `name`, move its pages into it and delete the renamed tag.
      const args = a.args ?? a;
      const id = String(args.tagId ?? args.id ?? "");
      const name = str(args.name ?? "");
      const clash = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE name = ? AND id <> ?", [name, id])[0];
      if (clash) {
        // Avoid a (page_id, tag_id) primary-key clash: drop any clash links on
        // pages that also carry the renamed tag, then reassign id → clash.
        store.run("DELETE FROM page_tags WHERE tag_id = ? AND page_id IN (SELECT page_id FROM page_tags WHERE tag_id = ?)", [clash.id, id]);
        store.run("UPDATE page_tags SET tag_id = ? WHERE tag_id = ?", [clash.id, id]);
        store.run("DELETE FROM tags WHERE id = ?", [id]);
        return clash as T;
      }
      store.run("UPDATE tags SET name = ? WHERE id = ?", [name, id]);
      const row = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE id = ?", [id])[0];
      return (row ?? null) as T;
    }
    if (cmd === "delete_tag") {
      const args = a.args ?? a;
      const id = String(args.tagId ?? args.id ?? "");
      store.run("DELETE FROM page_tags WHERE tag_id = ?", [id]);
      store.run("DELETE FROM tags WHERE id = ?", [id]);
      return undefined as T;
    }
    if (cmd === "add_tag") {
      // Two caller shapes: api.ts sends { pageId, name } (get-or-create the tag by
      // name, then link it — matches desktop); the smoke suite sends
      // { page_id, tag_id } (link an existing tag by id). Support both.
      const args = a.args ?? a;
      const pageId = String(args.pageId ?? args.page_id ?? "");
      if (!pageId) return undefined as T;
      let tagId = String(args.tagId ?? args.tag_id ?? "");
      let tag: { id: string; name: string } | null = null;
      if (tagId) {
        tag = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE id = ?", [tagId])[0] ?? null;
        if (!tag) return undefined as T;
      } else {
        const name = str(args.name ?? "");
        if (!name) return undefined as T;
        tag = store.query<{ id: string; name: string }>("SELECT id, name FROM tags WHERE name = ?", [name])[0] ?? null;
        if (!tag) {
          tag = { id: uid(), name };
          store.run("INSERT INTO tags (id, name) VALUES (?, ?)", [tag.id, tag.name]);
        }
        tagId = tag.id;
      }
      const exists = store.query("SELECT 1 AS ok FROM page_tags WHERE page_id = ? AND tag_id = ?", [pageId, tagId])[0];
      if (!exists) store.run("INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)", [pageId, tagId]);
      return tag as T;
    }
    if (cmd === "remove_tag") {
      const args = a.args ?? a;
      const pageId = String(args.pageId ?? args.page_id ?? "");
      const tagId = String(args.tagId ?? args.tag_id ?? "");
      store.run("DELETE FROM page_tags WHERE page_id = ? AND tag_id = ?", [pageId, tagId]);
      return undefined as T;
    }
    if (cmd === "page_tags") {
      const args = a.args ?? a;
      const pageId = String(args.pageId ?? args.page_id ?? "");
      return store.query(
        `SELECT t.id, t.name FROM tags t
         JOIN page_tags pt ON pt.tag_id = t.id WHERE pt.page_id = ? ORDER BY t.name`,
        [pageId],
      ) as T;
    }
    if (cmd === "pages_by_tag") {
      const args = a.args ?? a;
      const tagId = String(args.tagId ?? args.tag_id ?? "");
      return store.query(
        `SELECT p.id, p.workspace_id, p.parent_id, p.title, p.kind, p.sort_order, p.created_at, p.updated_at, p.deleted_at
         FROM pages p JOIN page_tags pt ON pt.page_id = p.id
         WHERE pt.tag_id = ? AND p.deleted_at IS NULL`,
        [tagId],
      ) as T;
    }

    // ---- Search (SQL LIKE over title + text) ----
    if (cmd === "search") {
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? a.query ?? "");
      const lim = Number(req.limit ?? a.limit ?? 50);
      const wsId = getWs()?.id ?? getActiveWsId();
      if (!query) return [] as T;
      // Rank by relevance (tokenized TF) over the active workspace's pages.
      const rows = store.query<{ id: string; title: string; content_text: string; updated_at: number }>(
        `SELECT id, title, content_text, updated_at FROM pages
         WHERE deleted_at IS NULL AND workspace_id = ?`,
        [wsId],
      );
      // Semantic refinement (M20.2): char-bigram Jaccard nudges order among
      // TF-matched pages, but the token-TF backbone stays dominant so a page
      // that matches the query many times still ranks above a near-exact
      // short page. semanticBonus is bounded to a small fraction of TF.
      const SEMANTIC_BONUS = 5;
      const scored = rankPagesForSearch(query, rows)
        .map((r: any) => ({
          r,
          score: r.score + SEMANTIC_BONUS * (semanticScore(query, String(r.title ?? "")) + semanticScore(query, String(r.content_text ?? ""))),
        }))
        .sort((a: any, b: any) => b.score - a.score);

      // M20.2+ — optional real-vector re-rank (cache-backed): if an embedding model
      // is configured, embed the query once, then reuse each page's cached embedding
      // (keyed by page_id + content hash) so repeated searches make only 1 embed call.
      // Changed/new pages are lazily re-embedded once and cached. Any failure falls
      // back to the TF + char-bigram order above, so search never breaks.
      const embedCfg = readEmbedConfig();
      if (embedCfg) {
        try {
          const queryVec = await embedText(query, embedCfg);
          if (queryVec && queryVec.length) {
            const model = embedCfg.model;
            const K = Math.min(30, scored.length);
            const bonus = new Map<string, number>();
            for (const s of scored.slice(0, K)) {
              const text = embeddingText(String(s.r.title ?? ""), String(s.r.content_text ?? ""));
              const hash = embedHash(text);
              const cached = store.query<{ model: string; vector: string; hash: string }>(
                "SELECT model, vector, hash FROM page_embeddings WHERE page_id = ?",
                [String(s.r.id)],
              )[0];
              let vec: number[] | null = null;
              if (cached && cached.model === model && cached.hash === hash) {
                try {
                  const parsed = JSON.parse(cached.vector);
                  if (Array.isArray(parsed)) vec = parsed.map(Number);
                } catch {
                  vec = null;
                }
              }
              if (!vec) {
                vec = await embedText(text, embedCfg);
                if (vec && vec.length) {
                  store.run(
                    "INSERT OR REPLACE INTO page_embeddings (page_id, model, dim, vector, hash, updated_at) VALUES (?,?,?,?,?,?)",
                    [String(s.r.id), model, vec.length, JSON.stringify(vec), hash, Date.now()],
                  );
                }
              }
              if (vec && vec.length) bonus.set(String(s.r.id), cosineSim(queryVec, vec));
            }
            if (bonus.size) {
              scored.sort((a: any, b: any) => {
                const sa = a.score + VECTOR_BONUS * (bonus.get(String(a.r.id)) ?? 0);
                const sb = b.score + VECTOR_BONUS * (bonus.get(String(b.r.id)) ?? 0);
                return sb - sa;
              });
            }
          }
        } catch {
          // keep the TF + char-bigram order
        }
      }

      return scored.slice(0, lim).map((x: any) => ({
        id: x.r.id,
        title: x.r.title,
        snippet: snippetForQuery(String(x.r.content_text ?? ""), query),
        space: getWs()?.name ?? "",
        score: typeof x.score === "number" ? +x.score.toFixed(4) : x.score,
      })) as T;
    }
    if (cmd === "search_blocks") {
      const req = a.args && typeof a.args === "object" ? (a.args as Record<string, unknown>) : {};
      const query = String(req.query ?? a.query ?? "").toLowerCase();
      if (!query) return [] as T;
      const rows = store.query("SELECT id, title, content_json, content_text FROM pages WHERE deleted_at IS NULL AND (LOWER(content_text) LIKE ? OR LOWER(title) LIKE ?)", [`%${query}%`, `%${query}%`]);
      const out = [];
      for (const r of rows as any[]) {
        const v = parseJson(String(r.content_json ?? ""));
        for (const child of rootChildren(v)) {
          const text = nodeText(child);
          if (text.toLowerCase().includes(query)) {
            out.push({ block_id: topBlockId(child), page_id: r.id, page_title: r.title, snippet: truncateChars(text.trim(), 120) });
          }
        }
      }
      return out as T;
    }
    if (cmd === "get_page_blocks") {
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const rows = store.query("SELECT content_json FROM pages WHERE id = ? AND deleted_at IS NULL", [pageId]);
      if (!rows[0]) throw new Error("页面不存在");
      const v = parseJson(String((rows[0] as any).content_json ?? ""));
      const blocks = rootChildren(v)
        .filter((c) => topBlockId(c))
        .map((c) => ({ block_id: topBlockId(c), text: nodeText(c).trim() }));
      return blocks as T;
    }
    if (cmd === "get_backlinks") {
      // Page-level backlinks: pages whose content_text references the target page
      // via `[[Title]]`, `[[Title|alias]]`, `[[Title#block]]` or `[[Title|alias#block]]`.
      const targetId = String(a.id ?? "");
      const target = store.query<{ title: string }>("SELECT title FROM pages WHERE id = ?", [targetId])[0];
      if (!target) return [] as T;
      const metas: any[] = [];
      const all = store.query("SELECT id, title, content_text, parent_id, kind, sort_order, created_at, updated_at FROM pages WHERE deleted_at IS NULL");
      for (const p of all as any[]) {
        if (backlinkRefMatches(String(p.content_text ?? ""), target.title) && p.id !== targetId) {
          metas.push({ id: p.id, workspace_id: getWs()?.id ?? "", parent_id: p.parent_id ?? null, title: p.title, kind: p.kind, sort_order: p.sort_order ?? 0, created_at: p.created_at, updated_at: p.updated_at, deleted_at: null });
        }
      }
      return metas as T;
    }
    if (cmd === "resolve_block") {
      const blockId = String(a.blockId ?? a.id ?? "");
      for (const p of store.query("SELECT id, title, content_json FROM pages WHERE deleted_at IS NULL") as any[]) {
        if (blockTextOf(String(p.content_json ?? ""), blockId)) {
          const snippet = snippetForBlock(String(p.content_json ?? ""), blockId);
          const content = blockTextOf(String(p.content_json ?? ""), blockId);
          return { block_id: blockId, page_id: p.id, page_title: p.title, snippet, content } as T;
        }
      }
      throw new Error("块不存在");
    }
    if (cmd === "list_block_backlinks") {
      // Block-level backlinks where the current page's blocks are referenced.
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const targetJson = store.query<{ content_json: string }>("SELECT content_json FROM pages WHERE id = ?", [pageId])[0]?.content_json ?? "{}";
      const targetIds = new Set(rootChildren(parseJson(targetJson)).map(topBlockId).filter(Boolean));
      const out: any[] = [];
      for (const p of store.query("SELECT id, title, content_json FROM pages WHERE deleted_at IS NULL") as any[]) {
        if (p.id === pageId) continue;
        const refs: { source: string; target: string; kind: string }[] = [];
        const v = parseJson(String(p.content_json ?? ""));
        for (const child of rootChildren(v)) collectBlockRefs(child, topBlockId(child), refs);
        for (const ref of refs) {
          if (targetIds.has(ref.target)) {
            const sourceSnippet = snippetForBlock(String(p.content_json ?? ""), ref.source);
            const targetSnippet = snippetForBlock(targetJson, ref.target);
            out.push({ source_page_id: p.id, source_page_title: p.title, source_block_id: ref.source, source_snippet: sourceSnippet, target_block_id: ref.target, target_snippet: targetSnippet, kind: ref.kind });
          }
        }
      }
      return out as T;
    }

    // ---- Graph (nodes from non-deleted pages) ----
    if (cmd === "get_graph") {
      const pages = store.query("SELECT id, title, content_text, content_json FROM pages WHERE deleted_at IS NULL") as any[];
      const tagRows = store.query("SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id") as any[];
      const tagsByPage = new Map<string, string[]>();
      for (const tr of tagRows) {
        if (!tagsByPage.has(tr.page_id)) tagsByPage.set(tr.page_id, []);
        tagsByPage.get(tr.page_id)!.push(tr.name);
      }
      const propRows = store.query("SELECT pp.page_id, ad.name, pp.value FROM page_props pp JOIN attr_defs ad ON ad.id = pp.attr_id WHERE ad.type = 'select'") as any[];
      const propsByPage = new Map<string, { name: string; value: string }[]>();
      for (const pr of propRows) {
        if (!propsByPage.has(pr.page_id)) propsByPage.set(pr.page_id, []);
        propsByPage.get(pr.page_id)!.push({ name: pr.name, value: pr.value });
      }
      const nodeById = new Map<string, any>();
      const gPages = pages.map((p: any) => {
        const meta: any = { id: p.id, title: p.title, tags: tagsByPage.get(p.id) ?? [], props: propsByPage.get(p.id) ?? [] };
        nodeById.set(p.id, meta);
        return meta;
      });
      const edges: any[] = [];
      const edgeSet = new Set<string>();
      for (const p of pages) {
        for (const other of pages) {
          if (p.id === other.id) continue;
          if (backlinkRefMatches(p.content_text, other.title)) {
            const key = p.id + ">" + other.id + ">page";
            if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ source: p.id, target: other.id, kind: "page" }); }
          }
        }
        const refVals = store.query("SELECT pp.value FROM page_props pp JOIN attr_defs ad ON ad.id = pp.attr_id WHERE pp.page_id = ? AND ad.type = 'ref'", [p.id]) as any[];
        for (const rv of refVals) {
          const m = String(rv.value ?? "").match(/^p:(.+)$/);
          if (m && nodeById.has(m[1])) {
            const key = p.id + ">" + m[1] + ">ref";
            if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ source: p.id, target: m[1], kind: "ref" }); }
          }
        }
      }
      const blocks: any[] = [];
      const blockEdges: any[] = [];
      const blockIdToPage = new Map<string, string>();
      for (const p of pages) {
        const v = parseJson(p.content_json);
        const children = Array.isArray(v?.root?.children) ? v.root.children : [];
        for (const child of children) {
          const bid = topBlockId(child);
          if (!bid) continue;
          blockIdToPage.set(bid, p.id);
          blocks.push({ id: bid, label: snippetForBlock(p.content_json, bid) || "(", page_id: p.id });
          blockEdges.push({ source: bid, target: p.id, kind: "belongs" });
        }
      }
      for (const p of pages) {
        const refs: { source: string; target: string; kind: string }[] = [];
        for (const child of rootChildren(parseJson(p.content_json))) collectBlockRefs(child, topBlockId(child) ?? "", refs);
        for (const r of refs) {
          if (r.source && r.target && blockIdToPage.has(r.target)) blockEdges.push({ source: r.source, target: r.target, kind: r.kind });
        }
      }
      return { pages: gPages, edges, blocks, block_edges: blockEdges } as T;
    }

    // ---- Attachments (bytes in IndexedDB blob store; SQLite holds metadata only,
    //      so the DB never bloats with base64 as images grow) ----
    if (cmd === "save_image") {
      // api wraps args in `{ args }`.
      const args = a.args ?? a;
      const data = (args.data as number[]) ?? [];
      const bytes = new Uint8Array(data);
      const mime = String(args.mime || "image/png");
      const name = String(args.name ?? "image.png");
      const pageId = args.page_id ?? null;
      const hash = await contentHash(bytes);
      await blobStore.put(hash, bytes);
      // Cheap, lazy display URL for one-off previews (editors resolve from the
      // content hash instead, so large media never embeds base64 in content).
      const path = blobUrl(bytes, mime);
      const att = { id: uid(), name, hash, mime, size: data.length, path };
      // Always insert a row (id-based) so each occurrence can carry its own
      // page_id ownership; bytes are content-addressed and deduped in blobStore.
      insertAttachmentRow(store, { id: att.id, page_id: pageId ?? null, name: att.name, hash: att.hash, mime: att.mime, size: att.size });
      return att as T;
    }
    if (cmd === "attachment_path") {
      // `path` may not exist in a desktop-restored schema; select everything and
      // fall back to the blob store (which holds the actual bytes) if absent.
      const rows = store.query("SELECT * FROM attachments WHERE hash = ?", [a.hash]);
      const pathVal = rows[0] ? (rows[0] as any).path : "";
      if (pathVal) return pathVal as T;
      const bytes = await blobStore.get(String(a.hash));
      if (bytes) {
        const mime = String((rows[0] as any)?.mime ?? "image/png");
        return (`data:${mime};base64,${bytesToBase64(bytes)}`) as T;
      }
      return "" as T;
    }
    if (cmd === "get_attachment") {
      const id = String(a.id ?? "");
      const row = store.query<{ id: string; page_id: string | null; name: string; hash: string; mime: string; size: number }>(
        "SELECT id, page_id, name, hash, mime, size FROM attachments WHERE id = ?",
        [id],
      )[0];
      if (!row) throw new Error("附件不存在");
      const bytes = await blobStore.get(row.hash);
      return { id: row.id, name: row.name, hash: row.hash, mime: row.mime, size: row.size, path: bytes ? blobUrl(bytes, row.mime) : "" } as T;
    }
    if (cmd === "read_attachment_bytes") {
      // Desktop returns the decrypted Vec<u8> (JSON number[]); Web stores plaintext
      // bytes in blobStore (no E1 encryption), so just read them back. filePreview
      // uses this to read .md attachment content.
      const hash = String(a.hash ?? "");
      const bytes = await blobStore.get(hash);
      if (!bytes) throw new Error("附件不存在");
      return Array.from(bytes) as T;
    }
    if (cmd === "list_page_attachments") {
      // File-manager lists attachments owned by a folder/page (by page_id). When
      // no folder is open, list all (root). Attachments with a deleted owner are
      // hidden via their page_id being absent from live pages.
      const pageId = String(a.pageId ?? a.page_id ?? "");
      const rows = pageId
        ? store.query("SELECT * FROM attachments WHERE page_id = ?", [pageId])
        : store.query("SELECT * FROM attachments");
      // Resolve a display path from the byte store (which survives reload) so the
      // file-manager previews/images render even after a refresh. Use a lazy blob
      // URL rather than an inlined base64 data-URL (memory-friendly for large media).
      const resolved = await Promise.all(
        rows.map(async (r: any) => {
          if (r.path) return r;
          const bytes = await blobStore.get(String(r.hash));
          if (!bytes) return r;
          return { ...r, path: blobUrl(bytes, r.mime) };
        }),
      );
      return resolved as T;
    }
    if (cmd === "import_attachment_files") {
      // paths are file names registered by dialog.open → blobStore, metadata row.
      // The owning folder/page comes in as `pageId` (api passes `{ pageId, paths }`,
      // NOT wrapped in `{ args }`); desktop stores it on the row so the file shows
      // up under its folder in the sidebar/file-manager.
      const pageId = a.pageId ?? a.page_id ?? null;
      const paths = (a.paths ?? []).map(String);
      const metas = [];
      for (const p of paths) {
        const reg = fileRegistry.get(baseName(p));
        if (!reg) continue;
        const hash = await contentHash(reg.bytes);
        await blobStore.put(hash, reg.bytes);
        // Cheap, lazy display URL for one-off previews (editors resolve from the
        // content hash instead, so large media never embeds base64 in content).
        const displaySrc = blobUrl(reg.bytes, reg.mime);
        const att = { id: uid(), name: reg.name, hash, mime: reg.mime, size: reg.bytes.length, path: displaySrc };
        // Always insert a fresh row (like desktop + save_image) so each import
        // carries its own page_id ownership. Previously this skipped when a row
        // with the same hash already existed, so a re-upload never attached the
        // folder (page_id stayed NULL) and the file never showed in the sidebar.
        insertAttachmentRow(store, { id: att.id, page_id: pageId ?? null, name: att.name, hash: att.hash, mime: att.mime, size: att.size });
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
    if (cmd === "remove_attachment") {
      const id = String(a.id ?? "");
      // Delete the row; free blob bytes only when no other row references the hash.
      const row = store.query<{ hash: string }>("SELECT hash FROM attachments WHERE id = ?", [id])[0];
      if (row) {
        store.run("DELETE FROM attachments WHERE id = ?", [id]);
        const refs = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE hash = ?", [row.hash])[0]?.n ?? 0;
        if (refs === 0) {
          await blobStore.delete(row.hash).catch(() => {});
        }
      }
      return undefined as T;
    }
    if (cmd === "remove_attachments") {
      const ids = (a.ids ?? []).map(String);
      let removed = 0;
      for (const id of ids) {
        const row = store.query<{ hash: string }>("SELECT hash FROM attachments WHERE id = ?", [id])[0];
        if (!row) continue;
        store.run("DELETE FROM attachments WHERE id = ?", [id]);
        removed++;
        const refs = store.query<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE hash = ?", [row.hash])[0]?.n ?? 0;
        if (refs === 0) {
          await blobStore.delete(row.hash).catch(() => {});
        }
      }
      return removed as T;
    }
    if (cmd === "move_attachment") {
      const id = String(a.id ?? "");
      const newPageId = String(a.newPageId ?? a.new_page_id ?? "");
      const exists = store.query("SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL", [newPageId])[0];
      if (!exists) throw new Error("目标文件夹不存在");
      const n = store.query("SELECT id FROM attachments WHERE id = ?", [id]).length;
      if (n === 0) throw new Error("附件不存在");
      store.run("UPDATE attachments SET page_id = ? WHERE id = ?", [newPageId, id]);
      return undefined as T;
    }
    if (cmd === "restore_attachment") {
      // Clone a historical attachment as a NEW row in the target page (shared bytes).
      const targetPageId = String(a.targetPageId ?? a.target_page_id ?? "");
      const sourceId = String(a.sourceId ?? a.source_id ?? "");
      const row = store.query<{ name: string; hash: string; mime: string; size: number }>(
        "SELECT name, hash, mime, size FROM attachments WHERE id = ?",
        [sourceId],
      )[0];
      if (!row) throw new Error("附件不存在");
      const id = uid();
      insertAttachmentRow(store, {
        id, page_id: targetPageId || null, name: row.name, hash: row.hash, mime: row.mime, size: row.size,
      });
      const bytes = await blobStore.get(row.hash);
      return { id, name: row.name, hash: row.hash, mime: row.mime, size: row.size, path: bytes ? blobUrl(bytes, row.mime) : "" } as T;
    }
    // Low-level attachment byte ops are not exposed via api.ts; the Web platform
    // reads/writes bytes through blobStore in save_image/get_attachment/
    // read_attachment_bytes. Implement them for completeness so a future caller
    // doesn't hit the unknown-command throw.
    if (cmd === "write_attachment_bytes") {
      const hash = String(a.hash ?? "");
      const data = (a.data as number[]) ?? [];
      const bytes = new Uint8Array(data);
      const mime = String(a.mime || "application/octet-stream");
      const name = String(a.name || "file");
      await blobStore.put(hash, bytes);
      const att = { id: uid(), name, hash, mime, size: data.length, path: blobUrl(bytes, mime) };
      insertAttachmentRow(store, { id: att.id, page_id: null, name: att.name, hash: att.hash, mime: att.mime, size: att.size });
      return att as T;
    }
    if (cmd === "list_attachment_hashes") {
      const hashes: string[] = [];
      for (const e of await blobStore.entries()) hashes.push(e.hash);
      return hashes as T;
    }

    // ---- PDF annotations (M24) — per (attachment, page) list, content-addressed key. ----
    if (cmd === "save_pdf_annotations") {
      const args = a.args ?? a;
      const attachmentId = String(args.attachment_id ?? "");
      const pageIndex = Number(args.page_index ?? 0);
      const annotations = args.annotations ?? [];
      const now = Date.now();
      const payload = JSON.stringify(annotations);
      const existing = store.query<{ id: string }>("SELECT id FROM pdf_annotations WHERE attachment_id = ? AND page_index = ?", [attachmentId, pageIndex])[0];
      if (existing?.id) {
        store.run("UPDATE pdf_annotations SET payload_json = ?, updated_at = ? WHERE id = ?", [payload, now, existing.id]);
      } else {
        store.run("INSERT INTO pdf_annotations (id, attachment_id, page_index, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [uid(), attachmentId, pageIndex, payload, now, now]);
      }
      return { attachment_id: attachmentId, page_index: pageIndex, annotations } as T;
    }
    if (cmd === "list_pdf_annotations") {
      const args = a.args ?? a;
      const attachmentId = String(args.attachment_id ?? "");
      const rows = store.query<{ attachment_id: string; page_index: number; payload_json: string }>("SELECT attachment_id, page_index, payload_json FROM pdf_annotations WHERE attachment_id = ? ORDER BY page_index", [attachmentId]);
      return rows.map((r) => ({ attachment_id: r.attachment_id, page_index: r.page_index, annotations: JSON.parse((r.payload_json as string) || "[]") })) as T;
    }
    if (cmd === "list_all_pdf_annotations") {
      const rows = store.query<{ attachment_id: string; page_index: number; payload_json: string }>("SELECT attachment_id, page_index, payload_json FROM pdf_annotations ORDER BY updated_at DESC");
      return rows.map((r) => ({ attachment_id: r.attachment_id, page_index: r.page_index, annotations: JSON.parse((r.payload_json as string) || "[]") })) as T;
    }

    // ---- Bookmark metadata (browser can't fetch OG reliably; return the URL) ----
    if (cmd === "fetch_bookmark_metadata") {
      const url = String(a.url ?? "");
      return { url, title: url, description: "", site_name: "", image_hash: "", image_mime: "" } as T;
    }

    // ---- AI proxy (web fallback: pure HTTP; local Ollama works, cloud is CORS-bound) ----
    if (cmd === "ai_complete") {
      const args = a.args ?? a;
      const provider = String(args.provider ?? "ollama");
      const baseUrl = String(args.base_url ?? "http://localhost:11434");
      const model = String(args.model ?? "qwen2.5:7b");
      const apiKey = args.api_key ? String(args.api_key) : undefined;
      const messages = Array.isArray(args.messages) ? args.messages : [];
      const temperature = typeof args.temperature === "number" ? args.temperature : undefined;
      const maxTokens = typeof args.max_tokens === "number" ? args.max_tokens : undefined;
      const t = provider === "openai"
        ? createOpenAICompatTransport(baseUrl, model, apiKey)
        : createOllamaTransport(baseUrl, model);
      const res = await t.complete(messages, { temperature, maxTokens });
      return {
        content: res.content,
        native_tool_calls: res.nativeToolCalls
          ? res.nativeToolCalls.map((tc) => ({ name: tc.name, arguments: JSON.stringify(tc.arguments) }))
          : undefined,
      } as T;
    }
    if (cmd === "ai_probe") {
      const args = a.args ?? a;
      const provider = String(args.provider ?? "ollama");
      const baseUrl = String(args.base_url ?? "http://localhost:11434");
      const model = String(args.model ?? "qwen2.5:7b");
      const apiKey = args.api_key ? String(args.api_key) : undefined;
      const res = provider === "openai"
        ? await testOpenAICompatConnection(baseUrl, model, apiKey)
        : await testOllamaConnection(baseUrl, model);
      return { ok: res.ok, message: res.message, models: res.models ?? [] } as T;
    }
    // Desktop-only AI streaming (Web streams via pure fetch in llm.ts) and
    // desktop-native PDF render (Web uses pdf.js): safe no-ops so a stray call
    // doesn't hit the unknown-command throw.
    if (cmd === "ai_complete_stream") return undefined as T;
    if (cmd === "render_pdf_page") return undefined as T;

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
              "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height FROM pages WHERE deleted_at IS NULL AND id IN (" + pageIds.map(() => "?").join(",") + ")",
              pageIds,
            )
          : [];
        return { tag: { id: t.id, name: t.name }, pages };
      });
      // 未打标签的页面（对齐桌面 tags::board_data 的 Untagged 列，避免看板丢页）。
      const untagged = store.query(
        "SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height FROM pages p WHERE p.deleted_at IS NULL AND p.kind = 'page' AND NOT EXISTS (SELECT 1 FROM page_tags pt WHERE pt.page_id = p.id) ORDER BY p.updated_at DESC",
      );
      (columns as any[]).push({ tag: null, pages: untagged });
      return columns as T;
    }
    if (cmd === "board_by_attr") {
      const attrId = String(a.attrId ?? a.attr_id ?? "");
      const def = attrDefById(store, attrId);
      if (!def) throw new Error("属性不存在");
      const options = def.options;
      const pages = store.query("SELECT id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, icon, cover, cover_height FROM pages WHERE kind = 'page' AND deleted_at IS NULL");
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
    // Template save/delete are no-ops on Web (the list is a built-in demo, not
    // real SQLite-backed templates).
    if (cmd === "save_as_template") return undefined as T;
    if (cmd === "delete_template") return undefined as T;

    // ---- Plugins ----
    if (cmd === "list_plugins") return [] as T;
    if (cmd === "open_plugin_dir") return "" as T;
    if (cmd === "run_plugin_command") return { message: "", insert: null } as T;
    // Plugin management is a no-op on Web (no disk plugin runtime): return safe
    // defaults instead of throwing so the UI degrades gracefully.
    if (cmd === "install_plugin") return undefined as T;
    if (cmd === "set_plugin_enabled") return undefined as T;
    if (cmd === "uninstall_plugin") return undefined as T;

    // ---- Sync ----
    if (cmd === "get_sync_config") return { server_url: "", token: "", space_id: "", device_id: "", last_pushed_seq: 0, last_pulled_seq: 0 } as T;
    if (cmd === "set_sync_config") return undefined as T;
    if (cmd === "sync_now") return [] as T;
    if (cmd === "list_sync_profiles") return [] as T;
    if (cmd === "set_sync_profile") return undefined as T;
    if (cmd === "sync_workspace") return { ws_id: "", pushed: 0, pulled: 0, last_pushed_seq: 0, last_pulled_seq: 0, error: "Web 不支持真正的多服务器同步" } as T;

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
      // Precise byte accounting: DB = live snapshot length; attachments = sum of
      // blob-store bytes actually stored; trash/version = sum of their content lengths.
      const dbBytes = store.snapshot().length;
      // Attachment bytes: sum the blob-store entries referenced by rows (dedupe by
      // hash so shared bytes aren't double-counted). Falls back to 0 for big sets.
      const attHashes = new Set((store.query<{ hash: string }>("SELECT DISTINCT hash FROM attachments") as any[]).map((r) => String(r.hash)));
      let attBytes = 0;
      try {
        for (const e of await blobStore.entries()) {
          if (attHashes.has(e.hash)) attBytes += e.bytes.length;
        }
      } catch {
        /* keep 0 */
      }
      const trashBytes = (store.query<{ s: number }>("SELECT COALESCE(SUM(LENGTH(content_json) + LENGTH(content_text)), 0) AS s FROM pages WHERE deleted_at IS NOT NULL")[0]?.s ?? 0);
      const versionBytes = (store.query<{ s: number }>("SELECT COALESCE(SUM(LENGTH(content_json) + LENGTH(content_text)), 0) AS s FROM page_versions")[0]?.s ?? 0);
      return {
        db_bytes: dbBytes, attachment_bytes: attBytes, attachment_count: atts,
        trash_count: trash, trash_bytes: trashBytes, version_count: versions,
        version_bytes: versionBytes, deleted_workspace_count: 0, temp_bytes: 0,
      } as T;
    }
    if (cmd === "clear_trash") {
      // Desktop cascades all child rows + frees orphaned attachment bytes
      // (storage.rs:146-239); mirror the cascade so soft-deleted pages don't leak
      // tags/props/versions/columns/blob bytes on Web.
      const trashIds = "SELECT id FROM pages WHERE deleted_at IS NOT NULL";
      store.run(`DELETE FROM page_tags WHERE page_id IN (${trashIds})`);
      store.run(`DELETE FROM page_props WHERE page_id IN (${trashIds})`);
      store.run(`DELETE FROM page_versions WHERE page_id IN (${trashIds})`);
      store.run(`DELETE FROM page_embeddings WHERE page_id IN (${trashIds})`);
      store.run(`DELETE FROM database_columns WHERE db_page_id IN (${trashIds})`);
      store.run(`DELETE FROM db_views WHERE db_page_id IN (${trashIds})`);
      store.run(`DELETE FROM attachments WHERE page_id IN (${trashIds})`);
      store.run("DELETE FROM pages WHERE deleted_at IS NOT NULL");
      // Free blob bytes no longer referenced by any remaining attachment row.
      try {
        const referenced = new Set((store.query<{ hash: string }>("SELECT DISTINCT hash FROM attachments") as any[]).map((r) => String(r.hash)));
        for (const e of await blobStore.entries()) {
          if (!referenced.has(e.hash)) await blobStore.delete(e.hash).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
      return 0 as T;
    }
    if (cmd === "cleanup_orphan_attachments") {
      // Free blob bytes whose hash is no longer referenced by any attachment row
      // (content-addressed: a hash can be safely removed only when zero rows use it).
      const referenced = new Set((store.query<{ hash: string }>("SELECT DISTINCT hash FROM attachments") as any[]).map((r) => String(r.hash)));
      let freed = 0;
      for (const e of await blobStore.entries()) {
        if (!referenced.has(e.hash)) {
          freed += e.bytes.length;
          await blobStore.delete(e.hash).catch(() => {});
        }
      }
      return freed as T;
    }
    if (cmd === "cleanup_temp_files") return 0 as T;
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

    // ---- Backup / export / import (standard zip, matches the desktop format) ----
    // Desktop export_backup produces a zip with `shuyonote.db` (SQLite snapshot) +
    // `attachments/<hash>` (content-addressed bytes). We produce/consume the SAME
    // structure so a backup written by the desktop app can be imported here, and
    // vice-versa (manual data transfer between the web and desktop worlds).
    if (cmd === "export_backup") {
      const dbBytes = store.snapshot();
      const atts = await blobStore.entries();
      const fileList: { name: string; bytes: Uint8Array }[] = [{ name: "shuyonote.db", bytes: dbBytes }];
      for (const a of atts) fileList.push({ name: `attachments/${a.hash}`, bytes: a.bytes });
      const zip = await streamZip(fileList, (done, total) => {
        emitPageEvent("backup-progress", { phase: "export", done, total, bytes: 0, message: `打包 ${done}/${total}…` });
      });
      const name = String(a.destPath ?? "shuyonote-backup.zip").split(/[\\/]/).pop() || "shuyonote-backup.zip";
      if (typeof document !== "undefined") downloadBytes(name, zip, "application/zip");
      // Register so same-session import (and the Node smoke test) can read it back.
      fileRegistry.set(name, { bytes: zip, mime: "application/zip", name });
      return { path: name, size: zip.length } as T;
    }
    if (cmd === "import_backup") {
      // Merge import: each space in the backup (spaces/<id>.db, or a legacy single
      // shuyonote.db) is imported as a NEW space (never overwrites existing ones),
      // and attachments are merged by content-addressed hash (same hash === bytes).
      const src = String(a.srcPath ?? "");
      const reg = fileRegistry.get(baseName(src));
      if (!reg) throw new Error("备份文件不存在");
      const emit = (done: number, total: number, message: string) =>
        emitPageEvent("backup-progress", { phase: "import", done, total, bytes: 0, message });

      emit(0, 1, "读取备份…");
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(reg.bytes);
      } catch {
        throw new Error("不是有效的备份包");
      }
      const snapKeys = Object.keys(files).filter(
        (k) => (k.startsWith("spaces/") && k.endsWith(".db")) || k === "shuyonote.db",
      );
      if (snapKeys.length === 0) throw new Error("备份缺少数据库文件");

      const existingIds = new Set((await spaceStore.listMetas()).map((m) => m.id));
      let imported = 0;
      let renamed = 0;

      for (let i = 0; i < snapKeys.length; i++) {
        const k = snapKeys[i];
        const dbBytes = files[k];
        const fromId = k.startsWith("spaces/") ? k.slice("spaces/".length, -3) : null;
        const now = Date.now();
        // Persist the CURRENT active space before we clobber the live store with
        // the imported snapshot (so its recent edits aren't lost on switch-back).
        const activeId = getActiveWsId();
        if (activeId) await spaceStore.putSnapshot(activeId, store.snapshot());

        await store.restore(dbBytes);
        // Read the space's own name/theme/icon before re-keying to a fresh id. The
        // restored DB may be desktop-format (workspaces has created_at) or web-format
        // (no created_at), so don't ORDER BY created_at — just grab the one row.
        const meta0 = store.query<{ name: string; theme: string; icon: string }>(
          "SELECT name, COALESCE(theme,'') AS theme, COALESCE(icon,'') AS icon FROM workspaces LIMIT 1",
        )[0];
        const newId = uid();
        const name = meta0?.name || String(a.name ?? "导入空间");
        const theme = meta0?.theme ?? null;
        const icon = meta0?.icon ?? "";
        if (fromId && existingIds.has(fromId)) renamed++;
        store.run("DELETE FROM workspaces");
        const wCols = workspaceColumns();
        const wHasCreated = wCols.includes("created_at");
        const wHasUpdated = wCols.includes("updated_at");
        const wIds = ["id", "name", "theme", "icon"];
        const wVals: (string | number | null)[] = [newId, name, theme, icon];
        if (wHasCreated) { wIds.push("created_at"); wVals.push(now); }
        if (wHasUpdated) { wIds.push("updated_at"); wVals.push(now); }
        store.run(`INSERT INTO workspaces (${wIds.join(", ")}) VALUES (${wIds.map(() => "?").join(", ")})`, wVals);
        await spaceStore.putSnapshot(newId, store.snapshot());
        await spaceStore.putMeta({ id: newId, name, theme, icon, sort_order: now, created_at: now, updated_at: now });
        imported++;
        emit(i + 1, snapKeys.length, `导入空间 ${i + 1}/${snapKeys.length}…`);
      }

      // Merge attachment bytes (content-addressed: same hash === same bytes).
      const attEntries = Object.entries(files).filter(([kk]) => kk.startsWith("attachments/") && !kk.endsWith("/"));
      for (let i = 0; i < attEntries.length; i++) {
        const [kk, bytes] = attEntries[i];
        await blobStore.put(kk.slice("attachments/".length), bytes);
        if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return { imported, renamed } as T;
    }
    if (cmd === "export_workspace") {
      // Export the current (single) workspace as a self-contained zip matching the
      // desktop format: `shuyonote.db` (DB snapshot) + `workspace.json` (metadata)
      // + `attachments/<hash>` for each referenced attachment. Previously this was
      // a stub returning size 0, so the web "空间导出" yielded an empty download.
      // We emit `workspace-progress` events so the UI can show a progress bar
      // (same event name the desktop backend uses).
      const ws = getWs();
      if (!ws) throw new Error("工作空间不存在");
      const totalPhase = 3;
      const emit = (done: number, message: string, bytes = 0) =>
        emitPageEvent("workspace-progress", { phase: "export", done, total: totalPhase, bytes, message });

      emit(0, "准备导出…");
      const dbBytes = store.snapshot();
      // workspace.json metadata (same shape the desktop importer expects).
      const metaBytes = new TextEncoder().encode(JSON.stringify({ id: ws.id, name: ws.name ?? "", theme: ws.theme ?? "", icon: ws.icon ?? "" }));
      emit(1, "打包空间数据库…", dbBytes.length);

      // Only the attachment bytes this space references (via page_id) — self-contained.
      const refHashes = new Set(
        (store.query<{ hash: string }>("SELECT DISTINCT hash FROM attachments WHERE page_id IN (SELECT id FROM pages WHERE workspace_id = ? AND deleted_at IS NULL)", [ws.id]) as any[])
          .map((r) => String(r.hash)),
      );
      const pages = (store.query("SELECT id FROM pages WHERE workspace_id = ? AND deleted_at IS NULL", [ws.id]) as any[]).length;
      const atts = await blobStore.entries();
      const candidates = atts.filter((a) => refHashes.size === 0 || refHashes.has(a.hash));

      // Build the ordered list to stream (db first, then meta, then attachments).
      const fileList: { name: string; bytes: Uint8Array }[] = [
        { name: "shuyonote.db", bytes: dbBytes },
        { name: "workspace.json", bytes: metaBytes },
      ];
      for (const a of candidates) fileList.push({ name: `attachments/${a.hash}`, bytes: a.bytes });
      const zip = await streamZip(fileList, (done, total) => {
        // Progress by file count; phase ramps from 2 (packing) toward 3 (finalizing).
        emit(Math.round(2 + Math.min(1, done / Math.max(1, total))), `流式打包 ${done}/${total}…`);
      });

      emit(3, "写入下载…", zip.length);
      const name = String(a.destPath ?? "space-export.zip").split(/[\\/]/).pop() || "space-export.zip";
      if (typeof document !== "undefined") downloadBytes(name, zip, "application/zip");
      // Register so a same-session re-import (and the Node smoke test) can read it.
      fileRegistry.set(name, { bytes: zip, mime: "application/zip", name });
      return { path: name, size: zip.length, pages, attachments: candidates.length } as T;
    }
    if (cmd === "export_wiki") {
      // Export the current workspace as a self-contained static HTML wiki: one
      // `<slug>.html` per page (with `[[…]]` double-links + backlinks) plus an
      // `index.html` page tree, zipped for download / static hosting.
      const ws = getWs();
      if (!ws) throw new Error("工作空间不存在");
      const pages = store.query<WikiPageInput>(
        "SELECT id, title, content_text, kind, parent_id, sort_order, updated_at FROM pages WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY parent_id, sort_order, title",
        [ws.id],
      ) as any[];
      const wiki = buildWikiExport(pages, { space: ws.name ?? "" });
      const fileList = wiki.files.map((f) => ({
        name: f.name,
        bytes: new TextEncoder().encode(f.content),
      }));
      const zip = await streamZip(fileList);
      const name = String(a.destPath ?? "wiki-export.zip").split(/[\\/]/).pop() || "wiki-export.zip";
      if (typeof document !== "undefined") downloadBytes(name, zip, "application/zip");
      fileRegistry.set(name, { bytes: zip, mime: "application/zip", name });
      return { path: name, size: zip.length, pages: wiki.pageCount, files: wiki.files.length } as T;
    }
    if (cmd === "import_workspace") {
      // Import a workspace package (same format as export_workspace): a zip with
      // `shuyonote.db` + `workspace.json` + `attachments/<hash>`. With multi-space
      // support this creates a NEW workspace (never clobbers an existing one): the
      // imported DB is snapshotted under a fresh id and made active.
      const src = String(a.srcPath ?? "");
      const reg = fileRegistry.get(baseName(src));
      if (!reg) throw new Error("空间包不存在");
      const emit = (done: number, total: number, message: string) =>
        emitPageEvent("workspace-progress", { phase: "import", done, total, bytes: 0, message });

      emit(0, 3, "读取空间包…");
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(reg.bytes);
      } catch {
        throw new Error("不是有效的空间包");
      }
      const dbBytes = files["shuyonote.db"];
      if (!dbBytes) throw new Error("空间包缺少数据库文件");

      // Decide a fresh workspace id (import never overwrites an existing space).
      const newId = uid();
      // Apply the workspace name from workspace.json (fallback to the caller name).
      let name = String(a.name ?? "导入空间");
      try {
        const meta = JSON.parse(new TextDecoder().decode(files["workspace.json"]?.length ? files["workspace.json"] : new Uint8Array()));
        if (meta && typeof meta.name === "string" && meta.name) name = meta.name;
      } catch {
        /* keep fallback */
      }

      emit(1, 3, "恢复空间数据库…");
      // Persist the CURRENT active space before we clobber the live store with the
      // imported workspace (so its recent edits aren't lost on later switch-back).
      await spaceStore.putSnapshot(getActiveWsId(), store.snapshot());
      await store.restore(dbBytes);
      // Re-key the imported DB's workspace row to the new id: drop any existing
      // rows and write one for the new space id.
      store.run("DELETE FROM workspaces");
      const cols = workspaceColumns();
      const hasCreated = cols.includes("created_at");
      const hasUpdated = cols.includes("updated_at");
      const now0 = Date.now();
      const ids = ["id", "name", "theme", "icon"];
      const vals: (string | number | null)[] = [newId, name, null, ""];
      if (hasCreated) { ids.push("created_at"); vals.push(now0); }
      if (hasUpdated) { ids.push("updated_at"); vals.push(now0); }
      store.run(`INSERT INTO workspaces (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`, vals);

      const attEntries = Object.entries(files).filter(([k]) => k.startsWith("attachments/") && !k.endsWith("/"));
      const total = attEntries.length;
      let done = 0;
      for (const [k, bytes] of attEntries) {
        const hash = k.slice("attachments/".length);
        await blobStore.put(hash, bytes);
        done++;
        emit(2 + (total === 0 ? 1 : Math.round((done / total) * 1)), total, `恢复附件 ${done}/${total}…`);
        if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
      }

      const now = Date.now();
      await spaceStore.putMeta({ id: newId, name, theme: null, icon: "", sort_order: now, created_at: now, updated_at: now });
      await spaceStore.putSnapshot(newId, store.snapshot());
      await spaceStore.setActiveId(newId);
      emit(3, 3, "导入完成");
      return { id: newId, name, created_at: now, updated_at: now } as T;
    }
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
    if (cmd === "write_binary_file") {
      // Write raw bytes to a browser-side "file": trigger a download named after
      // the target. (Desktop saves via dialog.save + write_binary_file; web falls
      // back to download so the CommandMap stays consistent across shells.)
      const path = String(a.path ?? "output");
      const data = new Uint8Array((a.data ?? []) as number[]);
      if (typeof document !== "undefined") downloadBytes(baseName(path), data, "application/octet-stream");
      fileRegistry.set(baseName(path), { bytes: data, mime: "application/octet-stream", name: baseName(path) });
      return undefined as T;
    }
    if (cmd === "read_text_file") {
      const reg = fileRegistry.get(baseName(String(a.path ?? "")));
      if (reg) return new TextDecoder().decode(reg.bytes) as T;
      return "" as T;
    }
    if (cmd === "read_file_bytes") {
      // Return raw bytes (as a number array) for binary assets (e.g. zip).
      const reg = fileRegistry.get(baseName(String(a.path ?? "")));
      if (reg) return Array.from(reg.bytes) as T;
      return ([] as number[]) as T;
    }
    if (cmd === "open_page_window") return undefined as T;

    // ---- Persistent storage ----
    // Ask the browser to mark this origin as persistent so it won't auto-evict
    // the database (which would lose the user's notes). Returns the outcome and
    // the current quota/usage so the UI can surface it.
    if (cmd === "request_persistent_storage") {
      return (await requestPersistentStorage()) as T;
    }

    // ---- Unknown: fail loudly ----
    // A command that reaches here is not implemented on the Web platform. Throw
    // instead of silently returning {} so a renamed / typo'd / not-yet-implemented
    // command surfaces immediately (the old {} masked exactly this class of bug).
    throw new Error(`Web 平台未实现命令: ${cmd}`);
  };
}

// ---- Shared store + lazy init (async wasm load) ----

let sharedInit: Promise<SqliteStore> | null = null;

// Boot multi-space state: ensure a catalog exists and load the active workspace's
// DB snapshot into the live store. Plan A — snapshot isolation. The live store
// always represents ONE (active) workspace; switching snapshots current then
// restores the target.
async function bootSpaces(store: SqliteStore): Promise<void> {
  let metas = await spaceStore.listMetas();
  // Fresh install (or a browser whose IndexedDB was cleared): create the default
  // workspace. If the live DB already holds pages (e.g. it predates multi-space),
  // reuse it as the default; otherwise seed a fresh default.
  if (metas.length === 0) {
    const defaultId = "active";
    const now = Date.now();
    const hasPages = (store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages")[0]?.n ?? 0) > 0;
    if (!hasPages) {
      // Brand-new DB: write the default workspace row + seed content.
      await store.restore(new Uint8Array());
    }
    const cols = workspaceColumns(store);
    const rows = store.query<{ id: string }>("SELECT id FROM workspaces").map((r) => r.id);
    if (rows.length === 0) {
      const ids = ["id", "name", "theme", "icon"];
      const vals: (string | number | null)[] = [defaultId, "我的工作空间", null, ""];
      if (cols.includes("created_at")) { ids.push("created_at"); vals.push(now); }
      if (cols.includes("updated_at")) { ids.push("updated_at"); vals.push(now); }
      store.run(`INSERT INTO workspaces (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`, vals);
    }
    seedIfEmpty(store, defaultId);
    await spaceStore.putMeta({ id: defaultId, name: "我的工作空间", theme: null, icon: "", sort_order: now, created_at: now, updated_at: now });
    await spaceStore.putSnapshot(defaultId, store.snapshot());
    await spaceStore.setActiveId(defaultId);
    metas = await spaceStore.listMetas();
  }

  // Load the active workspace's snapshot into the live store.
  let activeId = await spaceStore.getActiveId();
  if (!activeId || !metas.some((m) => m.id === activeId)) {
    activeId = metas[0]?.id ?? activeId ?? "active";
    await spaceStore.setActiveId(activeId);
  }
  // The live store was loaded from IndexedDB at init, which ALWAYS holds the last
  // active workspace's most recent bytes (every mutation persists there). On a
  // plain refresh that data is fresh (deletes applied), so we must NOT clobber it
  // with the possibly-stale spaceStore snapshot — instead keep it and refresh this
  // space's snapshot so a later switch-back/reload is correct too.
  const liveHasPages = (store.query<{ n: number }>("SELECT COUNT(*) AS n FROM pages")[0]?.n ?? 0) > 0;
  const snap = await spaceStore.getSnapshot(activeId);
  if (liveHasPages) {
    await spaceStore.putSnapshot(activeId, store.snapshot());
  } else if (snap && snap.length > 0) {
    await store.restore(snap);
  } else {
    // Active space has no snapshot yet — seed + capture one.
    const meta = metas.find((m) => m.id === activeId);
    if (meta) {
      const rows = store.query<{ id: string }>("SELECT id FROM workspaces").map((r) => r.id);
      if (rows.length === 0) {
        const cols = workspaceColumns(store);
        const ids = ["id", "name", "theme", "icon"];
        const vals: (string | number | null)[] = [activeId, meta.name, meta.theme, meta.icon];
        if (cols.includes("created_at")) { ids.push("created_at"); vals.push(Date.now()); }
        if (cols.includes("updated_at")) { ids.push("updated_at"); vals.push(Date.now()); }
        store.run(`INSERT INTO workspaces (${ids.join(", ")}) VALUES (${ids.map(() => "?").join(", ")})`, vals);
      }
      seedIfEmpty(store, activeId);
      await spaceStore.putSnapshot(activeId, store.snapshot());
    }
  }
  // Sync the synchronous catalog so makeInvoke's getActiveWsId() reads instantly.
  useSpaceCatalog.getState().setActiveId(activeId);
}

function workspaceColumns(store: SqliteStore): string[] {
  try {
    return (store.query("PRAGMA table_info(workspaces)") as any[]).map((c) => String(c.name));
  } catch {
    return [];
  }
}

// Reconcile the multi-space catalog with the live store AFTER a hard restore
// (import_backup overwrites the whole DB). The restored DB carries its own
// workspace row(s); re-sync catalog + active id + its snapshot so the sidebar name
// and workspace list reflect the restored data, not the pre-restore catalog.


function getSharedStore(): Promise<SqliteStore> {
  if (!sharedInit) {
    const store = new SqliteStore();
    // Surface persistence failures so the UI can warn about unsaved changes
    // (in-memory state is NOT rolled back — we only make the problem visible).
    store.onPersistError = (err) => {
      if (err) {
        console.error("[web] persist failed", err);
        emitPageEvent("persist-error", { error: String(err) });
      }
    };
    sharedInit = store
      .init()
      .then(async () => {
        await bootSpaces(store);
        return store;
      })
      .catch((e) => {
        // If boot fails (e.g. odd IndexedDB state), fall back to a fresh store so
        // the app still loads; seeding the default workspace retries on next run.
        console.error("[web] boot spaces failed", e);
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
      // In the browser, backend-style events (e.g. workspace-progress) are
      // dispatched as CustomEvents on window (see emitPageEvent), so forwarding
      // them here lets the SAME listener code work on web and in Tauri.
      listen: async (name, handler) => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
        const onEvent = (e: Event) => {
          const ce = e as CustomEvent;
          handler({ payload: ce.detail });
        };
        window.addEventListener(name, onEvent);
        return () => window.removeEventListener(name, onEvent);
      },
    },
    asset: {
      convertFileSrc: (path) => path,
    },
    webview: {
      onDragDropEvent: async () => () => {},
    },
    pdfRender: {
      renderPdfPage: async () => {
        // Web has no native engine; the reader falls back to pdf.js.
        throw new Error("native pdf render not available on web");
      },
      nativeAvailable: () => false,
    },
  };
}

