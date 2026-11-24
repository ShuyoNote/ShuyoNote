// A1 影子扫描（**只读诊断，不是门禁**）：
//   默认 skip；只有 `A1_SHADOW_SCAN=1` 才跑，且只读打开本地空间库、不写任何库/不碰 dirty。
//   运行：$env:A1_SHADOW_SCAN="1"; pnpm exec vitest run scripts/a1-shadow-scan.test.ts --reporter=verbose
//   ⛔ 不注册进 scripts/lib/gates.mjs；不进 pre-commit / baseline。
import { describe, it } from "vitest";
type SqliteDb = import("node:sqlite").DatabaseSync;
type SqliteCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  lineageClientIds,
  lineagesRelated,
} from "./pageBinding";
import { openPageSession, projectStateToJson } from "./yDocBridge";

const RUN =
  process.env.A1_SHADOW_SCAN === "1" &&
  (!process.env.CI || process.env.A1_SHADOW_FORCE === "1");
// ⭐ G0 明确不覆盖加密空间：只有显式声明时才允许“排除”并继续；默认仍 NOT_VERIFIED。
const ALLOW_EXCLUDED = process.env.A1_ALLOW_ENCRYPTED_EXCLUDED === "1";
const DATA_DIR = process.env.SHUYONOTE_DATA_DIR ?? join(process.env.APPDATA ?? "", "cn.shuyo.shuyonote");
const MAGIC = Buffer.from("SQLite format 3\0", "utf8");

type Cat =
  | "no_change"
  | "merged_more_blocks"
  | "merged_fewer_blocks"
  | "projection_mismatch"
  | "projection_meta_only"
  | "projection_direction"
  | "projection_stale"
  | "lineage_incompatible"
  | "exception";

function openRo(path: string, Ctor: SqliteCtor): SqliteDb {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(MAGIC.length);
  try {
    readSync(fd, buf, 0, MAGIC.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buf;
  if (!head.equals(MAGIC)) throw new Error(`不是明文 SQLite（可能是加密空间）：${path}`);
  const db = new Ctor(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  return db;
}

function blockCount(json: string): number {
  try {
    const root = JSON.parse(json)?.root;
    return Array.isArray(root?.children) ? root.children.length : -1;
  } catch {
    return -1;
  }
}

/** 只比“内容”：`blockRev` 是编辑次数元数据，CRDT 状态投影与本地内容列会差它。 */
function stripVolatile(json: string): unknown {
  const o = JSON.parse(json);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      delete (v as Record<string, unknown>).blockRev;
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(o);
  return o;
}

/** 只额外忽略 `direction`：用于把“排版方向差异”与“内容差异”分开。 */
function stripDirection(v: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(v));
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      delete (x as Record<string, unknown>).direction;
      Object.values(x as Record<string, unknown>).forEach(walk);
    }
  };
  walk(copy);
  return copy;
}

function norm(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

interface PageRow {
  id: string;
  content_json: string;
  text_stale?: number;
}
interface PendingRow {
  page_id: string;
  seq: number;
  state: Uint8Array;
}

function scanSpace(dbPath: string, Ctor: SqliteCtor) {
  const db = openRo(dbPath, Ctor);
  const space = basename(dbPath, ".db");
  const totals: Record<Cat, number> = {
    no_change: 0,
    merged_more_blocks: 0,
    merged_fewer_blocks: 0,
    projection_mismatch: 0,
    projection_meta_only: 0,
    projection_direction: 0,
    projection_stale: 0,
    lineage_incompatible: 0,
    exception: 0,
  };
  const samples: Array<{ space: string; page: string; cat: Cat; detail: string }> = [];
  const add = (page: string, cat: Cat, detail: string) => {
    totals[cat] += 1;
    if (samples.length < 20) samples.push({ space, page, cat, detail });
  };

  const cols = db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
  const hasStale = cols.some((c) => c.name === "text_stale");
  const pages = db
    .prepare(`SELECT id, content_json${hasStale ? ", text_stale" : ""} FROM pages WHERE deleted_at IS NULL`)
    .all() as unknown as PageRow[];
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const local = new Map<string, Uint8Array>();
  for (const r of db.prepare("SELECT page_id, state FROM page_crdt").all() as Array<{
    page_id: string;
    state: Uint8Array;
  }>) {
    if (r.state?.length) local.set(r.page_id, r.state);
  }
  const pending = (
    db.prepare("SELECT page_id, seq, state FROM page_crdt_pending ORDER BY page_id, seq").all() as unknown as PendingRow[]
  ).filter((p) => p.state?.length);

  for (const row of pending) {
    const page = pageById.get(row.page_id);
    const mine = local.get(row.page_id);
    if (!page || !mine) continue;
    let mineJson: string;
    try {
      mineJson = projectStateToJson(mine);
    } catch (e) {
      add(row.page_id, "exception", `本机状态投影失败：${String(e)}`);
      continue;
    }
    try {
      if (!lineagesRelated(lineageClientIds(mine), lineageClientIds(row.state))) {
        add(row.page_id, "lineage_incompatible", `seq=${row.seq}`);
        continue;
      }
    } catch (e) {
      add(row.page_id, "exception", `血统解析失败：${String(e)}`);
      continue;
    }

    let mergedJson: string;
    try {
      const s = openPageSession({ state: mine });
      try {
        s.merge(row.state);
        mergedJson = projectStateToJson(s.exportState());
      } finally {
        s.dispose();
      }
    } catch (e) {
      add(row.page_id, "exception", `合并失败：${String(e)}`);
      continue;
    }

    if (isDeepStrictEqual(norm(mergedJson), norm(mineJson))) {
      add(row.page_id, "no_change", `seq=${row.seq}`);
    } else {
      const a = blockCount(mineJson);
      const b = blockCount(mergedJson);
      if (a >= 0 && b >= 0 && b < a) add(row.page_id, "merged_fewer_blocks", `seq=${row.seq} ${a}→${b}`);
      else if (a >= 0 && b >= 0 && b > a) add(row.page_id, "merged_more_blocks", `seq=${row.seq} ${a}→${b}`);
      else add(row.page_id, "no_change", `seq=${row.seq} 内容变但块数不变`);
    }

    const stored = norm(page.content_json);
    if (!isDeepStrictEqual(norm(mineJson), stored)) {
      let metaOnly = false;
      let dirOnly = false;
      try {
        const a = stripVolatile(mineJson);
        const b = stripVolatile(page.content_json);
        metaOnly = isDeepStrictEqual(a, b);
        dirOnly = isDeepStrictEqual(stripDirection(a), stripDirection(b));
      } catch {
        metaOnly = false;
        dirOnly = false;
      }
      add(
        row.page_id,
        dirOnly
          ? "projection_direction"
          : metaOnly
            ? "projection_meta_only"
            : page.text_stale === 1
              ? "projection_stale"
              : "projection_mismatch",
        `seq=${row.seq} 本机状态投影≠pages.content_json${dirOnly ? "（仅 direction）" : metaOnly ? "（仅 blockRev 等元数据）" : ""}`,
      );
    }
  }

  // ⭐ 审查 P1-4：**没有 pending 的页也要比投影**（否则“状态陈旧”会被判成安全）。
  const pendingPages = new Set(pending.map((p) => p.page_id));
  for (const [pageId, mine] of local) {
    if (pendingPages.has(pageId)) continue;
    const page = pageById.get(pageId);
    if (!page) continue;
    let mineJson: string;
    try {
      mineJson = projectStateToJson(mine);
    } catch (e) {
      add(pageId, "exception", `本机状态投影失败（无 pending）：${String(e)}`);
      continue;
    }
    if (isDeepStrictEqual(norm(mineJson), norm(page.content_json))) continue;
    let metaOnly = false;
    let dirOnly = false;
    try {
      const a = stripVolatile(mineJson);
      const b = stripVolatile(page.content_json);
      metaOnly = isDeepStrictEqual(a, b);
      dirOnly = isDeepStrictEqual(stripDirection(a), stripDirection(b));
    } catch {
      metaOnly = false;
      dirOnly = false;
    }
    add(
      pageId,
      dirOnly
        ? "projection_direction"
        : metaOnly
          ? "projection_meta_only"
          : page.text_stale === 1
            ? "projection_stale"
            : "projection_mismatch",
      "无 pending" + (dirOnly ? "（仅 direction）" : metaOnly ? "（仅 blockRev 等元数据）" : ""),
    );
  }

  return { space, pages: pages.length, pageWithCrdt: local.size, pending: pending.length, totals, samples };
}

describe.skipIf(!RUN)("A1 影子扫描（只读）", () => {
  it("扫描全部分空间并输出分类", async () => {
    let Ctor: SqliteCtor;
    try {
      // ⛔ 不在模块顶层 import：CI 的 Node 22 没有 `node:sqlite`（需实验开关）⇒ 会让整个文件收集失败。
      // ⚠️ 也不能用 `import("node:sqlite")` 字面量：Vite 会静态解析它（Node22 报 Cannot bundle）。
      // ⚠️ 也不能用 `new Function("import(...)")`：Vitest 的 VM 没有 dynamic import callback
      //   （实测 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING）。
      // ✅ 用 `process.getBuiltinModule`：不经过模块解析器，Node 22.3+ 才有。
      const getBuiltin = (process as unknown as {
        getBuiltinModule?: (id: string) => unknown;
      }).getBuiltinModule;
      if (!getBuiltin) throw new Error("NOT_VERIFIED：本机 Node 没有 process.getBuiltinModule");
      const mod = getBuiltin("node:sqlite") as { DatabaseSync: unknown } | undefined;
      if (!mod) throw new Error("NOT_VERIFIED：本机 Node 不提供 node:sqlite");
      Ctor = mod.DatabaseSync as unknown as SqliteCtor;
    } catch (e) {
      throw new Error(`NOT_VERIFIED：本机 node:sqlite 不可用（${String(e)}）`);
    }
    if (!existsSync(DATA_DIR)) throw new Error(`NOT_VERIFIED：找不到数据目录 ${DATA_DIR}`);
    const spacesDir = join(DATA_DIR, "spaces");
    if (!existsSync(spacesDir)) throw new Error(`NOT_VERIFIED：找不到 ${spacesDir}`);

    const all: Array<ReturnType<typeof scanSpace>> = [];
    const unreadable: Array<{ space: string; reason: string }> = [];
    for (const name of readdirSync(spacesDir).filter((n) => n.endsWith(".db"))) {
      try {
        all.push(scanSpace(join(spacesDir, name), Ctor));
      } catch (e) {
        unreadable.push({ space: name, reason: String(e) });
      }
    }

    const sum = (k: Cat) => all.reduce((n, s) => n + s.totals[k], 0);
    const report = {
      scanned_at: new Date().toISOString(),
      data_dir: DATA_DIR,
      spaces: all,
      unreadable,
      totals: {
        no_change: sum("no_change"),
        merged_more_blocks: sum("merged_more_blocks"),
        merged_fewer_blocks: sum("merged_fewer_blocks"),
        projection_mismatch: sum("projection_mismatch"),
        projection_meta_only: sum("projection_meta_only"),
        projection_direction: sum("projection_direction"),
        projection_stale: sum("projection_stale"),
        lineage_incompatible: sum("lineage_incompatible"),
        exception: sum("exception"),
        unreadable: unreadable.length,
        excluded_nonplaintext: ALLOW_EXCLUDED ? unreadable.length : 0,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `A1 影子：无差异 ${report.totals.no_change} ｜ 多块 ${report.totals.merged_more_blocks}` +
        ` ｜ 少块 ${report.totals.merged_fewer_blocks} ｜ 投影不一致 ${report.totals.projection_mismatch}` +
        ` ｜ 待重建 ${report.totals.projection_stale} ｜ 血统不相容 ${report.totals.lineage_incompatible}` +
        ` ｜ 异常 ${report.totals.exception} ｜ 读不到 ${report.totals.unreadable}`,
    );

    if (all.length === 0 || all.every((s) => s.pageWithCrdt === 0)) {
      throw new Error("NOT_VERIFIED：没有可扫描的 page_crdt 页（零覆盖不算通过）");
    }
    if (unreadable.length > 0 && !ALLOW_EXCLUDED) {
      throw new Error(`NOT_VERIFIED：有 ${unreadable.length} 个空间读不到（不算通过；确认要排除加密空间请设 A1_ALLOW_ENCRYPTED_EXCLUDED=1）`);
    }
    if (report.totals.merged_fewer_blocks + report.totals.projection_mismatch + report.totals.exception > 0) {
      throw new Error("发现危险差异（少块/投影不一致/异常）——未通过");
    }
  });
});
