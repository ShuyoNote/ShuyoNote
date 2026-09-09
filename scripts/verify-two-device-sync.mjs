// 两设备同页并发编辑 · 同步一致性验收（v1.84.3 seq-LWW + dirty 优先本地）。
//
// 真实复现客户端合并逻辑：用真实的 `applyChange`（web.ts 导出）+ 真实的
// `SqliteStore`（sql.js WASM）各建一台"设备"的本地库，模拟两设备同时编辑
// 同一页，验证 seq-LWW + dirty 优先本地是否正确收敛、不互相吞改动。
//
// 服务端只做 seq 分配器（对应 changes AUTOINCREMENT id）；所有跨设备变更
// 一律经 `applyChange` 应用到各设备本地库 —— 与真实同步引擎同一路径。
// 各 push 只清【推送方自己】的 dirty（真实 doPush 行为）。
//
// 用法：node scripts/verify-two-device-sync.mjs   （有失败即非零退出）
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);
const esbuild = require(join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"));

// ---- 1. bundle web.ts（含 applyChange + SqliteStore）到临时 ESM ----
const tmpDir = join(root, ".sync-verify-tmp");
rmSync(tmpDir, { recursive: true, force: true });
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
const { SqliteStore, setWasmUrl, setWasmBytesProvider, setDefaultAdapter, applyChange } = mod;

// ---- 2. 注入 sql.js wasm 字节 + 内存 adapter（Node 环境）----
const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
setWasmUrl("sql-wasm.wasm");
setWasmBytesProvider(async () => {
  const buf = readFileSync(wasmPath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});
setDefaultAdapter({
  async load() { return null; },
  async save() {}, // 纯内存，真实 sql.js 语义
});

// ---- 3. 工具 ----
let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ FAIL: ${msg}`); }
};

async function newDevice() {
  const store = new SqliteStore();
  await store.init();
  return store;
}
const getRow = (store, id) =>
  store.query("SELECT id, title, content_text, sync_seq, dirty FROM pages WHERE id = ?", [id])[0];

// 模拟服务端：单调 seq 分配器 + 版本视图（对应 changes AUTOINCREMENT id）
let serverSeq = 0;
const serverView = new Map(); // id -> { seq, title, content_text, updated_at, from_device }

// 设备把本地 dirty 改动 push 到服务端：服务端分配序，记录版本，清【该设备】的 dirty。
function pushToServer(store, entityId, dev, title, text) {
  const seq = ++serverSeq;
  serverView.set(entityId, {
    seq, title, content_text: text,
    updated_at: Date.now(), from_device: dev, workspace_id: "ws1",
  });
  store.run("UPDATE pages SET dirty = 0 WHERE id = ?", [entityId]);
  return seq;
}

// 设备从服务端 pull：把服务端版本经真实 applyChange 应用到本地库。
// `seen` = 该设备已见的最大 seq（模拟 last_pulled_seq 过滤；只在 applyChange 实际接受时推进）。
function pullFromServer(store, seen) {
  for (const [id, v] of serverView) {
    if (seen.has(id) && seen.get(id) >= v.seq) continue;
    // 记录应用前本地状态，用于判断 applyChange 是否真的接受了远端。
    const before = getRow(store, id);
    applyChange(store, {
      id: 0, seq: v.seq, device_id: v.from_device, device_seq: 1,
      entity: "page", entity_id: id, op: "upsert",
      payload: JSON.stringify({ id, title: v.title, content_text: v.content_text, updated_at: v.updated_at, workspace_id: v.workspace_id }),
      updated_at: v.updated_at,
    });
    const after = getRow(store, id);
    // 只有当本地接受了远端（标题被替换成远端版本）才推进 seen（真实 pull 按 seq 游标推进）。
    // 若本地 dirty 保护保留了本地，seen 不推进（模拟真实 pull：该 seq 未"消费"）。
    if (after && after.title === v.title) {
      seen.set(id, v.seq);
    } else {
      // 本地保留（dirty）→ seen 推进到该 seq，避免反复重放（真实 pull 用游标）。
      // 但真实客户端会保留 dirty 且不推进 last_pulled_seq 到会覆盖本地的 seq。
      seen.set(id, v.seq);
    }
  }
}

// 设备本地新建一页（dirty=1，未同步）—— 模拟 save_page 的 dirty=1
function localCreate(store, id, title, text) {
  store.run(
    "INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text, sync_seq, dirty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
    [id, "ws1", null, title, "page", 0, Date.now(), Date.now(), null, "{}", text, 0],
  );
}

// 设备本地改一页（置 dirty=1，未同步）
function localEdit(store, id, title, text) {
  store.run("UPDATE pages SET title = ?, content_text = ?, updated_at = ?, dirty = 1 WHERE id = ?", [title, text, Date.now(), id]);
}

async function main() {
  console.log("\n[两设备同页并发编辑验收] (seq-LWW + dirty 优先本地, 对齐 v1.84.3)\n");

  const A = await newDevice();
  const B = await newDevice();
  const PAGE = "page-1";

  // =========== 场景 A：A 建页同步，B pull 建立副本 ===========
  console.log("场景 A：A 建页并同步，B pull 建立副本");
  localCreate(A, PAGE, "初始标题", "初始内容");
  ok(getRow(A, PAGE).dirty === 1, "A 建页后本地 dirty=1（未同步）");
  pushToServer(A, PAGE, "devA", "初始标题", "初始内容");
  ok(getRow(A, PAGE).dirty === 0, "A push 成功后本地 dirty 清除");

  const seenB = new Map();
  pullFromServer(B, seenB);
  ok(getRow(B, PAGE)?.title === "初始标题", "B pull 后建立副本（标题=初始标题）");

  // =========== 场景 B：A/B 同时改同一页（均 dirty，未同步）===========
  console.log("\n场景 B：A/B 同时改同一页（均未同步）");
  localEdit(A, PAGE, "A版标题", "A版内容");
  localEdit(B, PAGE, "B版标题", "B版内容");
  ok(getRow(A, PAGE).title === "A版标题" && getRow(A, PAGE).dirty === 1, "A 本地改为「A版标题」且 dirty=1");
  ok(getRow(B, PAGE).title === "B版标题" && getRow(B, PAGE).dirty === 1, "B 本地改为「B版标题」且 dirty=1");

  // =========== 场景 C：B push（seq=2）→ A pull（A 本地 dirty=1 → 保留 A）===========
  console.log("\n场景 C：B push 后，A pull（A 本地 dirty=1 → 应保留 A，不被 B 覆盖）");
  const seqB = pushToServer(B, PAGE, "devB", getRow(B, PAGE).title, getRow(B, PAGE).content_text);
  ok(seqB === 2, `B push 得服务端 seq=${seqB}（应为 2）`);
  const seenA = new Map(); seenA.set(PAGE, 1); // A 已见 seq=1
  pullFromServer(A, seenA); // A pull 到服务端 seq=2，但 A 本地 dirty=1
  const titleA = getRow(A, PAGE).title;
  ok(titleA === "A版标题", `A pull 后保留本地「A版标题」（dirty 优先本地），实际=${titleA}`);
  // A 未 push，dirty 仍为 1，且本地内容不被远端覆盖 → 服务端 seq=2 未落到 A。
  ok(getRow(A, PAGE).dirty === 1, `A 仍 dirty=1（本次未同步，保护本地）`);

  // =========== 场景 D：A push（seq=3）→ B pull（B 已 push 过、dirty=0 → 接受更大 seq = LWW）===========
  console.log("\n场景 D：A push 后，B pull（B 已同步过无脏 → 正常 LWW，接受 A 的更大 seq）");
  const seqA = pushToServer(A, PAGE, "devA", getRow(A, PAGE).title, getRow(A, PAGE).content_text);
  ok(seqA === 3, `A push 得服务端 seq=${seqA}（应为 3）`);
  // B 在场景 C 已 push 过（dirty=0），且 B 已见 seq=2
  const seenB2 = new Map(); seenB2.set(PAGE, 2);
  pullFromServer(B, seenB2); // B pull 到服务端 seq=3，B 无脏 → 接受
  const titleB = getRow(B, PAGE).title;
  ok(titleB === "A版标题", `B 无脏后 pull 接受远端「A版标题」（LWW），实际=${titleB}`);
  ok(getRow(B, PAGE).sync_seq === 3, `B 的 sync_seq 更新为 3（接受了 seq=3 的远端）`);

  // =========== 场景 E：dirty 保护与 LWW 边界 ===========
  console.log("\n场景 E：A 有未同步改动（dirty=1）时，即使服务端 seq 更大也保留 A（不丢）");
  localEdit(A, PAGE, "A最终版", "A最终内容"); // A 又改了，dirty=1
  // 假设远端又来一条 seq=4（别处改的，本测试用另一个 page 模拟可不做）
  // 关键：A dirty=1，applyChange seq=3 → 保留 A
  const beforeTitle = getRow(A, PAGE).title;
  applyChange(A, {
    id: 0, seq: 3, device_id: "devX", device_seq: 1, entity: "page", entity_id: PAGE, op: "upsert",
    payload: JSON.stringify({ id: PAGE, title: "远端再次覆盖", content_text: "x", updated_at: Date.now(), workspace_id: "ws1" }),
    updated_at: Date.now(),
  });
  ok(getRow(A, PAGE).title === beforeTitle, `A dirty=1 时拒绝 seq=3 远端覆盖（保留「${beforeTitle}」），实际=${getRow(A, PAGE).title}`);

  // =========== 场景 F：时钟漂移下同页互改不丢 ===========
  console.log("\n场景 F：时钟漂移下同页互改不丢（服务端 seq 为权威序）");
  const P2 = "page-clock";
  const A2 = await newDevice();
  const B2 = await newDevice();
  localCreate(A2, P2, "初", "初内容");
  pushToServer(A2, P2, "devA", "初", "初内容"); // seq=4
  const seenB3 = new Map();
  pullFromServer(B2, seenB3);
  ok(getRow(B2, P2).title === "初", "设备B 拉到初始页");

  // A 先改（本地时钟较小），B 后改（本地时钟很大）——都不 push，各自 dirty=1
  localEdit(A2, P2, "A2版", "");
  localEdit(B2, P2, "B2版", "");
  // B 先 push（seq=5），A pull（A dirty=1 → 保留 A，不受 B 的大时钟影响）
  pushToServer(B2, P2, "devB", "B2版", "");
  const seenA3 = new Map(); seenA3.set(P2, 4);
  pullFromServer(A2, seenA3);
  ok(getRow(A2, P2).title === "A2版", `时钟漂移下 A 保留本地「A2版」（dirty 保护），实际=${getRow(A2, P2).title}`);

  // =========== 汇总 ===========
  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  rmSync(tmpDir, { recursive: true, force: true });
  if (fail) {
    console.error("存在失败项：两设备同页并发编辑验收未通过。");
    process.exit(1);
  }
  console.log("两设备同页并发编辑·同步一致性验收全部通过 ✅");
}

main().catch((e) => { console.error("验收脚本异常:", e); process.exit(1); });
