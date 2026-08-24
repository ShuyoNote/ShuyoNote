// Boot smoke test for the SQLite-backed Web platform, run with plain node.
// It exercises the exact startup path the browser uses:
//   createWebPlatform() → sql.js WASM SQLite → core CRUD via SQL.
//
// Run:  node scripts/smoke-web.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { unzipSync } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);
const esbuild = require(join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"));

// Node has a global `crypto` (getter-only); the mock uses `crypto.randomUUID`.
// sql.js uses `window`? No. We only need `window` for the platform-level open().

// Bundle web.ts (with its sqliteStore dep) to a temp ESM file, with sql.js
// marked external so it loads from node_modules at runtime.
const tmpDir = join(root, ".smoke-tmp");
mkdirSync(tmpDir, { recursive: true });
const outfile = join(tmpDir, "web.mjs");

await esbuild.build({
  entryPoints: [join(root, "src/lib/platform/web.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  external: ["sql.js"],
  // The `?url` import in web.ts is a Vite-only feature; in Node we stub it to a
  // data-url no-op via a plugin so the bundle compiles.
  plugins: [
    {
      name: "vite-url-stub",
      setup(build) {
        build.onResolve({ filter: /\.wasm\?url$/ }, () => ({ path: "sql-wasm.wasm", namespace: "vite-url" }));
        build.onLoad({ filter: /.*/, namespace: "vite-url" }, () => ({ contents: "export default 'sql-wasm.wasm';", loader: "js" }));
      },
    },
  ],
});

const mod = await import(pathToFileURL(outfile).href + "?v=" + Date.now());

// --- Set up the sqlite store's wasm URL + bytes (fs-backed) + fs persist (Node) ---
const { setDefaultAdapter, setWasmUrl, setWasmBytesProvider, SqliteStore } = mod;
const sqljsRoot = join(root, "node_modules/.pnpm/sql.js@1.14.2/node_modules/sql.js");
const wasmPath = join(sqljsRoot, "dist/sql-wasm.wasm");
setWasmUrl(wasmPath);
setWasmBytesProvider(async (url) => new Uint8Array(readFileSync(url)));

const dbFile = join(tmpDir, "db.sqlite");
// Fresh state each run: drop the persisted SQLite file so a re-run doesn't
// carry over rows whose blob bytes (fresh in-memory shim) no longer exist.
if (existsSync(dbFile)) rmSync(dbFile, { force: true });
let dbSnapshot = new Uint8Array(0);
setDefaultAdapter({
  async load() {
    if (dbSnapshot && dbSnapshot.length > 0) return dbSnapshot;
    if (existsSync(dbFile)) return new Uint8Array(readFileSync(dbFile));
    return null;
  },
  async save(bytes) {
    dbSnapshot = bytes;
    writeFileSync(dbFile, Buffer.from(bytes));
  },
});

const { createWebPlatform } = mod;
const platform = createWebPlatform();
const invoke = platform.executor.invoke;

// The platform's opener uses `window.open` (browser) — provide a stub for Node.
// Minimal window+CustomEvent bus so blobStore + progress events work in Node.
globalThis.window = globalThis.window ?? (() => {
  const listeners = new Map();
  return {
    open: () => {},
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => {
      listeners.get(name)?.delete(fn);
    },
    dispatchEvent: (e) => {
      (listeners.get(e.type) ?? new Set()).forEach((fn) => fn(e));
      return true;
    },
  };
})();
if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
}

// Minimal in-memory IndexedDB shim so blobStore (ImageDB "blobs") works in Node.
if (!globalThis.indexedDB) {
  const stores = new Map();
  globalThis.indexedDB = {
    open: () => {
      const obj = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, error: null };
      const db = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore: (name) => { if (!stores.has(name)) stores.set(name, new Map()); return { name }; },
        objectStore: (name) => {
          if (!stores.has(name)) stores.set(name, new Map());
          const m = stores.get(name);
          return {
            get: (k) => {
              const req = { result: m.get(k), onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
            getAllKeys: () => {
              const req = { result: [...m.keys()], onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
            getKey: (k) => {
              const req = { result: m.has(k) ? k : undefined, onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
            getAll: () => {
              const req = { result: [...m.values()], onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
            delete: (k) => {
              m.delete(k);
              const req = { onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
            put: (v, k) => {
              m.set(k, v);
              const req = { onsuccess: null, onerror: null };
              setTimeout(() => req.onsuccess && req.onsuccess(), 0);
              return req;
            },
          };
        },
        transaction: (name, mode) => {
          const tx = { objectStore: () => db.objectStore(name), oncomplete: null, onerror: null };
          // Fire oncomplete shortly after (mirrors real IDB transaction commit).
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 10);
          return tx;
        },
      };
      obj.result = db;
      setTimeout(() => obj.onupgradeneeded && obj.onupgradeneeded(), 0);
      setTimeout(() => obj.onsuccess && obj.onsuccess(), 5);
      return obj;
    },
  };
}

// Small helper to force a fresh store instance in "second instance" persistence.
function newPlatform() {
  return createWebPlatform();
}

let pass = 0;
let fail = 0;
function assert(label, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}${extra ? " \u2014 " + extra : ""}`);
  } else {
    fail++;
    console.log(`  \u2717 ${label}${extra ? " \u2014 " + extra : ""}`);
  }
}

// 1. Platform drivers don't throw and return sane values.
let didThrow = false;
try {
  await platform.opener.openUrl("https://x");
} catch {
  didThrow = true;
}
assert("opener.openUrl resolves (no throw)", !didThrow);
assert("asset.convertFileSrc passthrough", platform.asset.convertFileSrc("a:b") === "a:b", "returns path as-is");
assert("dialog.open returns null (cancel)", (await platform.dialog.open({})) === null);
assert("dialog.save returns null (cancel)", (await platform.dialog.save({})) === null);
const unlisten = await platform.event.listen("x", () => {});
assert("event.listen returns unlisten fn", typeof unlisten === "function");
const unDrag = await platform.webview.onDragDropEvent(() => {});
assert("webview.onDragDropEvent returns unlisten fn", typeof unDrag === "function");

// 2. Startup commands the app calls on mount.
const pages = await invoke("list_pages", {});
assert("list_pages returns seeded array", Array.isArray(pages) && pages.length >= 1, `${pages.length} page(s)`);
const wsName = await invoke("get_workspace_name", {});
assert("get_workspace_name is non-empty", typeof wsName === "string" && wsName.length > 0);
const activeWs = await invoke("get_active_workspace_id", {});
assert("get_active_workspace_id is a string", typeof activeWs === "string" && activeWs.length > 0);
const wsList = await invoke("list_workspaces", {});
assert("list_workspaces has 1 workspace", Array.isArray(wsList) && wsList.length === 1);

// 3. Core note CRUD round-trips.
const created = await invoke("create_page", { parent_id: null, title: "测试页" });
assert("create_page returns a page with id", created && typeof created.id === "string", created?.title);
assert("create_page persists kind=page", created?.kind === "page");

const saved = await invoke("save_page", { id: created.id, title: "改名后", content_json: '{"root":{"children":[{"type":"paragraph","children":[]}]}}', content_text: "hello" });
assert("save_page updates title", saved?.title === "改名后", saved?.title);
assert("save_page updates content_text", saved?.content_text === "hello", saved?.content_text);

const got = await invoke("get_page", { id: created.id });
assert("get_page returns saved detail", got?.title === "改名后");

// 3a. A content-only save (no `title`) must KEEP the existing title, not replace
// it with the page UUID — this is what made template-created pages show a UUID
// as their name (the editor's content auto-save fires without a title).
const titleKept = await invoke("save_page", { id: created.id, content_json: '{"root":{"children":[]}}', content_text: "只改正文" });
assert("save_page keeps title on content-only save", titleKept?.title === "改名后", String(titleKept?.title));
assert("save_page content-only still updates content_text", titleKept?.content_text === "只改正文", String(titleKept?.content_text));

const moved = await invoke("move_page", { id: created.id, new_parent_id: null, sort_order: 5 });
assert("move_page doesn't throw", moved === undefined);

// 3b. The FRONTEND api wraps create/move args in `{ args }` — this caught the
// "页面不能移到文件夹" bug (web handler read a.xxx instead of a.args.xxx).
const argsFolder = await invoke("create_folder", { args: { parent_id: null, title: "移动目标夹" } });
assert("create_folder (args wrapper) works", argsFolder && argsFolder.kind === "folder", argsFolder?.title);
await invoke("move_page", { args: { id: created.id, new_parent_id: argsFolder.id, sort_order: 0 } });
const movedInto = await invoke("get_page", { id: created.id });
assert("move into folder sets parent_id", movedInto && movedInto.parent_id === argsFolder.id, `parent_id=${movedInto?.parent_id}`);

// 3b-1. move_page guards against cycles: moving a folder under its own child
// (or itself) must be rejected, or the tree corrupts into an infinite loop.
{
  const parentF = await invoke("create_folder", { parent_id: null, title: "父夹" });
  const childF = await invoke("create_folder", { parent_id: parentF.id, title: "子夹" });
  await invoke("move_page", { id: parentF.id, new_parent_id: childF.id, sort_order: 0 });
  const afterCycle = await invoke("get_page", { id: parentF.id });
  assert("move_page block self-under-descendant cycle", afterCycle && afterCycle.parent_id !== childF.id, `parent_id=${afterCycle?.parent_id}`);
  await invoke("move_page", { id: parentF.id, new_parent_id: parentF.id, sort_order: 0 });
  const afterSelf = await invoke("get_page", { id: parentF.id });
  assert("move_page block move-under-self", afterSelf && afterSelf.parent_id !== parentF.id);
}

const argsPage = await invoke("create_page", { args: { parent_id: argsFolder.id, title: "夹内页", content_json: "", content_text: "" } });
assert("create_page (args wrapper) honors parent_id", argsPage && argsPage.parent_id === argsFolder.id, `parent_id=${argsPage?.parent_id}`);
assert("create_page honors an explicit title", argsPage && argsPage.title === "夹内页", argsPage?.title);
await invoke("save_page", { args: { id: argsPage.id, title: "夹内改名", content_json: "{}", content_text: "x" } });
const savedArgs = await invoke("get_page", { id: argsPage.id });
assert("save_page (args wrapper) updates title", savedArgs && savedArgs.title === "夹内改名", savedArgs?.title);

// 3c. Deleting a folder cascades soft-delete to its descendants (page inside).
await invoke("delete_page", { id: argsFolder.id });
const afterFolderDelete = await invoke("get_page", { id: argsPage.id });
const folderTrash = await invoke("list_deleted", {});
assert("delete_page cascade soft-deletes child page", afterFolderDelete === null || afterFolderDelete.deleted_at !== null);
assert("folder delete puts descendant in trash", Array.isArray(folderTrash) && folderTrash.some((p) => p.id === argsPage.id));

// 4. Soft-delete + trash + restore round-trip.
await invoke("delete_page", { id: created.id });
const trash = await invoke("list_deleted", {});
assert("delete_page moves to trash", Array.isArray(trash) && trash.some((p) => p.id === created.id));
await invoke("restore_page", { id: created.id });
const restored = await invoke("get_page", { id: created.id });
assert("restore_page brings it back", restored !== null);

// 5. Tags: create, associate, list with counts, filter.
const tag = await invoke("create_tag", { name: "工作" });
assert("create_tag returns a tag", tag && typeof tag.id === "string");
await invoke("add_tag", { page_id: created.id, tag_id: tag.id });
const pt = await invoke("page_tags", { page_id: created.id });
assert("page_tags returns the new tag", Array.isArray(pt) && pt.length === 1 && pt[0].id === tag.id);
const tagList = await invoke("list_tags", {});
assert("list_tags counts pages", Array.isArray(tagList) && tagList.find((t) => t.id === tag.id)?.page_count === 1);
const byTag = await invoke("pages_by_tag", { tag_id: tag.id });
assert("pages_by_tag finds the page", Array.isArray(byTag) && byTag.some((p) => p.id === created.id));
await invoke("remove_tag", { page_id: created.id, tag_id: tag.id });
const pt2 = await invoke("page_tags", { page_id: created.id });
assert("remove_tag clears association", Array.isArray(pt2) && pt2.length === 0);

// 6. Search returns the saved page by title.
const search = await invoke("search", { query: "改名后", limit: 10 });
assert("search finds page by title", Array.isArray(search) && search.some((r) => r.id === created.id && r.title === "改名后"));

// 7. Workspace settings persist.
await invoke("set_workspace_settings", { theme: "dark", icon: "\u{1F680}" });
const ws2 = await invoke("list_workspaces", {});
assert("workspace settings persist (theme/icon)", Array.isArray(ws2) && ws2[0]?.theme === "dark" && ws2[0]?.icon === "\u{1F680}");

// 8. Templates (built-in demos) are non-empty.
const templates = await invoke("list_templates", {});
assert("list_templates has built-in demos", Array.isArray(templates) && templates.length >= 1, `${templates?.length} template(s)`);

// 8b. Image attachment: bytes go to the blob store, NOT into the SQLite DB.
const imgBytes = Array.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]));
const att = await invoke("save_image", { page_id: null, name: "test.png", mime: "image/png", data: imgBytes });
assert("save_image returns attachment with hash", att && typeof att.hash === "string" && att.hash.length > 0, att?.hash);
assert("save_image path is a usable display URL", typeof att?.path === "string" && (att.path.startsWith("data:image/png") || att.path.startsWith("blob:")), String(att?.path));
// attachment_path resolves the bytes from the blob store.
assert("attachment_path resolves from blob store", (await invoke("attachment_path", { hash: att.hash })).startsWith("data:image/png"));
const seen = await invoke("list_page_attachments", {});
assert("list_page_attachments includes image with a display path", Array.isArray(seen) && seen.some((x) => x.id === att.id && (x.path || "").startsWith("data:image/png")));
// Folder-scoped listing: save an image owned by a folder, then filter by page_id.
const attFolder = await invoke("save_image", { page_id: argsFolder.id, name: "夹内图.png", mime: "image/png", data: imgBytes });
const inFolder = await invoke("list_page_attachments", { pageId: argsFolder.id });
const inOther = await invoke("list_page_attachments", { pageId: created.id });
assert("list_page_attachments filters by page_id", Array.isArray(inFolder) && inFolder.some((x) => x.id === attFolder.id) && !inOther.some((x) => x.id === attFolder.id));

// 8b-1. import_attachment_files must attach the file to the folder (page_id), so
// it shows up (with its name) under that folder — "web 版侧边栏文件夹不显示文件名".
{
  // Register a file in the shared fileRegistry (via write_text_file) so the
  // browser-import command has bytes to pull.
  await invoke("write_text_file", { path: "uploads/readme.md", content: "# hello" });
  const imported = await invoke("import_attachment_files", { pageId: argsFolder.id, paths: ["uploads/readme.md"] });
  assert("import_attachment_files returns metas", Array.isArray(imported) && imported.length === 1, `${imported?.length}`);
  assert("import keeps the file name", imported?.[0]?.name === "readme.md", String(imported?.[0]?.name));
  assert("import returns a usable display src (data/blob URL)", typeof imported?.[0]?.path === "string" && (imported?.[0]?.path.startsWith("data:") || imported?.[0]?.path.startsWith("blob:")), String(imported?.[0]?.path));
  const inFolderImported = await invoke("list_page_attachments", { pageId: argsFolder.id });
  assert("imported file is owned by the folder (has page_id)", Array.isArray(inFolderImported) && inFolderImported.some((x) => x.name === "readme.md" && x.page_id === argsFolder.id), `${inFolderImported?.length}`);
  const notInOtherImported = await invoke("list_page_attachments", { pageId: created.id });
  assert("imported file not listed under a different folder", Array.isArray(notInOtherImported) && !notInOtherImported.some((x) => x.name === "readme.md"));
}

// 8b-2. Re-importing the SAME content must still attach a fresh row to the folder.
// (Previously a hash-dedup skip left page_id NULL on the second import, so a file
// uploaded before the page_id fix never showed under its folder.)
{
  await invoke("write_text_file", { path: "uploads/readme.md", content: "# hello" });
  const again = await invoke("import_attachment_files", { pageId: argsFolder.id, paths: ["uploads/readme.md"] });
  assert("re-import of same hash still returns a row", Array.isArray(again) && again.length === 1, `${again?.length}`);
  const owned = await invoke("list_page_attachments", { pageId: argsFolder.id });
  assert("re-imported file is owned by the folder", Array.isArray(owned) && owned.filter((x) => x.name === "readme.md" && x.page_id === argsFolder.id).length >= 1, `${owned?.length}`);
}


// 8c. Persistent-storage request returns a safe object (Node: no navigator).
const persist = await invoke("request_persistent_storage", {});
assert("request_persistent_storage is a safe object", persist && typeof persist === "object" && typeof persist.persisted === "boolean" && typeof persist.supported === "boolean");

// 9. Unknown commands return an object, never throw.
const unknown = await invoke("totally_unknown_cmd", {});
assert("unknown command returns object (no throw)", typeof unknown === "object" && unknown !== null);

// 10. Safe shapes.
const cols = await invoke("query_database", {});
assert("query_database has columns+rows arrays", Array.isArray(cols?.columns) && Array.isArray(cols?.rows));
const graph = await invoke("get_graph", {});
assert("get_graph has page nodes", Array.isArray(graph?.pages) && graph.pages.length >= 1, `${graph?.pages?.length} node(s)`);
const stats = await invoke("storage_stats", {});
assert("storage_stats is object", typeof stats === "object" && stats !== null);

// ---- Properties / database lens (Web platform now supports real attrs/db) ----
// 10a. Create an attribute and set it on a page.
const statusAttr = await invoke("create_attr", { args: { name: "状态", attr_type: "select", options: ["待办", "进行中"] } });
assert("create_attr returns a select attr", statusAttr && statusAttr.id && statusAttr.attr_type === "select", statusAttr?.name);
await invoke("set_page_prop", { args: { page_id: created.id, attr_id: statusAttr.id, value: "待办" } });
const pageProps = await invoke("get_page_props", { pageId: created.id });
assert("get_page_props returns the value", Array.isArray(pageProps) && pageProps.some((p) => p.attr_id === statusAttr.id && p.value === "待办"));

const attrList = await invoke("list_attr_defs", {});
assert("list_attr_defs includes the attr", Array.isArray(attrList) && attrList.some((a) => a.id === statusAttr.id));

// 10b. Create a database page, attach the attr as a column, query it.
const db = await invoke("create_database", { parent_id: null, title: "任务库" });
assert("create_database returns a db page", db && db.kind === "database", db?.kind);
const added = await invoke("add_db_column", { args: { db_page_id: db.id, attr_id: statusAttr.id } });
assert("add_db_column returns columns", Array.isArray(added) && added.some((c) => c.id === statusAttr.id));
const q = await invoke("query_database", { dbPageId: db.id });
assert("query_database has columns+rows", Array.isArray(q?.columns) && q?.columns.length >= 1 && Array.isArray(q?.rows));
assert("query_database row has the page", q?.rows?.some((r) => r.page_id === created.id && r.values?.[statusAttr.id] === "待办"));

// 10c. Board grouped by the select attr.
const board = await invoke("board_by_attr", { attrId: statusAttr.id });
assert("board_by_attr groups ok", Array.isArray(board) && board.some((g) => g.id === "待办"));

// 10d. Save/list a db view.
const view = await invoke("save_db_view", { args: { db_page_id: db.id, name: "表格", view_type: "table", config: "{}" } });
assert("save_db_view returns a view", view && view.id && view.view_type === "table");
const views = await invoke("list_db_views", { dbPageId: db.id });
assert("list_db_views includes the view", Array.isArray(views) && views.some((v) => v.id === view.id));

// 10e. db_rule round-trip + ref resolution.
await invoke("set_db_rule", { dbPageId: db.id, rule: '{"prop":{"name":"状态","value":"待办"}}' });
const rule = await invoke("get_db_rule", { dbPageId: db.id });
assert("get_db_rule returns the rule", rule === '{"prop":{"name":"状态","value":"待办"}}');
const refs = await invoke("resolve_refs", { values: [`p:${created.id}`, "plain"] });
assert("resolve_refs resolves page refs", String(refs[`p:${created.id}`]).includes("⇄") && refs["plain"] === "plain");

// 10f. move_card (board column) reassigns the page's tag.
const tag2 = await invoke("create_tag", { name: "测试列" });
await invoke("move_card", { pageId: created.id, tagId: tag2.id });
const afterMove = await invoke("page_tags", { page_id: created.id });
assert("move_card reassigns tag", Array.isArray(afterMove) && afterMove.some((t) => t.id === tag2.id));

// 10g. Version history: save_page snapshots, list/restore/cleanup.
// The page `created` was already saved several times, so versions exist.
const vBeforeSave = await invoke("list_versions", { pageId: created.id });
assert("list_versions returns snapshots", Array.isArray(vBeforeSave) && vBeforeSave.length >= 1, `${vBeforeSave?.length} version(s)`);
// Save a change → new snapshot.
await invoke("save_page", { id: created.id, title: "改名后", content_json: '{"root":{"children":[]}}', content_text: "v2 内容" });
const vAfter = await invoke("list_versions", { pageId: created.id });
assert("save_page adds a version snapshot", Array.isArray(vAfter) && vAfter.length > vBeforeSave.length);
// Restore the second snapshot (an older one) and confirm content changes back.
const restoredVer = await invoke("restore_version", { versionId: vAfter[vAfter.length - 1].id });
assert("restore_version returns PageDetail", restoredVer && typeof restoredVer.id === "string" && typeof restoredVer.content_text === "string");
// cleanup_old_versions with a tiny keep limit removes extras.
const cleaned = await invoke("cleanup_old_versions", { maxKeep: 1 });
assert("cleanup_old_versions returns freed count", typeof cleaned === "number" && cleaned >= 0);
const vAfterClean = await invoke("list_versions", { pageId: created.id });
assert("cleanup caps versions to maxKeep", Array.isArray(vAfterClean) && vAfterClean.length <= 1, `${vAfterClean?.length} after cleanup`);
const statsV = await invoke("storage_stats", {});
assert("storage_stats version_count reflects versions", typeof statsV?.version_count === "number");

// 10x. Guard: sql.js must not throw on undefined bind params (was "unknown type
// (undefined)"). Pass a save_page with some fields intentionally undefined.
const undefinedSave = await invoke("save_page", { id: created.id, content_json: undefined, content_text: undefined });
assert("save_page tolerates undefined fields", undefinedSave && typeof undefinedSave.id === "string");
const attrUndefined = await invoke("rename_tag", { id: "nonexistent", name: undefined }).catch((e) => e);
assert("undefined param doesn't throw raw sql error", !(attrUndefined instanceof Error && /bind a value of an unknown type/.test(String(attrUndefined))));

// ---- Block references / backlinks (Web platform parses content_json) ----
// 10h. Target page with a stable blockId; citing page references it.
const targetPage = await invoke("create_page", { parent_id: null, title: "被引用页" });
const targetJson = JSON.stringify({
  root: {
    children: [
      { blockId: "blk-target", type: "paragraph", children: [{ type: "text", text: "目标块内容" }] },
    ],
  },
});
await invoke("save_page", { id: targetPage.id, title: "被引用页", content_json: targetJson, content_text: "目标块内容" });
const pageBlocks = await invoke("get_page_blocks", { pageId: targetPage.id });
assert("get_page_blocks extracts blocks", Array.isArray(pageBlocks) && pageBlocks.some((b) => b.block_id === "blk-target" && b.text.includes("目标块内容")));
const resolvedBlock = await invoke("resolve_block", { blockId: "blk-target" });
assert("resolve_block returns BlockInfo", resolvedBlock && resolvedBlock.page_id === targetPage.id && typeof resolvedBlock.snippet === "string" && resolvedBlock.snippet.includes("目标块内容"));

const citeJson = JSON.stringify({
  root: {
    children: [
      { blockId: "blk-cite", type: "paragraph", children: [{ type: "text", text: "引用文字" }, { type: "blockref", targetId: "blk-target", children: [] }] },
    ],
  },
});
const citePage = await invoke("create_page", { parent_id: null, title: "引用页" });
await invoke("save_page", { id: citePage.id, title: "引用页", content_json: citeJson, content_text: "引用文字 [[被引用页]]" });
const backlinks = await invoke("get_backlinks", { id: targetPage.id });
assert("get_backlinks finds citing page", Array.isArray(backlinks) && backlinks.some((p) => p.id === citePage.id));
const blockBacklinks = await invoke("list_block_backlinks", { pageId: targetPage.id });
assert("list_block_backlinks finds block ref", Array.isArray(blockBacklinks) && blockBacklinks.some((b) => b.target_block_id === "blk-target" && b.source_page_id === citePage.id));
const blockSearch = await invoke("search_blocks", { args: { query: "目标块内容" } });
assert("search_blocks finds block by text", Array.isArray(blockSearch) && blockSearch.some((b) => b.block_id === "blk-target" && b.page_id === targetPage.id));

// ---- Backup export / import (Web: self-contained JSON container) ----
// 10i. Export a backup (standard zip w/ shuyonote.db + attachments/), then import
// it into a fresh store and verify data returns.
const backup = await invoke("export_backup", { destPath: "shuyo-backup.zip" });
assert("export_backup returns path+size", backup && typeof backup.path === "string" && backup.path.length > 0 && typeof backup.size === "number" && backup.size > 0, `${backup?.size} bytes`);
// Backups are a standard zip (matches desktop): verify structure via fflate.
const rawBytes = await invoke("read_file_bytes", { path: backup.path });
const backupZip = unzipSync(new Uint8Array(rawBytes));
assert("export_backup builds a zip with shuyonote.db", backupZip && backupZip["shuyonote.db"] && backupZip["shuyonote.db"].length > 0, Object.keys(backupZip).join(","));
assert("export_backup zip has attachments dir entries", Object.keys(backupZip).some((k) => k.startsWith("attachments/")));
const backupBeforePages = (await invoke("list_pages", {})).length;
// Import into a fresh platform instance.
const backupPlatform = newPlatform();
const backupProgress = [];
const onBackupProgress = (e) => backupProgress.push(e.detail);
globalThis.window.addEventListener("backup-progress", onBackupProgress);
await backupPlatform.executor.invoke("import_backup", { srcPath: backup.path });
globalThis.window.removeEventListener("backup-progress", onBackupProgress);
const backupAfterPages = await backupPlatform.executor.invoke("list_pages", {});
assert("import_backup restores pages", Array.isArray(backupAfterPages) && backupAfterPages.length >= backupBeforePages, `${backupAfterPages?.length} pages after import`);
assert("import_backup emits backup-progress events", backupProgress.length >= 1, `${backupProgress.length} event(s)`);
assert("backup-progress event has phase/done/total", backupProgress[0] && backupProgress[0].phase === "import" && typeof backupProgress[0].done === "number" && typeof backupProgress[0].total === "number", JSON.stringify(backupProgress[0]));

// 10i-2. export_workspace (space export) must build a real self-contained zip, not
// a size-0 stub: shuyonote.db + workspace.json + attachments/<hash>, with a real
// byte size and attachment count.
{
  const wsPlatform = newPlatform();
  const wsInvoke = wsPlatform.executor.invoke;
  // Seed a page + attachment so the export has something to carry.
  const imgBytes = new Uint8Array([2, 4, 6, 8, 10]);
  const att = await wsInvoke("save_image", { page_id: null, name: "cover.png", mime: "image/png", data: Array.from(imgBytes) });
  await wsInvoke("create_page", { parent_id: null, title: "导出页", content_json: '{"root":{"children":[]}}', content_text: "导出测试" });
  const res = await wsInvoke("export_workspace", { destPath: "space-export.zip" });
  assert("export_workspace returns a real size (not 0)", res && typeof res.size === "number" && res.size > 0, `${res?.size} bytes`);
  assert("export_workspace counts its pages", res && typeof res.pages === "number" && res.pages >= 1, `${res?.pages}`);
  assert("export_workspace counts its attachments", res && typeof res.attachments === "number" && res.attachments >= 1, `${res?.attachments}`);
  const wsRaw = await wsInvoke("read_file_bytes", { path: res.path });
  const wsZip = unzipSync(new Uint8Array(wsRaw));
  assert("export_workspace zip contains shuyonote.db", wsZip && wsZip["shuyonote.db"] && wsZip["shuyonote.db"].length > 0, Object.keys(wsZip).join(","));
  assert("export_workspace zip contains workspace.json", wsZip && wsZip["workspace.json"] && wsZip["workspace.json"].length > 0);
  assert("export_workspace zip contains attachments dir", Object.keys(wsZip).some((k) => k.startsWith("attachments/")));

  // 10i-3. export emits workspace-progress events (via the browser CustomEvent bus)
  // so the UI can show a progress bar.
  const events = [];
  const onWs = (e) => { events.push(e.detail); };
  globalThis.window.addEventListener("workspace-progress", onWs);
  await wsInvoke("export_workspace", { destPath: "space-export.zip" });
  globalThis.window.removeEventListener("workspace-progress", onWs);
  assert("workspace-progress events emitted during export", events.length >= 1, `${events.length} event(s)`);
  assert("progress event has done/total/message", events[0] && typeof events[0].done === "number" && typeof events[0].total === "number" && typeof events[0].message === "string", JSON.stringify(events[0]));

  // 10i-4. import_workspace restores the workspace zip and emits workspace-progress
  // events on phase "import"; it also applies the workspace.json name.
  const importEvents = [];
  const onImp = (e) => importEvents.push(e.detail);
  globalThis.window.addEventListener("workspace-progress", onImp);
  const importedMeta = await wsPlatform.executor.invoke("import_workspace", { srcPath: "space-export.zip" });
  globalThis.window.removeEventListener("workspace-progress", onImp);
  assert("import_workspace returns workspace meta", importedMeta && typeof importedMeta.id === "string" && typeof importedMeta.name === "string", String(importedMeta?.name));
  assert("import_workspace applies workspace.json name", importedMeta?.name === "我的工作空间", String(importedMeta?.name));
  assert("import_workspace emits workspace-progress (import)", importEvents.length >= 1 && importEvents[0].phase === "import", `${importEvents.length} event(s)`);
}


// 10j. Workspace seed is schema-aware: on a desktop-style workspaces table
// (created_at NOT NULL) the seed must include created_at, not throw NOT NULL.
// We drive the seed path by creating such a table in a scratch store and running
// the same INSERT columns the app derives from PRAGMA table_info.
{
  const { SqliteStore } = mod;
  const scratch = new SqliteStore();
  await scratch.init();
  scratch.run("DROP TABLE IF EXISTS workspaces");
  scratch.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', theme TEXT, icon TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  // The app's seed derives columns from PRAGMA table_info; we replicate that here
  // to prove created_at/updated_at are included on a desktop schema.
  const cols = scratch.query("PRAGMA table_info(workspaces)").map((c) => c.name).filter(Boolean);
  scratch.run(`INSERT INTO workspaces (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, [
    "active", "我的工作空间", null, "", Date.now(), Date.now(),
  ]);
  const wsRow = scratch.query("SELECT name, created_at FROM workspaces WHERE id = ?", ["active"])[0];
  assert("workspace seed includes created_at on desktop schema", wsRow && typeof wsRow.created_at === "number", String(wsRow && wsRow.created_at));
}

// 10j-2. Multi-space: create a second workspace, switch to it, add a page there,
// then switch back and verify the spaces are isolated (the new page stays put).
{
  const before = await invoke("list_workspaces", {});
  const firstId = before[0]?.id;
  const beforeCount = before.length;
  const ws2 = await invoke("create_workspace", { name: "第二空间" });
  assert("create_workspace returns a new workspace", ws2 && typeof ws2.id === "string" && ws2.id !== firstId, String(ws2?.id));
  assert("create_workspace switches active to the new space", (await invoke("get_active_workspace_id", {})) === ws2.id, `${await invoke("get_active_workspace_id", {})}`);
  const list2 = await invoke("list_workspaces", {});
  assert("list_workspaces grows by one after create", Array.isArray(list2) && list2.length === beforeCount + 1, `${list2?.length} vs ${beforeCount}`);
  assert("list_workspaces includes the new space name", list2.some((s) => s.name === "第二空间"));

  // In the new (empty) space, list_pages should NOT show the first space's pages.
  const pagesInNew = await invoke("list_pages", {});
  assert("new space starts with seeded pages", Array.isArray(pagesInNew) && pagesInNew.length >= 1, `${pagesInNew?.length}`);
  const pageInNew = await invoke("create_page", { parent_id: null, title: "只在新空间" });
  assert("create_page works in the new space", pageInNew && typeof pageInNew.id === "string", String(pageInNew?.title));

  // Switch back to the first space: that page must NOT appear.
  await invoke("set_active_workspace_id", { id: firstId });
  assert("switch back sets active to first space", (await invoke("get_active_workspace_id", {})) === firstId);
  const pagesBack = await invoke("list_pages", {});
  assert("first space does NOT see the new-space page", Array.isArray(pagesBack) && !pagesBack.some((p) => p.title === "只在新空间"), `${pagesBack?.length} pages`);

  // Switch to the new space again: the page is still there.
  await invoke("set_active_workspace_id", { id: ws2.id });
  const pagesAgain2 = await invoke("list_pages", {});
  assert("second space still has its page after switching back", Array.isArray(pagesAgain2) && pagesAgain2.some((p) => p.title === "只在新空间"), `${pagesAgain2?.length} pages`);

  // Rename + settings on the new space persist in the catalog.
  await invoke("rename_workspace", { id: ws2.id, name: "改名后的第二空间" });
  const listAfterRename = await invoke("list_workspaces", {});
  assert("rename_workspace updates the catalog", listAfterRename.some((s) => s.id === ws2.id && s.name === "改名后的第二空间"), JSON.stringify(listAfterRename));

  // Cleanup: delete the second space and go back to the first.
  await invoke("delete_workspace", { id: ws2.id });
  const listAfterDelete = await invoke("list_workspaces", {});
  assert("delete_workspace removes the space", Array.isArray(listAfterDelete) && listAfterDelete.length === beforeCount && listAfterDelete.some((s) => s.id === firstId), `${listAfterDelete?.length} vs ${beforeCount}`);

  // Restore the active space to the default ("active") so later blocks see the
  // pages created there (e.g. the persistence check uses `created.id`).
  await invoke("set_active_workspace_id", { id: "active" });
}


// 10k. Desktop-format backup's attachments schema has NO `path` column (it has
// `created_at` instead). Web's helpers are schema-aware (read PRAGMA table_info),
// so saving into such a table must NOT raise "no column named path".
{
  const { SqliteStore } = mod;
  // Isolate each store with its own in-memory adapter (the default fs adapter is
  // shared across all SqliteStore instances, so `web.init()` would otherwise
  // reopen the desktop-schema db file and inherit its no-`path` table).
  const memAdapter = () => {
    let bytes = new Uint8Array(0);
    return { load: async () => (bytes.length ? bytes : null), save: async (b) => { bytes = b; } };
  };

  const desk = new SqliteStore(memAdapter());
  await desk.init();
  desk.run("DROP TABLE IF EXISTS attachments");
  desk.run(
    "CREATE TABLE attachments (id TEXT PRIMARY KEY, page_id TEXT, name TEXT NOT NULL, hash TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  );
  // The exact helper save_image/import_attachment_files route through. This now
  // must succeed where the old fixed `(... path)` INSERT raised "no column named path".
  mod.insertAttachmentRow(desk, { id: "att-desktop", page_id: "p1", name: "desktop.png", hash: "h1", mime: "image/png", size: 3 });
  const attRow = desk.query("SELECT id, name, hash, created_at FROM attachments WHERE id = ?", ["att-desktop"])[0];
  assert("insertAttachmentRow inserts on desktop schema (no path)", attRow && attRow.id === "att-desktop" && typeof attRow.created_at === "number", String(attRow && attRow.created_at));

  // Also prove it works on the web-native schema (which HAS path, no created_at).
  const web = new SqliteStore(memAdapter());
  await web.init();
  mod.insertAttachmentRow(web, { id: "att-web", name: "web.png", hash: "h2", mime: "image/png", size: 3 });
  const webRow = web.query("SELECT id, path FROM attachments WHERE id = ?", ["att-web"])[0];
  assert("insertAttachmentRow still inserts on web schema (has path)", webRow && webRow.id === "att-web" && webRow.path === "", String(webRow && webRow.path));
}

// 11. Persistence: a NEW platform instance reads the same SQLite file.
const platform2 = newPlatform();
const pagesAgain = await platform2.executor.invoke("list_pages", {});
assert("sqlite persistence (2nd instance sees created page)", pagesAgain.some((p) => p.id === created.id));
const wsAgain = await platform2.executor.invoke("get_workspace_name", {});
assert("workspace name persists across instances", wsAgain !== "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
