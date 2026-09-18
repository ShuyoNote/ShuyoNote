// 「文档内容」那一层（前端）的**行为级**判据 —— 真 `SqliteStore`（真 sql.js、真 SQL）驱动。
//
// 用例与 Rust 侧 `src-tauri/src/doc_content.rs` 的 `mod tests` **逐条对应**（改一边看另一边）：
//   · 本地没有这一页         ↔ local_page_absent_takes_remote
//   · 本地有未推送改动       ↔ dirty_local_wins_even_against_a_newer_seq
//   · 已同步到更晚的 seq     ↔ already_synced_past_this_change_keeps_local
//   · seq 相等（不是更晚）   ↔ equal_seq_is_not_newer_so_remote_wins
//   · 未改过且落后           ↔ clean_and_behind_takes_remote
//
// read/write 这两条用**真表**验（`pages` 由平台自己的 schema 建好），
// 因为"列名对不对、dirty 有没有写上"只有跑一条真 SQL 才知道。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteStore, setWasmBytesProvider } from "./platform/sqliteStore";
import { readContent, resolveSaveContent, shouldTakeRemote, writeContent, type DocContent } from "./docContent";

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  setWasmBytesProvider(async () => new Uint8Array(readFileSync(wasm)));
});

/** 真 store（`init()` 会把平台 schema 建好 —— `pages` 是**真表**，别自己再 CREATE 一遍）。 */
async function freshDb() {
  const store = new SqliteStore({ load: async () => null, save: async () => {} });
  await store.init();
  return store;
}

function seedPage(store: SqliteStore, id: string, content: DocContent, extra: Record<string, unknown> = {}) {
  store.run(
    `INSERT INTO pages (id, workspace_id, parent_id, title, kind, sort_order, created_at, updated_at, deleted_at, content_json, content_text, dirty, sync_seq)
     VALUES (?, 'active', NULL, ?, 'page', 0, 1, 1, NULL, ?, ?, ?, ?)`,
    [
      id,
      content.title,
      content.json,
      content.text,
      (extra.dirty as number) ?? 0,
      (extra.syncSeq as number) ?? 0,
    ],
  );
}

const SAMPLE: DocContent = {
  title: "会议纪要",
  json: '{"root":{"children":[]}}',
  text: "会议纪要正文",
};

describe("docContent.readContent（唯一读出口）", () => {
  it("页面不存在 ⇒ null（不是空串、不是抛错）", async () => {
    const db = await freshDb();
    expect(readContent(db, "nope")).toBeNull();
  });

  it("存在 ⇒ 三个字段逐字返回", async () => {
    const db = await freshDb();
    seedPage(db, "p1", SAMPLE);
    expect(readContent(db, "p1")).toEqual(SAMPLE);
  });

  it("软删（deleted_at 非空）⇒ 与「不存在」同解 —— 读出口不把墓碑当内容", async () => {
    const db = await freshDb();
    seedPage(db, "p1", SAMPLE);
    db.run("UPDATE pages SET deleted_at = 2 WHERE id = ?", ["p1"]);
    expect(readContent(db, "p1")).toBeNull();
  });
});

describe("docContent.writeContent（唯一写入口）", () => {
  it("写入后读回来一致，且**把 dirty 置 1**（同步契约：dirty 保护未推送的本地改动）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "旧", json: "{}", text: "旧" }, { dirty: 0, syncSeq: 9 });

    writeContent(db, "p1", SAMPLE, 12345);

    expect(readContent(db, "p1")).toEqual(SAMPLE);
    const row = db.query<{ updated_at: number; dirty: number; sync_seq: number }>(
      "SELECT updated_at, dirty, sync_seq FROM pages WHERE id = ?",
      ["p1"],
    )[0];
    expect(row.updated_at).toBe(12345);
    expect(row.dirty).toBe(1);
    // ⚠️ 写内容**不动** sync_seq：它不是"已同步到哪"的读数，改了会骗过合并判定。
    expect(row.sync_seq).toBe(9);
  });
});

describe("docContent.shouldTakeRemote（★ 唯一的合并点：页级 LWW）", () => {  it("本地没有这一页 ⇒ 用远端（新建）", () => {
    expect(shouldTakeRemote(undefined, 7)).toBe(true);
  });

  it("本地有未推送改动 ⇒ **留本地**，哪怕远端 seq 更大", () => {
    expect(shouldTakeRemote({ syncSeq: 3, dirty: 1 }, 99)).toBe(false);
  });

  it("已同步到更晚的 seq ⇒ 留本地", () => {
    expect(shouldTakeRemote({ syncSeq: 10, dirty: 0 }, 9)).toBe(false);
  });

  it("seq **相等不算更晚** ⇒ 用远端（与 Rust 侧 `local_seq > remote_seq` 的严格大于一致）", () => {
    expect(shouldTakeRemote({ syncSeq: 9, dirty: 0 }, 9)).toBe(true);
  });

  it("没改过且落后 ⇒ 用远端", () => {
    expect(shouldTakeRemote({ syncSeq: 4, dirty: 0 }, 5)).toBe(true);
  });
});

describe("docContent.resolveSaveContent（保存时「哪些字段真的被覆盖」）", () => {
  it("★ 只传标题（改名）⇒ **正文一个字都不动**", () => {
    // 这是本条语义存在的理由：Web 侧原先会把 content_json/content_text 清成空串，
    // 而 `dirty = 1` 会把这份空内容推到服务端 ⇒ 改名 = 别处内容也没了。
    expect(resolveSaveContent(SAMPLE, { title: "新标题" })).toEqual({
      title: "新标题",
      json: SAMPLE.json,
      text: SAMPLE.text,
    });
  });

  it("只传正文（模板中心的自动保存，没有标题）⇒ 标题保留", () => {
    expect(resolveSaveContent(SAMPLE, { content_json: "{}", content_text: "" })).toEqual({
      title: SAMPLE.title,
      json: "{}",
      text: "",
    });
  });

  it("三个都传 ⇒ 三个都用新值（含**显式空串**也照用：那是调用方的意图）", () => {
    expect(resolveSaveContent(SAMPLE, { title: "", content_json: "", content_text: "" })).toEqual({
      title: "",
      json: "",
      text: "",
    });
  });

  it("`null` / 数字 / 对象一律按「没带」处理（与桌面 `Option<String>` 的反序列化一致）", () => {
    for (const junk of [null, 123, { a: 1 }, []]) {
      expect(resolveSaveContent(SAMPLE, { title: junk, content_json: junk, content_text: junk })).toEqual(SAMPLE);
    }
  });

  it("undefined（字段缺省）也按「没带」处理", () => {
    expect(resolveSaveContent(SAMPLE, {})).toEqual(SAMPLE);
  });
});
