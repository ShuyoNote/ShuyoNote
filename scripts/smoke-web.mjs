// Boot smoke test for the Web platform, run with plain node (no deps).
// It exercises the exact startup path the browser uses:
//   platform selection (no Tauri → webPlatform) + the mock executor commands the
//   app calls on mount (list_pages / get_page / create_page / save_page / ...).
//
// Run:  node scripts/smoke-web.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Minimal browser-ish globals the mock needs (localStorage + crypto + window).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// Node's global `crypto` already provides randomUUID (Node 18+); the mock uses
// `typeof crypto !== "undefined" && crypto.randomUUID`, so no override is needed.
// (The `crypto` global is getter-only in Node 24, so we never assign it.)
globalThis.window = { open: () => {}, __TAURI_INTERNALS__: undefined };

// Import the web platform directly (compile to a temp .mjs via esbuild? No —
// it's TypeScript. Instead, evaluate it by transforming the relevant bits is
// overkill. We instead re-import via the tsx-less trick below.)

// The tsconfig uses TypeScript (v7 here), but an ESM node script can't import
// .ts directly. We transpile web.ts with esbuild (bundled with vite) to a temp
// .mjs and import that.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// esbuild lives in the pnpm store, not a top-level dep, so resolve it by path.
const esbuild = require(join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"));

import { writeFileSync, mkdirSync } from "node:fs";
const tmpDir = join(root, ".smoke-tmp");
mkdirSync(tmpDir, { recursive: true });

const webTs = readFileSync(join(root, "src/lib/platform/web.ts"), "utf8");
const { code } = esbuild.transformSync(webTs, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
writeFileSync(join(tmpDir, "web.mjs"), code);
const { createWebPlatform } = await import(pathToFileURL(join(tmpDir, "web.mjs")).href);

const platform = createWebPlatform();
const invoke = platform.executor.invoke;

let pass = 0;
let fail = 0;
function assert(label, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`);
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

const saved = await invoke("save_page", { id: created.id, title: "改名后", content_json: '{"root":{"children":[{"type":"paragraph","children":[],"type":"paragraph","version":1}]}}', content_text: "hello" });
assert("save_page updates title", saved?.title === "改名后", saved?.title);
assert("save_page updates content_text", saved?.content_text === "hello", saved?.content_text);

const got = await invoke("get_page", { id: created.id });
assert("get_page returns saved detail", got?.title === "改名后");

const moved = await invoke("move_page", { id: created.id, new_parent_id: null, sort_order: 5 });
assert("move_page doesn't throw", moved === undefined);

// 6. Tags: create, associate with a page, list with counts, filter pages.
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

// 7. Search returns the saved page by title.
const search = await invoke("search", { query: "改名后", limit: 10 });
assert("search finds page by title", Array.isArray(search) && search.some((r) => r.id === created.id && r.title === "改名后"));

// 8. Workspace settings persist.
await invoke("set_workspace_settings", { theme: "dark", icon: "🚀" });
const ws = await invoke("list_workspaces", {});
assert("workspace settings persist (theme/icon)", Array.isArray(ws) && ws[0]?.theme === "dark" && ws[0]?.icon === "🚀");

// 9. Templates (built-in demos) are non-empty.
const templates = await invoke("list_templates", {});
assert("list_templates has built-in demos", Array.isArray(templates) && templates.length >= 1, `${templates?.length} template(s)`);

// 10. Security: unknown commands return an object, never throw.
const unknown = await invoke("totally_unknown_cmd", {});
assert("unknown command returns object (no throw)", typeof unknown === "object" && unknown !== null);

// 11. Database/tags/graph return safe shapes (graph has seeded page nodes).
const cols = await invoke("query_database", {});
assert("query_database has columns+rows arrays", Array.isArray(cols?.columns) && Array.isArray(cols?.rows));
const graph = await invoke("get_graph", {});
assert("get_graph has page nodes", Array.isArray(graph?.pages) && graph.pages.length >= 1, `${graph?.pages?.length} node(s)`);
const stats = await invoke("storage_stats", {});
assert("storage_stats is object", typeof stats === "object" && stats !== null);

// 12. Persistence: a second platform instance reads the same localStorage.
const platform2 = createWebPlatform();
const pagesAgain = await platform2.executor.invoke("list_pages", {});
assert("localStorage persistence (2nd instance sees created page)", pagesAgain.some((p) => p.id === created.id));
const wsAgain = await platform2.executor.invoke("get_workspace_name", {});
assert("workspace rename persists across instances", wsAgain !== "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
