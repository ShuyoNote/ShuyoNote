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
globalThis.window = globalThis.window ?? { open: () => {} };

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

const moved = await invoke("move_page", { id: created.id, new_parent_id: null, sort_order: 5 });
assert("move_page doesn't throw", moved === undefined);

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
assert("save_image path is a data URL for display", typeof att?.path === "string" && att.path.startsWith("data:image/png"));
// attachment_path resolves the bytes from the blob store.
assert("attachment_path resolves from blob store", (await invoke("attachment_path", { hash: att.hash })).startsWith("data:image/png"));
const seen = await invoke("list_page_attachments", {});
assert("list_page_attachments includes image with a display path", Array.isArray(seen) && seen.some((x) => x.id === att.id && (x.path || "").startsWith("data:image/png")));

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
// 10i. Export a backup, then import it into a fresh store and verify data returns.
const backup = await invoke("export_backup", { destPath: "shuyo-backup.json" });
assert("export_backup returns path+size", backup && typeof backup.path === "string" && backup.path.length > 0 && typeof backup.size === "number" && backup.size > 0, `${backup?.size} bytes`);
// export_backup registered the container into fileRegistry under the filename.
const containerContent = JSON.parse(await invoke("read_text_file", { path: backup.path }));
assert("export_backup builds a parseable container", containerContent.format === "shuyonote-web-backup" && typeof containerContent.db === "string" && typeof containerContent.attachments === "object");
const backupBeforePages = (await invoke("list_pages", {})).length;
// Import into a fresh platform instance.
const backupPlatform = newPlatform();
await backupPlatform.executor.invoke("import_backup", { srcPath: backup.path });
const backupAfterPages = await backupPlatform.executor.invoke("list_pages", {});
assert("import_backup restores pages", Array.isArray(backupAfterPages) && backupAfterPages.length >= backupBeforePages, `${backupAfterPages?.length} pages after import`);

// 11. Persistence: a NEW platform instance reads the same SQLite file.
const platform2 = newPlatform();
const pagesAgain = await platform2.executor.invoke("list_pages", {});
assert("sqlite persistence (2nd instance sees created page)", pagesAgain.some((p) => p.id === created.id));
const wsAgain = await platform2.executor.invoke("get_workspace_name", {});
assert("workspace name persists across instances", wsAgain !== "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
