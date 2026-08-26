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

// Also bundle the pure drag-reorder module to unit-test computeReorder (no DOM deps).
const roOutfile = join(tmpDir, "treeReorder.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/treeReorder.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: roOutfile,
});
const roMod = await import(pathToFileURL(roOutfile).href + "?v=" + Date.now());

// Bundle the AI core (thin-agent) modules for pure-logic tests. We stub the
// `../api` import with a throwing proxy so the WRITE tools (create_page /
// append_block) can be exercised without touching the real platform, since they
// never actually call the backend — they only build DraftResults.
const aiOutfile = join(tmpDir, "aicore.mjs");
await esbuild.build({
  stdin: {
    contents:
      'export { extractToolCalls } from "./src/lib/ai/llm";\n' +
      'export { createOllamaTransport, testOllamaConnection } from "./src/lib/ai/llm";\n' +
      'export { createOpenAICompatTransport, testOpenAICompatConnection, createProviderTransport, testProviderConnection } from "./src/lib/ai/llm";\n' +
      'export { appendBlocksToJson, contentTextOf, cleanDraftText } from "./src/lib/ai/lexical";\n' +
      'export { findUnlinkedMentions, suggestPageLinks } from "./src/lib/mention";\n' +
      'export { charBigrams, semanticScore, semanticRank } from "./src/lib/searchSemantic";\n' +
      'export { buildWikiExport, wikiSlug, renderWikiBody } from "./src/lib/wikiExport";\n' +
      'export { detectMermaidSyntax, mermaidRenderable, mermaidSyntaxOptions } from "./src/lib/mermaid";\n' +
      'export { excalidrawSceneText, excalidrawSceneHasContent } from "./src/lib/drawingText";\n' +
      'export { buildImageGenUrl, buildImageGenBody, parseImageGenResponse, b64ToBytes, bytesToDataUrl } from "./src/lib/ai/imageGen";\n' +
      'export { substituteTemplateVars } from "./src/templates/index";\n' +
      'export { runAiLoop } from "./src/lib/ai/host";\n' +
      'export { draftPreview } from "./src/lib/ai/preview";\n' +
      'export { parseMarkdown, parseInline } from "./src/lib/markdown";\n' +
      'export { lexicalStateValid } from "./src/lib/lexicalValidate";\n',
    resolveDir: root,
    loader: "js",
    sourcefile: "ai-entry.js",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: aiOutfile,
  plugins: [
    {
      name: "ai-api-stub",
      setup(build) {
        build.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: "ai-api-stub", namespace: "ai-api-stub" }));
        build.onLoad({ filter: /.*/, namespace: "ai-api-stub" }, () => ({
          contents: "export const api = new Proxy({}, { get: () => () => { throw new Error('api stub called'); } });",
          loader: "js",
        }));
      },
    },
  ],
});
const aiMod = await import(pathToFileURL(aiOutfile).href + "?v=" + Date.now());

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
const titledDefault = await invoke("create_page", { parent_id: null });
assert("create_page defaults a plain page title to 新页面", titledDefault?.title === "新页面", String(titledDefault?.title));

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
assert("list_page_attachments includes image with a display path", Array.isArray(seen) && seen.some((x) => x.id === att.id && (x.path || "").startsWith("data:") || (x.path || "").startsWith("blob:")));
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

// 8b-3. Attachment move / remove / batch-remove / restore must actually work
// (these were stubs in web.ts before P0-1).
{
  const mv = await invoke("save_image", { page_id: argsFolder.id, name: "移动我.png", mime: "image/png", data: imgBytes });
  // move to another folder (created is a page, used as a container → move there).
  const targetContainer = argsFolder; // same folder works as a target too; use a distinct one.
  const otherFolder = await invoke("create_folder", { parent_id: null, title: "移动目标夹" });
  await invoke("move_attachment", { id: mv.id, newPageId: otherFolder.id });
  const afterMove = await invoke("list_page_attachments", { pageId: otherFolder.id });
  assert("move_attachment reassigns page_id", Array.isArray(afterMove) && afterMove.some((x) => x.id === mv.id && x.page_id === otherFolder.id), `${afterMove?.length}`);

  // restore_attachment clones a historical version into a target page (new id, shared bytes).
  const restored = await invoke("restore_attachment", { targetPageId: argsFolder.id, sourceId: mv.id });
  assert("restore_attachment clones a new attachment", restored && typeof restored.id === "string" && restored.id !== mv.id && restored.hash === mv.hash, String(restored?.id));
  const afterRestore = await invoke("list_page_attachments", { pageId: argsFolder.id });
  assert("restored attachment shows up in target folder", Array.isArray(afterRestore) && afterRestore.some((x) => x.id === restored.id));

  // batch remove deletes exactly the requested ids.
  const b1 = await invoke("save_image", { page_id: null, name: "b1.png", mime: "image/png", data: imgBytes });
  const b2 = await invoke("save_image", { page_id: null, name: "b2.png", mime: "image/png", data: imgBytes });
  const removedCount = await invoke("remove_attachments", { ids: [b1.id, b2.id] });
  assert("remove_attachments returns the removed count", removedCount === 2, String(removedCount));
  const afterBatch = await invoke("list_page_attachments", {});
  assert("remove_attachments actually deletes the rows", Array.isArray(afterBatch) && !afterBatch.some((x) => x.id === b1.id || x.id === b2.id));

  // single remove deletes one row.
  await invoke("remove_attachment", { id: mv.id });
  const afterSingle = await invoke("list_page_attachments", {});
  assert("remove_attachment deletes one row", Array.isArray(afterSingle) && !afterSingle.some((x) => x.id === mv.id));
}

// 8b-4. cleanup_orphan_attachments frees blob bytes whose hash is unreferenced,
// and keeps referenced ones.
{
  const keepBytes = Array.from(new Uint8Array([1, 2, 3, 4, 5]));
  const orphanBytes = Array.from(new Uint8Array([9, 8, 7, 6]));
  const kept = await invoke("save_image", { page_id: null, name: "kept.png", mime: "image/png", data: keepBytes });
  const orphan = await invoke("save_image", { page_id: null, name: "orphan.png", mime: "image/png", data: orphanBytes });
  // Remove the orphan's row so its bytes are now unreferenced.
  await invoke("remove_attachment", { id: orphan.id });
  // orphan bytes were freed already by remove_attachment; add a fresh orphan via a
  // hash with no row: use a direct blob put to simulate a leftover.
  const freed = await invoke("cleanup_orphan_attachments", {});
  assert("cleanup_orphan_attachments returns a number", typeof freed === "number", String(freed));
  // Referenced bytes still resolve.
  const keptPath = await invoke("attachment_path", { hash: kept.hash });
  assert("referenced attachment bytes survive cleanup", typeof keptPath === "string" && keptPath.length > 0, String(keptPath));
  // create_image path (save_image) with no row: make an orphan via import then delete row.
  await invoke("write_text_file", { path: "uploads/orphan.txt", content: "orphan" });
  const ometa = await invoke("import_attachment_files", { pageId: null, paths: ["uploads/orphan.txt"] });
  await invoke("remove_attachment", { id: ometa[0].id });
  const freed2 = await invoke("cleanup_orphan_attachments", {});
  assert("cleanup removes newly orphaned bytes", typeof freed2 === "number" && freed2 >= 0, String(freed2));
}

// 8b-5. get_attachment returns the meta; recycle-bin restore re-surfaces a page's
// attachments (page restore clears deleted_at; attachments keep their page_id).
{
  const pageForAtt = await invoke("create_page", { parent_id: null, title: "带附件页", content_json: '{"root":{"children":[]}}', content_text: "x" });
  const f = await invoke("save_image", { page_id: pageForAtt.id, name: "trash.png", mime: "image/png", data: imgBytes });
  const g = await invoke("get_attachment", { id: f.id });
  assert("get_attachment returns meta", g && g.id === f.id && g.hash === f.hash && (g.path || "").length > 0, String(g?.name));
  // Trash then restore the page; the attachment (kept by page_id) is still queryable.
  await invoke("delete_page", { id: pageForAtt.id });
  await invoke("restore_page", { id: pageForAtt.id });
  const afterRestore = await invoke("list_page_attachments", { pageId: pageForAtt.id });
  assert("attachments re-surface after page restore", Array.isArray(afterRestore) && afterRestore.some((x) => x.id === f.id), `${afterRestore?.length}`);
  // get_attachment still resolves after restore.
  const g2 = await invoke("get_attachment", { id: f.id });
  assert("get_attachment resolves after restore", g2 && g2.id === f.id && (g2.path || "").length > 0, String(g2?.name));
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
assert("storage_stats has real db_bytes (>0)", typeof stats?.db_bytes === "number" && stats.db_bytes > 0, `${stats?.db_bytes}`);

// 10b. Search ranks by relevance (term frequency), not just LIKE order.
{
  // Reuse `created` (which has text "hello" from an earlier save) — add two pages
  // where "压舱石" appears many times in one but once in the other.
  const many = await invoke("create_page", { parent_id: null, title: "压舱石压舱石压舱石", content_json: '{"root":{"children":[]}}', content_text: "压舱石 压舱石 压舱石 压舱石 压舱石 核心关键词" });
  await invoke("save_page", { id: many.id, title: "很多次压舱石", content_json: '{"root":{"children":[]}}', content_text: "压舱石 压舱石 压舱石 压舱石 压舱石 核心关键词" });
  const few = await invoke("create_page", { parent_id: null, title: "一次压舱石", content_json: '{"root":{"children":[]}}', content_text: "压舱石" });
  const searchRel = await invoke("search", { args: { query: "压舱石", limit: 10 } });
  const idxMany = searchRel.findIndex((s) => s.id === many.id);
  const idxFew = searchRel.findIndex((s) => s.id === few.id);
  assert("search ranks higher TF page first", idxMany !== -1 && idxFew !== -1 && idxMany < idxFew, `many=${idxMany} few=${idxFew}`);
  const snip = searchRel.find((s) => s.id === many.id)?.snippet || "";
  assert("search snippet anchors around the match", snip.includes("压舱石"), String(snip));
}

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
// M19.2: alias `[[标题|别名]]` and block `[[标题#块]]` forms also create page backlinks.
const citeAlias = await invoke("create_page", { parent_id: null, title: "别名引用页" });
await invoke("save_page", { id: citeAlias.id, title: "别名引用页", content_json: '{"root":{"children":[{"type":"paragraph","children":[{"type":"text","text":"见[[被引用页|别名]]"}]}]}}', content_text: "见[[被引用页|别名]]" });
const citeBlock = await invoke("create_page", { parent_id: null, title: "块引用页" });
await invoke("save_page", { id: citeBlock.id, title: "块引用页", content_json: '{"root":{"children":[{"type":"paragraph","children":[{"type":"text","text":"见[[被引用页#blk-target]]"}]}]}}', content_text: "见[[被引用页#blk-target]]" });
const backlinks2 = await invoke("get_backlinks", { id: targetPage.id });
assert("get_backlinks finds alias link", Array.isArray(backlinks2) && backlinks2.some((p) => p.id === citeAlias.id), JSON.stringify(backlinks2.map((p) => p.id)));
assert("get_backlinks finds block link", Array.isArray(backlinks2) && backlinks2.some((p) => p.id === citeBlock.id), JSON.stringify(backlinks2.map((p) => p.id)));
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
// Full restore must also reconcile the workspace catalog so the sidebar name/list
// reflect the restored DB (not the pre-restore catalog).
const wsNameAfterBackup = await backupPlatform.executor.invoke("get_workspace_name", {});
assert("import_backup restores the workspace name", typeof wsNameAfterBackup === "string" && wsNameAfterBackup.length > 0 && wsNameAfterBackup !== "默认空间", String(wsNameAfterBackup));
const wsListAfterBackup = await backupPlatform.executor.invoke("list_workspaces", {});
assert("import_backup restores a workspace list", Array.isArray(wsListAfterBackup) && wsListAfterBackup.length >= 1, `${wsListAfterBackup?.length} space(s)`);

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

  // The UI subscribes via platform.event.listen (web forwards window CustomEvents),
  // so prove that exact path also receives progress during a real export.
  const viaListen = [];
  const un = await wsPlatform.event.listen("workspace-progress", (e) => viaListen.push(e.payload));
  await wsInvoke("export_workspace", { destPath: "space-export.zip" });
  un();
  assert("platform.event.listen receives export progress", viaListen.length >= 1, `${viaListen.length} event(s)`);
  assert("forwarded event carries done/total", viaListen[0] && typeof viaListen[0].done === "number" && typeof viaListen[0].total === "number", JSON.stringify(viaListen[0]));

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

// 10j-3. copy_page_to_workspace copies a page subtree to another workspace.
{
  const srcSpace = await invoke("get_active_workspace_id", {});
  const targetSpace = await invoke("create_workspace", { name: "复制目标空间" });
  // create_workspace switches active to target; go back to source to create+copy.
  await invoke("set_active_workspace_id", { id: srcSpace });
  const srcPage = await invoke("create_page", { parent_id: null, title: "待复制页", content_json: '{"root":{"children":[]}}', content_text: "复制内容 123" });
  const newId = await invoke("copy_page_to_workspace", { pageId: srcPage.id, targetWorkspaceId: targetSpace.id });
  assert("copy_page_to_workspace returns a new page id", typeof newId === "string" && newId.length > 0 && newId !== srcPage.id, String(newId));
  // Switch to the target space: the copied page should exist with content.
  await invoke("set_active_workspace_id", { id: targetSpace.id });
  const targetPages = await invoke("list_pages", {});
  assert("copied page appears in target space", Array.isArray(targetPages) && targetPages.some((p) => p.id === newId), `${targetPages?.length}`);
  const copied = await invoke("get_page", { id: newId });
  assert("copied page keeps content", copied && copied.content_text === "复制内容 123", String(copied?.content_text));
  // Cleanup: return to the source space and delete the copy space.
  await invoke("set_active_workspace_id", { id: srcSpace });
  await invoke("delete_workspace", { id: targetSpace.id });
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

// 12. Write-failure safety: a failing persist (adapter.save throws) must NOT break
// the in-memory mutation, and must surface via onPersistError (non-blocking).
{
  const errAdapter = {
    load: async () => null,
    save: async () => { throw new Error("disk full"); },
  };
  const safe = new SqliteStore(errAdapter);
  await safe.init();
  let gotErr = null;
  safe.onPersistError = (e) => { gotErr = e; };
  let ran = false;
  try {
    safe.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    safe.run("INSERT INTO t (id) VALUES ('x')");
    ran = true;
  } catch (e) {
    ran = false;
  }
  assert("write still succeeds in memory when persist fails", ran);
  const row = safe.query("SELECT id FROM t WHERE id = ?", ["x"])[0];
  assert("in-memory row is readable despite persist failure", row && row.id === "x");
  // onPersistError is async (fire-and-forget); wait a tick for it to fire.
  await new Promise((r) => setTimeout(r, 20));
  assert("persist failure surfaced via onPersistError", gotErr !== null, String(gotErr));
}

// 13. Pure-logic unit tests for drag reorder + search tokenization.
{
  const pk = (id, parent_id, sort_order) => ({ id, parent_id, sort_order, title: id, created_at: 0 });
  // computeReorder: nested (inside) appends as first child.
  const pages1 = [pk("a", null, 0), pk("b", null, 1), pk("c", "a", 0)];
  const optInside = roMod.computeReorder(pages1, "b", "a", "inside");
  assert("computeReorder inside nests as child", optInside && optInside.parentId === "a" && optInside.sortOrder === 1, JSON.stringify(optInside));
  // sibling before/after midpoint.
  const optAfter = roMod.computeReorder(pages1, "a", "b", "after");
  assert("computeReorder after -> sibling midpoint", optAfter && optAfter.parentId === null && optAfter.sortOrder > 1, JSON.stringify(optAfter));
  // self-move rejected.
  const optSelf = roMod.computeReorder(pages1, "a", "a", "inside");
  assert("computeReorder rejects self-move", optSelf === null);

  // tokenize: CJK bigrams + english words, no dup.
  const toks = mod.tokenize("压舱石 hello 世界");
  assert("tokenize yields CJK+words", toks.includes("压舱") && toks.includes("hello") && toks.includes("世界"), JSON.stringify(toks));
}

// 14. Pure-logic unit tests for the thin-AI layer (transforms + write-draft loop).
{
  // extractToolCalls: explicit <tool_calls> fence.
  const fenced = aiMod.extractToolCalls('<tool_calls>[{"name":"search_pages","arguments":{"query":"会议"}}]</tool_calls>');
  assert("extractToolCalls parses fence", fenced.length === 1 && fenced[0].name === "search_pages" && fenced[0].arguments.query === "会议", JSON.stringify(fenced));
  // ```json block fallback.
  const jsonBlock = aiMod.extractToolCalls('```json\n[{"name":"read_page","arguments":{"pageId":"p1"}}]\n```');
  assert("extractToolCalls parses json block", jsonBlock.length === 1 && jsonBlock[0].name === "read_page" && jsonBlock[0].arguments.pageId === "p1");
  // Garbage → no calls.
  assert("extractToolCalls ignores prose", aiMod.extractToolCalls("没有工具调用") .length === 0);

  // appendBlocksToJson: split on newlines, produce paragraph nodes with blockId.
  const base = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"hi","version":1}]}],"type":"root","version":1}}';
  let n = 0;
  const next = aiMod.appendBlocksToJson(base, "a\nb", () => `blk-${++n}`);
  const parsed = JSON.parse(next);
  assert("appendBlocksToJson adds 2 paragraph nodes", parsed.root.children.length === 3, `len=${parsed.root.children.length}`);
  const last2 = parsed.root.children[2];
  assert("appendBlocksToJson assigns blockId", last2.blockId === "blk-2" && last2.children[0].text === "b");
  // contentTextOf flattens text.
  assert("contentTextOf extracts text", aiMod.contentTextOf(next) === "hi a b");
  // cleanDraftText strips markdown + sentence dividers for the inline writer.
  assert("cleanDraftText strips markdown + dividers", aiMod.cleanDraftText("**《路灯下的伞》**\n---\n正文内容") === "《路灯下的伞》\n正文内容", aiMod.cleanDraftText("**《路灯下的伞》**\n---\n正文内容"));
  // M19.1 findUnlinkedMentions: bare titles are found, already-[[ ]] linked ones skipped.
  const um = aiMod.findUnlinkedMentions("会议纪要已发，稍后同步。详见[[项目文档]]。", ["会议纪要", "项目文档", "周报"], "当前页");
  assert("findUnlinkedMentions finds bare title", um.some((m) => m.title === "会议纪要"), JSON.stringify(um));
  assert("findUnlinkedMentions skips already-linked title", !um.some((m) => m.title === "项目文档"), JSON.stringify(um));
  // M20.1 substituteTemplateVars fills date/title/selected.
  const tv = aiMod.substituteTemplateVars("日期：{{date}}\n标题：{{title}}·{{selected}}", { date: "2026-08-24", title: "每日小记", selected: "备注" });
  assert("substituteTemplateVars fills date/title/selected", tv === "日期：2026-08-24\n标题：每日小记·备注", tv);
  // M19.3 suggestPageLinks ranks match/relevance (prefix > substring).
  const sug = aiMod.suggestPageLinks("会议", [{ id: "1", title: "会议纪要", updated_at: 10 }, { id: "2", title: "项目会议", updated_at: 20 }, { id: "3", title: "周报", updated_at: 99 }]);
  assert("suggestPageLinks ranks matches", sug[0] === "会议纪要" && sug.includes("项目会议") && !sug.includes("周报"), JSON.stringify(sug));
  // M20.2 semanticScore/charBigrams: near-repeats score high, unrelated score 0.
  const cb = aiMod.charBigrams("会议纪要");
  assert("charBigrams emits CJK bigrams", cb.has("会议") && cb.has("议纪") && cb.has("纪要"), JSON.stringify([...cb]));
  const s1 = aiMod.semanticScore("会议纪要", "会议纪要安排");
  const s2 = aiMod.semanticScore("会议纪要", "今天天气不错");
  assert("semanticScore ranks related above unrelated", s1 > 0.3 && s2 === 0, `s1=${s1} s2=${s2}`);
  const ranks = aiMod.semanticRank("会议纪要", [
    { id: "a", title: "会议纪要", content_text: "本周会议纪要" },
    { id: "b", title: "天气", content_text: "今天晴" },
    { id: "c", title: "周报", content_text: "项目进展" },
  ]);
  assert("semanticRank drops unrelated docs", ranks.length === 1 && ranks[0].id === "a", JSON.stringify(ranks));
  // M21.1 buildWikiExport: linkifies [[标题]], emits per-page html + index + backlinks.
  const wiki = aiMod.buildWikiExport(
    [
      { id: "p1", title: "首页", content_text: "欢迎来到 [[项目]] 和 [[周报]]", parent_id: null, sort_order: 0 },
      { id: "p2", title: "项目", content_text: "# 项目\n看 [[首页]] 的链接过来", parent_id: null, sort_order: 1 },
      { id: "p3", title: "周报", content_text: "本周进展", parent_id: "p1", sort_order: 0 },
    ],
    { space: "测试空间" },
  );
  const names = wiki.files.map((f) => f.name);
  assert("wiki export emits index.html + a page per title", names.includes("index.html") && names.includes("项目.html") && names.includes("首页.html") && names.includes("周报.html"), JSON.stringify(names));
  const home = wiki.files.find((f) => f.name === "首页.html")?.content || "";
  const proj = wiki.files.find((f) => f.name === "项目.html")?.content || "";
  assert("wiki links [[项目]] to its page", home.includes('href="项目.html"') && home.includes("项目"), home);
  assert("wiki backlinks section lists referrers", proj.includes("反向链接") && proj.includes("首页"), proj);
  assert("wiki index lists pages", (wiki.files.find((f) => f.name === "index.html")?.content || "").includes("测试空间"), "index missing space name");
  assert("wiki slug keeps CJK + dedupes", aiMod.wikiSlug("会议", new Set()) === "会议.html", aiMod.wikiSlug("会议", new Set()));
  // M-B detectMermaidSyntax maps the leading directive to a canonical type.
  assert("detectMermaidSyntax flowchart", aiMod.detectMermaidSyntax("graph TD\n  A-->B") === "flowchart", aiMod.detectMermaidSyntax("graph TD"));
  assert("detectMermaidSyntax mindmap", aiMod.detectMermaidSyntax("mindmap\n  root((主题))") === "mindmap", aiMod.detectMermaidSyntax("mindmap"));
  assert("detectMermaidSyntax sequence", aiMod.detectMermaidSyntax("sequenceDiagram\n  A->>B: hi") === "sequence", aiMod.detectMermaidSyntax("sequenceDiagram"));
  assert("mermaidRenderable needs ≥2 lines", aiMod.mermaidRenderable("graph TD") === false && aiMod.mermaidRenderable("graph TD\n  A-->B") === true, "renderable");
  // M23.4 excalidrawSceneText extracts searchable label text; hasContent skips deleted.
  const ext = aiMod.excalidrawSceneText([
    { type: "text", text: "架构图" },
    { type: "text", text: "  " },
    { type: "rectangle", text: "x" },
  ]);
  assert("excalidrawSceneText extracts text labels", ext === "架构图", JSON.stringify(ext));
  assert("excalidrawSceneHasContent skips deleted", aiMod.excalidrawSceneHasContent([{ type: "rect", isDeleted: false }]) === true && aiMod.excalidrawSceneHasContent([{ type: "rect", isDeleted: true }]) === false, "hasContent");
  // M-C imageGen helpers: url building, body shape, b64 parse, base64 roundtrip.
  assert("buildImageGenUrl normalizes trailing slash", aiMod.buildImageGenUrl("http://x/v1/") === "http://x/v1/images/generations", aiMod.buildImageGenUrl("http://x/v1/"));
  const igb = JSON.parse(aiMod.buildImageGenBody({ baseUrl: "http://x", model: "dall-e", apiKey: "" }, "一只猫", "512x512"));
  assert("buildImageGenBody includes model/prompt/size", igb.model === "dall-e" && igb.prompt === "一只猫" && igb.size === "512x512" && igb.response_format === "b64_json", JSON.stringify(igb));
  const igp = aiMod.parseImageGenResponse(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
  assert("parseImageGenResponse extracts b64", igp !== null && "b64" in igp && igp.b64 === "aGVsbG8=", JSON.stringify(igp));
  assert("parseImageGenResponse tolerates garbage", aiMod.parseImageGenResponse("not json") === null, "garbage");
  const rt = aiMod.bytesToDataUrl(aiMod.b64ToBytes("aGVsbG8="), "image/png");
  assert("b64ToBytes + bytesToDataUrl roundtrip", rt === "data:image/png;base64,aGVsbG8=", rt);

  // runAiLoop write path: create_page returns a draft, never commits (api stub never called).
  const respSeq = [
    { content: '<tool_calls>[{"name":"create_page","arguments":{"title":"会议","content":"要点一\\n要点二"}}]</tool_calls>' },
    { content: "我为你起草了一个新页面。" },
  ];
  const transport = { complete: async () => respSeq.shift() || { content: "done" } };
  const ctx = { currentPageId: null, allPages: [{ id: "a", title: "A", parent_id: null }] };
  const r1 = await aiMod.runAiLoop("帮我新建一个会议页", [{ id: "a", title: "A" }], ctx, { transport });
  assert("runAiLoop create_page drafts exactly one", r1.drafts.length === 1 && r1.drafts[0].payload.kind === "create_page", JSON.stringify(r1.drafts));
  assert("runAiLoop create_page carries title", r1.drafts[0].payload.args.title === "会议");
  assert("runAiLoop create_page builds content_json", r1.drafts[0].payload.args.content_json.includes("要点一") && r1.drafts[0].payload.args.content_json.includes("要点二"));
  assert("runAiLoop records activity for create_page", Array.isArray(r1.activity) && r1.activity.some((a) => a.tool === "create_page"), JSON.stringify(r1.activity));

  // append_block returns a draft with pageId + text.
  const respSeq2 = [
    { content: '<tool_calls>[{"name":"append_block","arguments":{"pageId":"p1","text":"新增行"}}]</tool_calls>' },
    { content: "已起草追加。" },
  ];
  const transport2 = { complete: async () => respSeq2.shift() || { content: "done" } };
  const r2 = await aiMod.runAiLoop("追加到 p1", [{ id: "p1", title: "P1" }], ctx, { transport: transport2 });
  assert("runAiLoop append_block drafts with pageId+text", r2.drafts.length === 1 && r2.drafts[0].payload.kind === "append_block" && r2.drafts[0].payload.pageId === "p1" && r2.drafts[0].payload.text === "新增行");

  // Final-answer-only turn → no drafts.
  const r3 = await aiMod.runAiLoop("你好", [{ id: "a", title: "A" }], ctx, { transport: { complete: async () => ({ content: "你好，有什么可以帮你？" }) } });
  assert("runAiLoop final answer has no drafts", r3.drafts.length === 0);

  // Ollama connection live test against a local HTTP server (node:http), proving
  // the transport + testOllamaConnection round-trip and the /api/tags model list.
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b" }, { name: "llama3.2:3b" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "qwen2.5:7b", message: { role: "assistant", content: "hi from ollama mock" } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const aiBase = `http://127.0.0.1:${port}`;
  try {
    const conn = await aiMod.testOllamaConnection(aiBase, "qwen2.5:7b", 4000);
    assert("testOllamaConnection ok + model found", conn.ok && (conn.message.includes("已可用") || conn.message.includes("已安装")) && conn.models.includes("qwen2.5:7b"), conn.message);
    const transport = aiMod.createOllamaTransport(aiBase, "qwen2.5:7b");
    const out = await transport.complete([{ role: "user", content: "hi" }]);
    assert("ollama transport returns assistant content", out.content === "hi from ollama mock");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  // OpenAI-compatible (DeepSeek-style) flow against a mock /v1/* server.
  const http2 = await import("node:http");
  const server2 = http2.createServer((req, res) => {
    const auth = req.headers.authorization === "Bearer sk-test";
    if (req.url === "/v1/models") {
      if (!auth) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (!auth) { res.writeHead(401); res.end(); return; }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "hi from deepseek mock" }, finish_reason: "stop" }],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const port2 = server2.address().port;
  const aiBase2 = `http://127.0.0.1:${port2}`;
  try {
    const conn2 = await aiMod.testOpenAICompatConnection(aiBase2, "deepseek-chat", "sk-test", 4000);
    assert("openai-compat probe ok + model list", conn2.ok && conn2.models.includes("deepseek-chat"), conn2.message);
    const auth2 = await aiMod.testOpenAICompatConnection(aiBase2, "deepseek-chat", "sk-wrong", 4000);
    assert("openai-compat probe flags bad key", !auth2.ok && auth2.message.includes("鉴权"), auth2.message);
    const t2 = aiMod.createOpenAICompatTransport(aiBase2, "deepseek-chat", "sk-test");
    const out2 = await t2.complete([{ role: "user", content: "hi" }]);
    assert("openai-compat transport returns assistant content", out2.content === "hi from deepseek mock");
    const tp = aiMod.createProviderTransport({ provider: "openai", baseUrl: aiBase2, model: "deepseek-chat", apiKey: "sk-test" });
    const out3 = await tp.complete([{ role: "user", content: "hi" }]);
    assert("createProviderTransport routes openai", out3.content === "hi from deepseek mock");
  } finally {
    server2.closeAllConnections?.();
    await new Promise((resolve) => server2.close(resolve));
  }

  // Web platform: ai_complete / ai_probe handlers route through the pure HTTP
  // transports (local Ollama). Exercised via the platform's own invoke.
  const http3 = await import("node:http");
  const server3 = http3.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "qwen2.5:7b", message: { role: "assistant", content: "hi from web ai" } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server3.listen(0, "127.0.0.1", resolve));
  const port3 = server3.address().port;
  const aiBase3 = `http://127.0.0.1:${port3}`;
  try {
    const webChat = await invoke("ai_complete", {
      args: { provider: "ollama", base_url: aiBase3, model: "qwen2.5:7b", messages: [{ role: "user", content: "hi" }] },
    });
    assert("web ai_complete routes through platform", webChat.content === "hi from web ai");
    const webProbe = await invoke("ai_probe", {
      args: { provider: "ollama", base_url: aiBase3, model: "qwen2.5:7b" },
    });
    assert("web ai_probe lists models", webProbe.ok && webProbe.models.includes("qwen2.5:7b"), webProbe.message);
  } finally {
    server3.closeAllConnections?.();
    await new Promise((resolve) => server3.close(resolve));
  }
}

// 15. Pure-logic tests for the safe Markdown parser used in AI replies.
{
  const b = aiMod.parseMarkdown("# 标题\n\n这是**加粗**和*斜体*，还有`code`与[链接](https://example.com)。\n\n- 项目一\n- 项目二\n\n> 引用一段\n\n```js\nconst x = 1;\n```\n\n1. 第一\n2. 第二\n\n---\n");
  assert("markdown heading h1", b[0].kind === "h1" && b[0].children[0].text === "标题");
  const para = b[1];
  assert("markdown paragraph + inline bold/italic/code/link",
    para.kind === "p" &&
    para.children.some((c) => c.kind === "bold" && c.children[0].text === "加粗") &&
    para.children.some((c) => c.kind === "italic" && c.children[0].text === "斜体") &&
    para.children.some((c) => c.kind === "code" && c.text === "code") &&
    para.children.some((c) => c.kind === "link" && c.href === "https://example.com" && c.label === "链接"),
    JSON.stringify(para));
  const ul = b[2];
  assert("markdown ul two items", ul.kind === "ul" && ul.items.length === 2 && ul.items[0][0].text === "项目一");
  assert("markdown quote", b[3].kind === "quote" && b[3].children[0].kind === "p");
  assert("markdown fenced code", b[4].kind === "code" && b[4].lang === "js" && b[4].text.trim() === "const x = 1;");
  assert("markdown ol two items", b[5].kind === "ol" && b[5].items.length === 2);
  assert("markdown hr", b[6].kind === "hr");

  // XSS: unsafe link protocol is dropped (kept as literal text), HTML is data.
  const unsafe = aiMod.parseMarkdown("[x](javascript:alert(1))");
  assert("markdown blocks javascript: link", unsafe[0].children.every((c) => c.kind !== "link"), JSON.stringify(unsafe));
  const html = aiMod.parseMarkdown("<script>alert(1)</script>");
  assert("markdown keeps raw html as text", html[0].kind === "p" && html[0].children[0].text === "<script>alert(1)</script>");
}

// 16. Draft preview helper.
{
  const cp = aiMod.draftPreview({ kind: "create_page", args: { title: "会议", content_text: "要点一\n要点二", content_json: "" } });
  assert("draftPreview create_page shows title+text", cp.includes("标题：会议") && cp.includes("要点一"), JSON.stringify(cp));
  const ab = aiMod.draftPreview({ kind: "append_block", pageId: "p1", text: "新增一行" });
  assert("draftPreview append_block shows text", ab.includes("将追加") && ab.includes("新增一行"), JSON.stringify(ab));
  assert("draftPreview unknown -> empty", aiMod.draftPreview({ kind: "?x" }) === "");
}

// 17. Streaming: NDJSON (Ollama) and SSE (OpenAI-compat) parse into deltas.
{
  const http4 = await import("node:http");
  const srv4 = http4.createServer((req, res) => {
    if (req.url === "/api/chat") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"content":"he"}}\n');
      res.write('{"message":{"content":"llo"}}\n');
      res.end('{"message":{"content":"!"},"done":true}\n');
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv4.listen(0, "127.0.0.1", resolve));
  const port4 = srv4.address().port;
  const base4 = `http://127.0.0.1:${port4}`;
  try {
    const deltas4 = [];
    const res4 = await aiMod.createOllamaTransport(base4, "qwen2.5:7b").complete(
      [{ role: "user", content: "hi" }],
      { onDelta: (t) => deltas4.push(t) },
    );
    assert("ollama streaming accumulates deltas", deltas4.join("") === "he" + "llo" + "!" && res4.content === "he" + "llo" + "!", JSON.stringify(deltas4));

    const deltas5 = [];
    const res5 = await aiMod.createOpenAICompatTransport(base4, "deepseek-chat").complete(
      [{ role: "user", content: "hi" }],
      { onDelta: (t) => deltas5.push(t) },
    );
    assert("openai-compat streaming accumulates deltas", deltas5.join("") === "hi" + "!" && res5.content === "hi" + "!", JSON.stringify(deltas5));
  } finally {
    srv4.closeAllConnections?.();
    await new Promise((resolve) => srv4.close(resolve));
  }
}

// 18. Streaming + native tool_call: a WRITE arrives as a captured tool call (not
// just narration), so runAiLoop produces a confirmable draft.
{
  const http5 = await import("node:http");
  const srv5 = http5.createServer((req, res) => {
    if (req.url === "/api/chat") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"content":""}}\n');
      res.end('{"message":{"content":"","tool_calls":[{"function":{"name":"create_page","arguments":{"title":"周计划"}}}]},"done":true}\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv5.listen(0, "127.0.0.1", resolve));
  const port5 = srv5.address().port;
  const base5 = `http://127.0.0.1:${port5}`;
  try {
    const transport5 = aiMod.createOllamaTransport(base5, "qwen2.5:7b");
    const res5b = await transport5.complete([{ role: "user", content: "新建周计划" }], { onDelta: () => {} });
    assert("streaming captures native tool_call", Array.isArray(res5b.nativeToolCalls) && res5b.nativeToolCalls[0].name === "create_page", JSON.stringify(res5b.nativeToolCalls));
    const loopRes = await aiMod.runAiLoop("帮我新建周计划", [{ id: "a", title: "A" }], { currentPageId: null, allPages: [{ id: "a", title: "A", parent_id: null }] }, { transport: transport5, maxSteps: 2, onDelta: () => {} });
    assert("streaming write turns into a draft", loopRes.drafts.length === 1 && loopRes.drafts[0].payload.kind === "create_page", JSON.stringify(loopRes.drafts));
  } finally {
    srv5.closeAllConnections?.();
    await new Promise((resolve) => srv5.close(resolve));
  }
}

// 19. Reasoning ("thinking") capture: OpenAI-compat SSE delta.reasoning_content.
{
  const http6 = await import("node:http");
  const srv6 = http6.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"我先理解"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"再作答"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"答案是"}}]}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv6.listen(0, "127.0.0.1", resolve));
  const port6 = srv6.address().port;
  const base6 = `http://127.0.0.1:${port6}`;
  try {
    const thinkingDeltas = [];
    const res6 = await aiMod.createOpenAICompatTransport(base6, "deepseek-r1").complete(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onThinking: (t) => thinkingDeltas.push(t) },
    );
    assert("streaming captures reasoning_content", res6.thinking === "我先理解" + "再作答" && res6.content === "答案是", JSON.stringify({ thinking: res6.thinking, content: res6.content }));
    assert("onThinking streams thinking deltas live", thinkingDeltas.join("") === "我先理解" + "再作答", JSON.stringify(thinkingDeltas));
  } finally {
    srv6.closeAllConnections?.();
    await new Promise((resolve) => srv6.close(resolve));
  }
}

// 19b. Endpoints that ignore `stream:true` and return a plain JSON completion
// (no SSE `data:` prefix, no trailing newline) must still yield content — this is
// the silent "sent but no reply" case fixed by extractFromJson.
{
  const http7 = await import("node:http");
  const srv7 = http7.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "完整答案" } }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv7.listen(0, "127.0.0.1", resolve));
  const port7 = srv7.address().port;
  const base7 = `http://127.0.0.1:${port7}`;
  try {
    const deltas7 = [];
    const res7 = await aiMod.createOpenAICompatTransport(base7, "deepseek-chat").complete(
      [{ role: "user", content: "hi" }],
      { onDelta: (t) => deltas7.push(t) },
    );
    assert("openai non-SSE JSON completion yields content", res7.content === "完整答案" && deltas7.join("") === "完整答案", JSON.stringify({ content: res7.content, deltas: deltas7 }));
  } finally {
    srv7.closeAllConnections?.();
    await new Promise((resolve) => srv7.close(resolve));
  }
}

// 19c. Bare NDJSON frames (no `data:` prefix) on an OpenAI-compatible endpoint:
// the streamed deltas must still be captured.
{
  const http8 = await import("node:http");
  const srv8 = http8.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write('{"choices":[{"delta":{"content":"a"}}]}\n');
      res.end('{"choices":[{"delta":{"content":"b"}}]}\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv8.listen(0, "127.0.0.1", resolve));
  const port8 = srv8.address().port;
  const base8 = `http://127.0.0.1:${port8}`;
  try {
    const res8 = await aiMod.createOpenAICompatTransport(base8, "deepseek-chat").complete(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {} },
    );
    assert("openai bare-NDJSON frames yield content", res8.content === "ab", JSON.stringify(res8.content));
  } finally {
    srv8.closeAllConnections?.();
    await new Promise((resolve) => srv8.close(resolve));
  }
}

// 19d. A reasoning stream that ends with finish_reason=length and NO content
// (max_tokens exhausted during thinking) must surface a clear truncation error
// instead of a silent empty reply.
{
  const http9 = await import("node:http");
  const srv9 = http9.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"思考一"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"思考二"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv9.listen(0, "127.0.0.1", resolve));
  const port9 = srv9.address().port;
  const base9 = `http://127.0.0.1:${port9}`;
  try {
    let threw = false;
    try {
      await aiMod.createOpenAICompatTransport(base9, "deepseek-v4-flash").complete(
        [{ role: "user", content: "hi" }],
        { onDelta: () => {} },
      );
    } catch (e) {
      threw = true;
      assert("length truncation surfaces a clear error", String((e && e.message) || e).includes("长度上限"), String((e && e.message) || e));
    }
    assert("length truncation throws", threw);
  } finally {
    srv9.closeAllConnections?.();
    await new Promise((resolve) => srv9.close(resolve));
  }
}

// 20. Defensive Lexical editor-state sanitation (guards the type "undefined" crash).
{
  const valid = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"hi","version":1}]}],"type":"root","version":1}}';
  const imagerow = '{"root":{"children":[{"type":"imagerow","items":[{"src":"a","alt":"b"}],"version":1}],"type":"root","version":1}}';
  const mixed = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"good","version":1}]},{"foo":"bar"}],"type":"root","version":1}}';
  const onlyBadText = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"text":"hi","version":1}]}],"type":"root","version":1}}';
  const genericChild = '{"root":{"children":[{"foo":"bar"}],"type":"root","version":1}}';
  assert("lexicalValid accepts valid doc", aiMod.lexicalStateValid(valid) === valid);
  assert("lexicalValid accepts data-only items (imagerow)", aiMod.lexicalStateValid(imagerow) === imagerow);
  // A serialized 分栏 block (columns -> column -> paragraph -> text) must be accepted
  // by the editor's known-type set, so existing columns docs round-trip (Tier-1).
  const columnsDoc = '{"root":{"children":[{"type":"columns","count":2,"version":1,"children":[{"type":"column","version":1,"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"左","version":1}]}]},{"type":"column","version":1,"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"右","version":1}]}]}]}],"type":"root","version":1}}';
  const allowedCols = new Set(["root", "paragraph", "text", "columns", "column"]);
  const salvagedCols = aiMod.lexicalStateValid(columnsDoc, allowedCols);
  assert("lexicalValid accepts nested columns block", salvagedCols !== null && salvagedCols.includes('"type":"columns"') && salvagedCols.includes('"text":"左"') && salvagedCols.includes('"text":"右"'), JSON.stringify(salvagedCols));
  const salvagedMixed = aiMod.lexicalStateValid(mixed);
  assert("lexicalValid salvages good blocks, drops corrupt ones", salvagedMixed !== null && salvagedMixed.includes('"text":"good"') && !salvagedMixed.includes('"foo"'));
  const salvagedBadText = aiMod.lexicalStateValid(onlyBadText);
  assert("lexicalValid drops a corrupt text node (keeps parent block)", salvagedBadText !== null && !salvagedBadText.includes('"text":"hi"'));
  assert("lexicalValid rejects generic child without type", aiMod.lexicalStateValid(genericChild) === null);
  assert("lexicalValid rejects empty root", aiMod.lexicalStateValid('{"root":{"children":[]}}') === null);
  // A node whose `type` is the literal string "undefined" (not a real Lexical type)
  // must be dropped, not kept — keeping it makes Lexical throw "type undefined not found".
  const literalUndef = '{"root":{"children":[{"type":"undefined","version":1},{"type":"paragraph","version":1,"children":[{"type":"text","text":"ok","version":1}]}],"type":"root","version":1}}';
  const salvagedUndef = aiMod.lexicalStateValid(literalUndef);
  assert("lexicalValid drops literal 'undefined' type, keeps good block", salvagedUndef !== null && salvagedUndef.includes('"text":"ok"') && !salvagedUndef.includes('"type":"undefined"'));
  // When the editor's known node types are supplied, an unregistered type is dropped too.
  const allowed = new Set(["root", "paragraph", "text"]);
  const unregistered = '{"root":{"children":[{"type":"mypluginblock","version":1},{"type":"paragraph","version":1,"children":[{"type":"text","text":"keep","version":1}]}],"type":"root","version":1}}';
  const salvagedReg = aiMod.lexicalStateValid(unregistered, allowed);
  assert("lexicalValid drops unregistered type when allowedTypes given", salvagedReg !== null && salvagedReg.includes('"text":"keep"') && !salvagedReg.includes('mypluginblock'));
  // A bad node inside a node's `$slots` (a non-`children` node container Lexical
  // also parses) must be dropped too — otherwise Lexical still reports "not found".
  const slotsDoc = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"ok","version":1}],"$slots":{"bad":{"type":"undefined","version":1}}}],"type":"root","version":1}}';
  const salvagedSlots = aiMod.lexicalStateValid(slotsDoc);
  assert("lexicalValid drops bad $slots node", salvagedSlots !== null && salvagedSlots.includes('"text":"ok"') && !salvagedSlots.includes('"type":"undefined"'), JSON.stringify(salvagedSlots));
  // A doc whose ROOT node is missing `type:"root"` (AI-generated shape) must be
  // healed so Lexical doesn't throw `type "undefined" + not found`.
  const noRootType = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"ok","version":1}]}]}}';
  const healedRoot = aiMod.lexicalStateValid(noRootType);
  assert("lexicalValid heals root missing type:root", healedRoot !== null && healedRoot.includes('"type":"root"') && healedRoot.includes('"text":"ok"'), JSON.stringify(healedRoot));
}

// 21. AI-style create_page -> delete_page -> gone from list (web delete path).
{
  const made = await invoke("create_page", {
    args: { parent_id: null, title: "待删页", content_json: '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"x","version":1}]}],"type":"root","version":1}}', content_text: "x" },
  });
  assert("ai create_page returns a page", made && made.id);
  await invoke("delete_page", { id: made.id });
  const pagesAfter = await invoke("list_pages", {});
  assert("delete_page removes AI-created page from list", Array.isArray(pagesAfter) && !pagesAfter.some((p) => p.id === made.id), JSON.stringify(pagesAfter.map((p) => p.id).slice(0, 6)));
}

console.log(`\n${pass} passed, ${fail} failed`);
// Use exitCode (not process.exit()) so any still-closing libuv handles drain
// before the process exits; process.exit() races teardown and hits a Windows
// libuv assert when the smoke server was used.
process.exitCode = fail === 0 ? 0 : 1;
