// Boot smoke test for the SQLite-backed Web platform, run with plain node.
// It exercises the exact startup path the browser uses:
//   createWebPlatform() → sql.js WASM SQLite → core CRUD via SQL.
//
// Run:  node scripts/smoke-web.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
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

// 11. Persistence: a NEW platform instance reads the same SQLite file.
const platform2 = newPlatform();
const pagesAgain = await platform2.executor.invoke("list_pages", {});
assert("sqlite persistence (2nd instance sees created page)", pagesAgain.some((p) => p.id === created.id));
const wsAgain = await platform2.executor.invoke("get_workspace_name", {});
assert("workspace name persists across instances", wsAgain !== "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
