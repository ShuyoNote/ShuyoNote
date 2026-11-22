// A1 影子扫描（**只读诊断，不是门禁**）：
//   默认 skip；只有 `A1_SHADOW_SCAN=1` 才跑，且只读打开本地空间库、不写任何库/不碰 dirty。
//   运行：$env:A1_SHADOW_SCAN="1"; pnpm exec vitest run scripts/a1-shadow-scan.test.ts --reporter=verbose
//   ⛔ 不注册进 scripts/lib/gates.mjs；不进 pre-commit / baseline。
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  lineageClientIds,
  lineagesRelated,
} from "../src/lib/crdt/pageBinding";
import { openPageSession, projectStateToJson } from "../src/lib/crdt/yDocBridge";

const RUN = process.env.A1_SHADOW_SCAN === "1";
const DATA_DIR = process.env.SHUYONOTE_DATA_DIR ?? join(process.env.APPDATA ?? "", "cn.shuyo.shuyonote");
const MAGIC = Buffer.from("SQLite format 3\0", "utf8");

type Cat =
  | "no_change"
  | "merged_more_blocks"
  | "merged_fewer_blocks"
  | "projection_mismatch"
  | "projection_stale"
  | "lineage_incompatible"
  | "exception";

function openRo(path: string): DatabaseSync {
  const head = readFileSync(path).subarray(0, MAGIC.length);
  if (!head.equals(MAGIC)) throw new Error(`不是明文 SQLite（可能是加密空间）：${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
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

function scanSpace(dbPath: string) {
  const db = openRo(dbPath);
  const space = basename(dbPath, ".db");
  const totals: Record<Cat, number> = {
    no_change: 0,
    merged_more_blocks: 0,
    merged_fewer_blocks: 0,
    projection_mismatch: 0,
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
    .all() as PageRow[];
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const local = new Map<string, Uint8Array>();
  for (const r of db.prepare("SELECT page_id, state FROM page_crdt").all() as Array<{
    page_id: string;
    state: Uint8Array;
  }>) {
    if (r.state?.length) local.set(r.page_id, r.state);
  }
  const pending = (
    db.prepare("SELECT page_id, seq, state FROM page_crdt_pending ORDER BY page_id, seq").all() as PendingRow[]
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
      add(
        row.page_id,
        page.text_stale === 1 ? "projection_stale" : "projection_mismatch",
        `seq=${row.seq} 本机状态投影≠pages.content_json`,
      );
    }
  }

  return { space, pages: pages.length, pageWithCrdt: local.size, pending: pending.length, totals, samples };
}

describe.skipIf(!RUN)("A1 影子扫描（只读）", () => {
  it("扫描全部分空间并输出分类", () => {
    if (!existsSync(DATA_DIR)) throw new Error(`NOT_VERIFIED：找不到数据目录 ${DATA_DIR}`);
    const spacesDir = join(DATA_DIR, "spaces");
    if (!existsSync(spacesDir)) throw new Error(`NOT_VERIFIED：找不到 ${spacesDir}`);

    const all: Array<ReturnType<typeof scanSpace>> = [];
    const unreadable: Array<{ space: string; reason: string }> = [];
    for (const name of readdirSync(spacesDir).filter((n) => n.endsWith(".db"))) {
      try {
        all.push(scanSpace(join(spacesDir, name)));
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
        projection_stale: sum("projection_stale"),
        lineage_incompatible: sum("lineage_incompatible"),
        exception: sum("exception"),
        unreadable: unreadable.length,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `A1 影子：无差异 ${report.totals.no_change} ｜ 多块 ${report.totals.merged_more_blocks}` +
        ` ｜ 少块 ${report.totals.merged_fewer_blocks} ｜ 投影不一致 ${report.totals.projection_mismatch}` +
        ` ｜ 待重建 ${report.totals.projection_stale} ｜ 血统不相容 ${report.totals.lineage_incompatible}` +
        ` ｜ 异常 ${report.totals.exception} ｜ 读不到 ${report.totals.unreadable}`,
    );

    if (unreadable.length > 0) throw new Error(`NOT_VERIFIED：有 ${unreadable.length} 个空间读不到（不算通过）`);
    if (report.totals.merged_fewer_blocks + report.totals.projection_mismatch + report.totals.exception > 0) {
      throw new Error("发现危险差异（少块/投影不一致/异常）——未通过");
    }
  });
});
