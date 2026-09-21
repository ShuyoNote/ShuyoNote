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
import { localState, mergeBlocks, mergePageBlocks, readAllContents, readContent, resolveSaveContent, shouldTakeRemote, upsertRemoteContent, writeContent, type BlockMergeOutcome, type BlockSnapshot, type DocContent } from "./docContent";

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

describe("docContent.readAllContents（批量读出口：扫全库找块的派生读）", () => {
  it("只回**未软删**的页面，且三列逐字返回（含 id）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "甲", json: '{"root":{"children":[]}}', text: "甲正文" });
    seedPage(db, "p2", { title: "乙", json: '{"root":{"children":[1]}}', text: "乙正文" });
    seedPage(db, "p3", { title: "墓碑", json: "{}", text: "不该出现" });
    db.run("UPDATE pages SET deleted_at = 2 WHERE id = ?", ["p3"]);

    const rows = readAllContents(db);
    expect(rows.map((r) => r.id).sort()).toEqual(["p1", "p2"]);
    const p2 = rows.find((r) => r.id === "p2")!;
    expect(p2).toEqual({ id: "p2", title: "乙", json: '{"root":{"children":[1]}}', text: "乙正文" });
  });

  it("空库 ⇒ 空数组（不是 null：'没有页面'与'没有这一页'是两回事）", async () => {
    const db = await freshDb();
    expect(readAllContents(db)).toEqual([]);
  });

  it("⚠️ **没有 ORDER BY**（与搬运前逐字一致）—— `resolve_block` 依赖'第一个命中'，加排序就是行为改动", async () => {
    const db = await freshDb();
    seedPage(db, "b", { title: "后插的", json: '{"root":{"children":[]}}', text: "" });
    seedPage(db, "a", { title: "先插的", json: '{"root":{"children":[]}}', text: "" });
    // 只钉"返回的是插入顺序（rowid 顺序）"这一条事实；**不**钉 id 字典序，也不钉将来不许加排序。
    expect(readAllContents(db).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("docContent.localState / upsertRemoteContent（合并判定的读数 ＋ 「用远端」那一笔落库）", () => {
  it("localState：页面不存在 ⇒ undefined（判定据此走「本地没有 ⇒ 用远端」）", async () => {
    const db = await freshDb();
    expect(localState(db, "nope")).toBeUndefined();
  });

  it("localState：存在的页面 ⇒ 逐值给出 sync_seq / dirty", async () => {
    const db = await freshDb();
    seedPage(db, "p1", SAMPLE, { dirty: 1, syncSeq: 7 });
    expect(localState(db, "p1")).toEqual({ syncSeq: 7, dirty: 1 });
  });

  it("★ upsertRemoteContent：本地没有 ⇒ 插入，且 **dirty 落 0**、sync_seq 记成远端 seq", async () => {
    const db = await freshDb();
    upsertRemoteContent(db, { id: "p9", title: "远端页", content_json: '{"root":{"children":[]}}', content_text: "远端正文" }, 42);
    expect(readContent(db, "p9")).toEqual({ title: "远端页", json: '{"root":{"children":[]}}', text: "远端正文" });
    expect(localState(db, "p9")).toEqual({ syncSeq: 42, dirty: 0 });
  });

  it("★ upsertRemoteContent：本地已有 ⇒ 覆盖内容、**dirty 归 0**（这是「远端应用」的那一笔，与 writeContent 硬写 1 成对）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "本地标题", json: "{}", text: "本地正文" }, { dirty: 1, syncSeq: 3 });
    upsertRemoteContent(db, { id: "p1", title: "远端标题", content_json: "{}", content_text: "远端正文" }, 9);
    expect(readContent(db, "p1")).toEqual({ title: "远端标题", json: "{}", text: "远端正文" });
    expect(localState(db, "p1")).toEqual({ syncSeq: 9, dirty: 0 });
  });

  it("缺字段时的默认值**照搬**（`?? \"active\"` / `?? {}` / `?? 300` / `?? 50` …）——不是风格，是落库形态", async () => {
    const db = await freshDb();
    upsertRemoteContent(db, { id: "pz" }, 1);
    const row = db.query<Record<string, unknown>>("SELECT * FROM pages WHERE id = ?", ["pz"])[0];
    expect(row.workspace_id).toBe("active");
    expect(row.kind).toBe("page");
    expect(row.sort_order).toBe(0);
    expect(row.deleted_at).toBeNull();
    expect(row.content_json).toBe("{}");
    expect(row.content_text).toBe("");
    expect(row.db_rule).toBe("{}");
    expect(row.cover_height).toBe(300);
    expect(row.cover_pos).toBe(50);
    expect(row.dirty).toBe(0);
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

describe("docContent.mergeBlocks（★ 阶段 1：块级 LWW 纯函数）", () => {
  // 与 Rust 侧 `src-tauri/src/doc_content.rs` 的 `mod tests` **逐条对应**（改一边看另一边）：
  //   两端各改不同块 ⇒ 都保留        ↔ blocks_edited_on_different_sides_are_both_kept
  //   远端 rev 更大 / 本地 rev 更大   ↔ newer_remote_rev_takes_remote / newer_local_rev_keeps_local
  //   内容逐字节相同（缺 rev）        ↔ identical_content_is_not_a_conflict_even_when_revs_are_missing
  //   rev 相等而内容不同              ↔ equal_rev_different_content_is_a_conflict
  //   缺 rev 且内容变了（反判据）     ↔ missing_rev_with_changed_content_must_be_a_conflict
  //   只在一侧的块                    ↔ block_only_on_one_side_is_kept
  //   顺序边界                        ↔ order_comes_from_the_page_level_winner_and_extras_are_appended
  //   页级留本地不许被块级推翻        ↔ page_level_keep_local_never_consults_blocks
  //   冲突带两侧原文                  ↔ conflict_carries_both_sides_so_the_ui_can_offer_recovery
  //   一侧为空                        ↔ empty_side_takes_the_other_side_whole

  const blk = (blockId: string, rev: number | null, json: string): BlockSnapshot => ({ blockId, rev, json });
  const pick = (out: BlockMergeOutcome, id: string) => out.blocks.find((b) => b.blockId === id)!;
  const ids = (out: BlockMergeOutcome) => out.blocks.map((b) => b.blockId);

  it("★ 两端各改不同块 ⇒ 两边的内容都保留（阶段 1 的核心承诺）", () => {
    const local = [blk("b1", 2, "本地改过的 b1"), blk("b2", 1, "b2 原样")];
    const remote = [blk("b1", 1, "b1 原样"), blk("b2", 2, "远端改过的 b2")];

    const out = mergeBlocks(local, remote, "remote");

    expect(pick(out, "b1").choice).toBe("local");
    expect(pick(out, "b1").json).toBe("本地改过的 b1");
    expect(pick(out, "b2").choice).toBe("remote");
    expect(pick(out, "b2").json).toBe("远端改过的 b2");
    expect(out.conflicts).toEqual([]);
  });

  it("远端 rev 更大 ⇒ 用远端", () => {
    expect(mergeBlocks([blk("b1", 3, "旧")], [blk("b1", 4, "新")], "remote").blocks[0].json).toBe("新");
  });

  it("本地 rev 更大 ⇒ 留本地（远端更旧不许覆盖）", () => {
    const out = mergeBlocks([blk("b1", 5, "本地更新")], [blk("b1", 4, "远端更旧")], "remote");
    expect(out.blocks[0]).toMatchObject({ choice: "local", json: "本地更新" });
    expect(out.conflicts).toEqual([]);
  });

  it("★ 内容逐字节相同 ⇒ identical 且**不许提示**（老客户端「打开—原样保存」会剥掉 rev）", () => {
    // 反判据第二条（回复信 §三）：若也提示，提示会在每次同步冒出来 ⇒ 变噪声 ⇒ 用户学会忽略 ⇒ 等于静默。
    const out = mergeBlocks([blk("b1", 7, "一模一样")], [blk("b1", null, "一模一样")], "remote");
    expect(pick(out, "b1").choice).toBe("identical");
    expect(out.conflicts).toEqual([]);
  });

  it("rev 相等而内容不同 ⇒ 冲突 same-rev-different-content（并发同改同一块）", () => {
    const out = mergeBlocks([blk("b1", 2, "我改的")], [blk("b1", 2, "他改的")], "remote");
    expect(pick(out, "b1")).toMatchObject({ choice: "conflict", reason: "same-rev-different-content" });
    expect(out.conflicts).toHaveLength(1);
  });

  it("★ 缺 rev 且内容变了 ⇒ **必须**冲突 missing-rev（静默按「最旧」处理则本条红）", () => {
    const cases: [BlockSnapshot, BlockSnapshot][] = [
      [blk("b1", null, "老客户端改的"), blk("b1", 9, "新客户端的")],
      [blk("b1", 9, "新客户端的"), blk("b1", null, "老客户端改的")],
      [blk("b1", null, "甲"), blk("b1", null, "乙")],
    ];
    for (const [l, r] of cases) {
      const out = mergeBlocks([l], [r], "remote");
      expect(out.blocks[0]).toMatchObject({ choice: "conflict", reason: "missing-rev" });
      expect(out.conflicts).toHaveLength(1);
    }
  });

  it("只在一侧的块 ⇒ only-local / only-remote，且**不是**冲突（本片不做块级删除）", () => {
    const out = mergeBlocks(
      [blk("b1", 1, "共有"), blk("b-new", 1, "本地新块")],
      [blk("b1", 2, "远端改过"), blk("b-remote", 1, "远端新块")],
      "remote",
    );
    expect(pick(out, "b-new").choice).toBe("only-local");
    expect(pick(out, "b-remote").choice).toBe("only-remote");
    expect(out.conflicts).toEqual([]);
  });

  it("顺序边界：顺序取页级胜方那一侧，另一侧多出来的块**追加在表尾**", () => {
    const local = [blk("l1", 1, "l1"), blk("l2", 1, "l2"), blk("l3", 1, "l3")];
    const remote = [blk("r1", 1, "r1"), blk("r2", 1, "r2")];

    expect(ids(mergeBlocks(local, remote, "local"))).toEqual(["l1", "l2", "l3", "r1", "r2"]);
    expect(ids(mergeBlocks(local, remote, "remote"))).toEqual(["r1", "r2", "l1", "l2", "l3"]);
  });

  it("④ 页级留本地时**整页不动** —— 块级合并不许推翻它", () => {
    const local = [blk("b1", 1, "本地现状")];
    const remote = [blk("b1", 99, "远端更新")];

    // dirty=1 ⇒ 页级留本地
    expect(mergePageBlocks({ syncSeq: 3, dirty: 1 }, 99, local, remote)).toEqual({ action: "keep-local" });

    // 干净且落后 ⇒ 才做逐块比对
    const merged = mergePageBlocks({ syncSeq: 3, dirty: 0 }, 99, local, remote);
    expect(merged.action).toBe("merge");
    if (merged.action === "merge") expect(merged.blocks[0].json).toBe("远端更新");
  });

  it("冲突里**两侧原文都在**（UI 才有得取回）＋ blocks 里那一项是本地现状占位", () => {
    const out = mergeBlocks([blk("b1", 2, '{"v":"local"}')], [blk("b1", 2, '{"v":"remote"}')], "remote");
    expect(out.conflicts[0]).toEqual({
      blockId: "b1",
      reason: "same-rev-different-content",
      localJson: '{"v":"local"}',
      remoteJson: '{"v":"remote"}',
    });
    expect(pick(out, "b1").json).toBe('{"v":"local"}');
  });

  it("一侧为空 ⇒ 全取另一侧，且**不报冲突**（那不是「判不了」，是「另一侧全都有」）", () => {
    const out = mergeBlocks([], [blk("b1", 1, "甲的"), blk("b2", null, "乙的")], "remote");
    expect(ids(out)).toEqual(["b1", "b2"]);
    expect(out.blocks.every((b) => b.choice === "only-remote")).toBe(true);
    expect(out.conflicts).toEqual([]);
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
