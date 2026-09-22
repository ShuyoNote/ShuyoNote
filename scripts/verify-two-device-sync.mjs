// 两设备同页并发编辑 · 同步一致性验收（v1.84.3 seq-LWW + dirty 优先本地）。
//
// 场景 A–G：页级 seq-LWW ＋ dirty 优先本地（v1.84.3 的行为，承重判据是"恢复版本后推送前收到远端"）。
// 场景 H（2026-09-22，阶段 1）：**块级合并已接进 `applyChange`** —— 两端改**不同块** ⇒ 都保留；
//   含"冲突 ⇒ 回落今天的页级 LWW"（裁定 (iii)：不静默选边，提示 UI 还没做）
//   与两条纯函数反判据（缺 `blockRev` 且内容变了 ⇒ 必须提示；内容逐字节相同 ⇒ 不许提示）。
// 场景 I / J：真 `save_page` / 真 `restore_version` 会给块盖 rev（不盖章 ⇒ 块级判定每页都回落）。
// 场景 K（2026-09-22，回信那一轮）：**内容逐字相同、rev 不同 ⇒ 收敛到 max**（macOS 抓到的真 bug）——
//   留下更旧的那个 rev ⇒ 本地下一次编辑静默输给远端**更旧**的编辑；场景 K 把那条 trace 走成"看得见的冲突"。
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
import { esbuild } from "./lib/load-esbuild.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

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
const { SqliteStore, setWasmUrl, setWasmBytesProvider, setDefaultAdapter, applyChange, makeInvoke } = mod;

// ---- 1b. bundle docContent.ts（阶段 1 的块级合并纯函数；零依赖，很轻）----
const dcOut = join(tmpDir, "docContent.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/docContent.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: dcOut,
});
const dc = await import(pathToFileURL(dcOut).href + "?v=" + Date.now());
const { mergeBlocks, mergePageBlocks, localState, readContent, writeContent, pageConflictsOf, resolvePageConflict } = dc;

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
// `contentJson`（可选）= 整页 JSON —— 真实负载就带它（阶段 1 的合并要靠它）。
function pushToServer(store, entityId, dev, title, text, contentJson) {
  const seq = ++serverSeq;
  serverView.set(entityId, {
    seq, title, content_text: text,
    ...(typeof contentJson === "string" ? { content_json: contentJson } : {}),
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
      payload: JSON.stringify({
        id, title: v.title, content_text: v.content_text,
        ...(typeof v.content_json === "string" ? { content_json: v.content_json } : {}),
        updated_at: v.updated_at, workspace_id: v.workspace_id,
      }),
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

// ---- 阶段 1（场景 H）用的夹具助手 --------------------------------------------------
// 从 `content_json` 的顶层 children 提取块表（`blockId` / `blockRev`）。
// ⚠️ 这是**脚本自带的夹具助手**，不是生产代码：生产侧那份"双形态读写"（编辑器序列化时写
// `blockRev`）属阶段 1 的**下一片**，依赖 `feat/block-id-model` 的自有块节点。
// ⚠️ **块片段里去掉 `blockRev`**（rev 单独放 `rev`）：判定表第一行比的是"内容逐字节相同"，
// 而老客户端"打开—原样保存"正好会剥掉 `blockRev` —— 把 rev 留在片段里，那一行就永远不成立
// （每次同步都提示 = 噪声）。这正是本场景最后那条反判据在守的东西。
const blk = (blockId, rev, body) => ({ blockId, rev, json: JSON.stringify({ type: "paragraph", blockId, body }) });
const blocksOf = (contentJson) => {
  const children = JSON.parse(contentJson)?.root?.children ?? [];
  return children.map((c, i) => {
    const { blockRev, ...content } = c ?? {};
    return {
      blockId: typeof content?.blockId === "string" ? content.blockId : `no-id-${i}`,
      rev: typeof blockRev === "number" ? blockRev : null,
      json: JSON.stringify(content),
    };
  });
};
/** 物化回一份 `content_json`（写入时把 `blockRev` 放回块对象里 —— 双形态的"落盘形态"）。 */
const contentOf = (blocks) =>
  JSON.stringify({
    root: {
      children: blocks.map((b) => {
        const c = JSON.parse(b.json);
        return typeof b.rev === "number" ? { ...c, blockRev: b.rev } : c;
      }),
    },
  });
/** 取某一块的正文（断言用）。 */
const bodyOf = (contentJson, blockId) => {
  const c = (JSON.parse(contentJson)?.root?.children ?? []).find((x) => x?.blockId === blockId);
  return c ? c.body : null;
};

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

  // =========== 场景 G：恢复历史版本后的本地改动必须被 dirty 保护（2026-09-19 裁定 (a)）===========
  // 承重判据：`restore_version` 必须置 `dirty = 1`。不置 1 时，"恢复后、推送前"收到远端会把这次
  // 恢复**静默冲掉**（最终靠 outbox 收敛，但用户会看到内容闪回、且没有任何提示）。
  // 这条判据打的是**真实的命令路径**（`makeInvoke` → `restore_version`），不是在脚本里重演 restore 逻辑。
  console.log("\n场景 G：恢复历史版本 → 推送前收到远端 ⇒ 恢复的内容不被冲掉");
  const G = await newDevice();
  const invokeG = makeInvoke(G);
  const PR = "page-restore";
  localCreate(G, PR, "当前内容(v3)", "当前内容(v3)");
  const seqG = pushToServer(G, PR, "devG", "当前内容(v3)", "当前内容(v3)"); // 已同步、dirty=0
  ok(getRow(G, PR).dirty === 0, "G 建页并 push 后 dirty=0（可被远端覆盖的基线状态）");
  // 造一条历史版本（真实路径下由 snapshotBeforeSave 产生；这里插一行等价的历史行）
  G.run(
    "INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at) VALUES (?,?,?,?,?,?)",
    ["ver-1", PR, "旧标题(v1)", "{}", "旧内容(v1)", Date.now()],
  );
  await invokeG("restore_version", { versionId: "ver-1" });
  ok(getRow(G, PR).content_text === "旧内容(v1)", "恢复后本地内容 = 旧内容(v1)");
  ok(getRow(G, PR).dirty === 1, "★ 恢复后 dirty=1（恢复 = 一次本地未推送改动）");
  const vcount = G.query("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?", [PR])[0].n;
  ok(vcount === 2, `恢复前的内容已进快照（历史行数应为 2：历史行 + 恢复前快照），实际=${vcount}`);
  // 推送**之前**，远端来了一条更新的版本（另一台设备改的）
  const seqRemote = ++serverSeq;
  serverView.set(PR, {
    seq: seqRemote, title: "远端新标题", content_text: "远端新内容",
    updated_at: Date.now(), from_device: "devX", workspace_id: "ws1",
  });
  pullFromServer(G, new Map([[PR, seqG]]));
  ok(getRow(G, PR).content_text === "旧内容(v1)", "★ 推送前收到远端 ⇒ 恢复的内容不被冲掉（dirty 保护）");
  ok(getRow(G, PR).dirty === 1, "且仍 dirty=1（本次 pull 未消费该远端）");
  // 反向：push 之后（dirty=0）同一条远端必须能正常覆盖 —— dirty 是"保护未推送的改动"，不是"永久锁住"
  pushToServer(G, PR, "devG", getRow(G, PR).title, getRow(G, PR).content_text);
  serverView.set(PR, {
    seq: ++serverSeq, title: "远端更新", content_text: "远端更新内容",
    updated_at: Date.now(), from_device: "devX", workspace_id: "ws1",
  });
  pullFromServer(G, new Map([[PR, seqRemote]]));
  ok(getRow(G, PR).content_text === "远端更新内容", "push 后 dirty=0 ⇒ 后续远端正常覆盖（保护不是永久锁死）");

  // =========== 场景 H：阶段 1 块级合并 **已接线** —— 两端改**不同块** ⇒ 都保留 ===========
  // 走**真路径**：真 `SqliteStore` ＋ 真 `applyChange`（远端载荷里带整页 `content_json`）。
  console.log("\n场景 H：块级合并（阶段 1，已接进 applyChange）—— 两端改不同块 ⇒ 都保留");
  const PH = "page-blocks";
  const HA = await newDevice();
  const HB = await newDevice();
  const baseBlocks = [blk("b1", 1, "b1 原始"), blk("b2", 1, "b2 原始")];
  const withRev = (blocks, id, rev, body) => blocks.map((b) => (b.blockId === id ? blk(id, rev, body) : b));

  // 两台设备都处于"已同步到 seq=1"的基线（dirty=0），与服务端那一版逐字相同
  for (const s of [HA, HB]) {
    localCreate(s, PH, "块页", "");
    writeContent(s, PH, { title: "块页", json: contentOf(baseBlocks), text: "b1 原始\nb2 原始" }, Date.now());
    s.run("UPDATE pages SET dirty = 0, sync_seq = 1 WHERE id = ?", [PH]);
  }

  // A 改 b1（rev 1 → 2）并推上去（服务端存的是**整页 JSON** —— 真实负载形态）
  const aBlocks = withRev(baseBlocks, "b1", 2, "b1 由 A 改");
  writeContent(HA, PH, { title: "块页", json: contentOf(aBlocks), text: "b1 由 A 改\nb2 原始" }, Date.now());
  ok(getRow(HA, PH).dirty === 1, "H: A 改 b1 后 dirty=1（未同步）");
  const seqH1 = pushToServer(HA, PH, "devA", "块页", "b1 由 A 改\nb2 原始", contentOf(aBlocks));

  // B 改 b2（rev 1 → 2）；B pull 时本地 dirty=1 ⇒ 页级保留本地（今天的行为，不被 A 整页盖掉）
  const bBlocks = withRev(baseBlocks, "b2", 2, "b2 由 B 改");
  writeContent(HB, PH, { title: "块页", json: contentOf(bBlocks), text: "b1 原始\nb2 由 B 改" }, Date.now());
  ok(getRow(HB, PH).dirty === 1, "H: B 改 b2 后 dirty=1（未同步）");
  pullFromServer(HB, new Map([[PH, 1]]));
  ok(bodyOf(readContent(HB, PH).json, "b1") === "b1 原始", "H: B pull 时 dirty 保护本地 ⇒ B 手上的 b1 仍是原始版（页级语义，正确）");

  // B 推上去（服务端 seq 更大）；A 是干净的 ⇒ 页级判定说"用远端"
  const seqH2 = pushToServer(HB, PH, "devB", "块页", "b1 原始\nb2 由 B 改", contentOf(bBlocks));
  ok(seqH2 > seqH1, `H: B push 得 seq=${seqH2}（A 那一版是 ${seqH1}）`);

  // ★ **承重证明**：服务端那一版里 b1 是旧的 ⇒ 页级 LWW 整页吃下去就会**丢掉 A 的编辑**
  const remoteOnly = serverView.get(PH).content_json;
  ok(bodyOf(remoteOnly, "b1") === "b1 原始", "H: ★ 服务端那一版里 b1 是旧的 —— 整页 LWW 会丢掉 A 的编辑（这条就是块级合并要救的）");

  // ★★ **真接线**：A pull（干净且落后）⇒ `applyChange` 里应走"逐块合并"，把两边的编辑都落下来
  pullFromServer(HA, new Map([[PH, seqH1]]));
  const afterPull = readContent(HA, PH).json;
  ok(bodyOf(afterPull, "b1") === "b1 由 A 改", "H: ★★ 经真 `applyChange` 合并后，b1 保留 **A 的编辑**");
  ok(bodyOf(afterPull, "b2") === "b2 由 B 改", "H: ★★ 经真 `applyChange` 合并后，b2 取到 **B 的编辑**");
  ok(
    blocksOf(afterPull).map((b) => b.rev).join(",") === "2,2",
    `H: 合并产物把 rev 也写回了（漏了它下次会被误判成老客户端产物），实际=${blocksOf(afterPull).map((b) => b.rev).join(",")}`,
  );

  // ★ 冲突回落：同一块两端都改、rev 相等 ⇒ **不合并**，回落今天的页级 LWW（落下来的是远端那一版）
  const PC = "page-conflict";
  const CA = await newDevice();
  localCreate(CA, PC, "冲突页", "");
  // CA 本地那一版：b1 已经改到 rev 2（"A 版"），并且**已推上去**（dirty=0）
  const aConflictBlocks = [blk("b1", 2, "A 版"), blk("b2", 1, "b2 原始")];
  writeContent(CA, PC, { title: "冲突页", json: contentOf(aConflictBlocks), text: "" }, Date.now());
  CA.run("UPDATE pages SET dirty = 0, sync_seq = 1 WHERE id = ?", [PC]);
  pushToServer(CA, PC, "devA", "冲突页", "", contentOf(aConflictBlocks));
  // 另一台设备**并发改了同一块**（rev 也是 2、内容不同）⇒ 这才是真冲突
  pushToServer(CA, PC, "devB", "冲突页", "", contentOf([blk("b1", 2, "B 版"), blk("b2", 1, "b2 原始")]));
  pullFromServer(CA, new Map([[PC, 1]]));
  ok(
    bodyOf(readContent(CA, PC).json, "b1") === "B 版",
    "H: 冲突时**回落页级 LWW**（不静默选边）—— 落下来的就是远端那一版，与接线前逐字相同",
  );

  // ★★ **冲突留痕**（裁定 (iii) 的"不许静默"）：落表、读回、带两侧原文
  const conflicts = pageConflictsOf(CA, PC);
  ok(
    conflicts.length === 1 && conflicts[0].blockId === "b1" && conflicts[0].reason === "same-rev-different-content",
    `H: 冲突**落表**（不静默）—— 一条未决记录，实际=${conflicts.length}`,
  );
  ok(
    String(conflicts[0]?.localJson ?? "").includes("A 版") && String(conflicts[0]?.remoteJson ?? "").includes("B 版"),
    "H: 冲突记录里两侧原文都在（裁决才有得选）",
  );

  // ★★ **裁决「留本地」**：换回本地那一版 + 盖新 rev（maxSeen(2)+1 = 3）+ dirty=1（会被推上去）
  resolvePageConflict(CA, conflicts[0].id, "local");
  const resolvedDoc = readContent(CA, PC).json;
  ok(bodyOf(resolvedDoc, "b1") === "A 版", "H: 裁决「留本地」⇒ 内容换回本地那一版");
  ok(
    blocksOf(resolvedDoc).map((b) => b.rev).join(",") === "3,1",
    `H: 裁决后该块盖了新 rev（maxSeen(2)+1=3），实际=${blocksOf(resolvedDoc)
      .map((b) => b.rev)
      .join(",")}`,
  );
  ok(getRow(CA, PC).dirty === 1, "H: 裁决 = 一笔本地编辑（dirty=1 ⇒ 会被推上去）");
  ok(pageConflictsOf(CA, PC).length === 0, "H: 裁决之后不再是未决");

  // ★ 反判据一：老客户端产物（`blockRev` 被剥掉）而内容**变了** ⇒ **必须**提示
  //（若静默按"最旧"处理 ⇒ 这条红 —— 那正是裁定 (i) 被否决的理由）
  const oldClient = mergeBlocks(
    blocksOf(contentOf([blk("b1", null, "老客户端改的")])),
    blocksOf(contentOf([blk("b1", 9, "新客户端的")])),
    "remote",
  );
  ok(
    oldClient.blocks[0].choice === "conflict" && oldClient.blocks[0].reason === "missing-rev",
    "★ 反判据：缺 rev 且内容变了 ⇒ 必须提示（不许静默选边）",
  );
  ok(oldClient.conflicts[0].localJson === blocksOf(contentOf([blk("b1", null, "老客户端改的")]))[0].json, "冲突里带着两侧原文（UI 才有得取回）");

  // ★ 反判据二：老客户端"打开—原样保存"（剥了 rev、内容**逐字节相同**）⇒ **不许**提示
  //（否则提示会在每次同步冒出来 ⇒ 噪声 ⇒ 用户学会忽略 ⇒ 等于静默）
  const sameBytes = mergeBlocks(
    blocksOf(contentOf([blk("b1", 7, "一模一样")])),
    blocksOf(contentOf([blk("b1", null, "一模一样")])),
    "remote",
  );
  ok(
    sameBytes.blocks[0].choice === "identical" && sameBytes.conflicts.length === 0,
    "★ 反判据：内容逐字节相同 ⇒ 不许提示",
  );

  // ★ 已知边界（钉住，免得将来静默改成"消失"）：只在一侧的块**保留**、顺序取页级胜方那一侧
  const oneSide = mergeBlocks(
    [blk("b1", 1, "共有")],
    [blk("b1", 2, "远端改过"), blk("b9", 1, "远端新块")],
    "remote",
  );
  ok(
    oneSide.blocks.map((b) => b.blockId).join(",") === "b1,b9" &&
      oneSide.blocks[1].choice === "only-remote" &&
      oneSide.conflicts.length === 0,
    "已知边界：只在一侧的块保留（本片不做块级删除）、顺序 = 页级胜方 + 另一侧追加在表尾",
  );

  // =========== 场景 I：**保存路径**给每个有身份的顶层块盖 rev（真 `save_page`）===========
  // 接线的一半在保存侧：不盖章 ⇒ 块级判定每一页都会回落到页级 LWW（接线等于白接）。
  console.log("\n场景 I：保存路径盖 rev（真 `save_page` 命令）");
  const SI = await newDevice();
  const invokeSI = makeInvoke(SI);
  localCreate(SI, "page-stamp", "盖章页", "");
  SI.run("UPDATE pages SET content_json = ?, dirty = 0, sync_seq = 1 WHERE id = ?", [
    contentOf([blk("b1", null, "原始一"), blk("b2", null, "原始二")]),
    "page-stamp",
  ]);
  await invokeSI("save_page", {
    id: "page-stamp",
    content_json: contentOf([blk("b1", null, "改过"), blk("b2", null, "原始二")]),
  });
  const stampedDoc = readContent(SI, "page-stamp").json;
  ok(
    blocksOf(stampedDoc).map((b) => b.rev).join(",") === "1,0",
    `场景 I: 保存后 rev = 1,0（改过的那块 = max+1、没改的老块盖 0），实际=${blocksOf(stampedDoc)
      .map((b) => b.rev)
      .join(",")}`,
  );

  // =========== 场景 J：**恢复版本**也盖章（真 `restore_version`）===========
  // 恢复 = 一次本地编辑 ⇒ 不盖 rev 的话，恢复回来的块带着旧 rev（或没有）⇒ 下一次合并判错胜负，
  // 极端情况下这次恢复会被远端静默盖掉（与"恢复要置 dirty=1"那条同族）。
  console.log("\n场景 J：恢复版本盖 rev（真 `restore_version` 命令）");
  const SJ = await newDevice();
  const invokeSJ = makeInvoke(SJ);
  localCreate(SJ, "page-restore-stamp", "恢复页", "");
  SJ.run("UPDATE pages SET content_json = ?, dirty = 0, sync_seq = 1 WHERE id = ?", [
    contentOf([blk("b1", 3, "现在的"), blk("b2", 0, "B")]),
    "page-restore-stamp",
  ]);
  SJ.run(
    "INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at) VALUES (?,?,?,?,?,?)",
    [
      "ver-stamp",
      "page-restore-stamp",
      "恢复页",
      contentOf([blk("b1", null, "恢复回来的"), blk("b2", null, "B")]),
      "",
      Date.now(),
    ],
  );
  await invokeSJ("restore_version", { versionId: "ver-stamp" });
  const restoredDoc = readContent(SJ, "page-restore-stamp").json;
  ok(
    blocksOf(restoredDoc).map((b) => b.rev).join(",") === "4,0",
    `场景 J: 恢复后 b1 = max+1（3→4）、b2 没变保持 0，实际=${blocksOf(restoredDoc)
      .map((b) => b.rev)
      .join(",")}`,
  );

  // =========== 场景 K：同内容、不同 rev ⇒ **收敛到 max**（macOS 2026-09-22 抓到的真 bug）===========
  // 老写法 `l.rev ?? r.rev`（本地优先）会把本地那个**更旧**的 rev 留下 ⇒ 本地下一次编辑从更低的基线
  // 加一 ⇒ 编号追不上远端已经见过的编号 ⇒ 远端更旧的编辑在随后一次合并里**静默赢过**本地的编辑。
  // 这条场景把 macOS 给的 trace 走一遍：identical 那一步必须把 4 记下来，之后那次合并必须是**看得见的冲突**。
  console.log("\n场景 K：同内容不同 rev ⇒ 取 max（否则后续编辑被静默丢掉）");
  const PK = "page-maxrev";
  const KA = await newDevice();
  const KB = await newDevice();
  const invokeKA = makeInvoke(KA);
  const invokeKB = makeInvoke(KB);

  // 两端这一块**内容逐字相同**，rev 不同：A 已经到 4（它改过两轮又改回来），B 只有 2
  localCreate(KA, PK, "同内容页", "");
  KA.run("UPDATE pages SET content_json = ?, dirty = 0, sync_seq = 1 WHERE id = ?", [
    contentOf([blk("b1", 4, "一样")]),
    PK,
  ]);
  pushToServer(KA, PK, "devA", "同内容页", "", contentOf([blk("b1", 4, "一样")]));
  localCreate(KB, PK, "同内容页", "");
  KB.run("UPDATE pages SET content_json = ?, dirty = 0, sync_seq = 1 WHERE id = ?", [
    contentOf([blk("b1", 2, "一样")]),
    PK,
  ]);

  pullFromServer(KB, new Map([[PK, 1]]));
  const kB1 = blocksOf(readContent(KB, PK).json)[0];
  ok(bodyOf(readContent(KB, PK).json, "b1") === "一样", "K: 远端与本地内容逐字相同 ⇒ 走 identical（**不提示**）");
  ok(
    kB1.rev === 4,
    `K: ★ rev 必须收敛到 max(2,4)=4（老写法留下 2 —— 那正是那条 bug），实际=${kB1.rev}`,
  );

  // 之后两端各改这一块：A 从 4 加一到 5；B 从**合并产物的 4** 加一到 5（走真 `save_page` 盖章）
  await invokeKA("save_page", { id: PK, content_json: contentOf([blk("b1", null, "A 后改的")]) });
  await invokeKB("save_page", { id: PK, content_json: contentOf([blk("b1", null, "B 后改的")]) });
  ok(
    blocksOf(readContent(KA, PK).json)[0].rev === 5 && blocksOf(readContent(KB, PK).json)[0].rev === 5,
    `K: 两端各改一次 ⇒ 两边都盖 5，实际 A=${blocksOf(readContent(KA, PK).json)[0].rev} B=${blocksOf(readContent(KB, PK).json)[0].rev}`,
  );

  // B 先推（推完 B 就干净了），A 再推；B 回来 pull ⇒ 页级说"用远端"、块级判不了 ⇒ **冲突看得见**
  pushToServer(KB, PK, "devB", "同内容页", "", contentOf([blk("b1", 5, "B 后改的")]));
  pushToServer(KA, PK, "devA", "同内容页", "", contentOf([blk("b1", 5, "A 后改的")]));
  pullFromServer(KB, new Map([[PK, 1]]));
  const kConflicts = pageConflictsOf(KB, PK);
  ok(
    kConflicts.length === 1 && kConflicts[0].reason === "same-rev-different-content",
    `K: ★★ 同 rev 不同内容 ⇒ 冲突**看得见**（老写法这一条会是 0：B 的编辑被静默丢掉），实际=${kConflicts.length}`,
  );
  ok(
    bodyOf(readContent(KB, PK).json, "b1") === "A 后改的",
    "K: 冲突时回落页级 LWW（与接线前逐字相同）—— 这一片只把「静默」变成「有痕」",
  );

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
