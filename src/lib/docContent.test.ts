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
import { applyBlockSnapshots, applyRemoteContent, blockSnapshotsOf, clearPendingRemote, localState, markPageDirty, markTextStale, mergeBlocks, mergePageBlocks, mergeRemoteContent, pageConflictsOf, pendingRemotePayload, pendingRemoteQueue, pendingRemoteSeq, readAllContents, readContent, recordPageConflicts, refreshPageTextIfStale, replaceBlockContent, resolvePageConflict, resolveSaveContent, shouldTakeRemote, staleTextQueue, stashPendingRemote, takeRemoteWholePage, textStale, upsertRemoteContent, writeContent, writeContentText, type BlockMergeOutcome, type BlockSnapshot, type DocContent } from "./docContent";
import { assignBlockRevs, canonicalContent } from "./blockRev";

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
     VALUES (?, 'active', NULL, ?, ?, 0, 1, 1, NULL, ?, ?, ?, ?)`,
    [
      id,
      content.title,
      (extra.kind as string) ?? "page",
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
  //   同内容不同 rev 取 max（★新）    ↔ identical_content_with_divergent_revs_converges_to_max
  //   rev 0 = 最旧（★新）             ↔ legacy_zero_rev_block_loses_to_explicit_remote_rev
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

  it("★ identical_content_with_divergent_revs_converges_to_max（macOS 2026-09-22 抓到的真 bug）", () => {
    // 同内容 ≠ 一样新。老写法 `l.rev ?? r.rev` 是"本地优先"⇒ 本地留下更旧的 rev ⇒ 本地下一次编辑
    // 从更低的基线加一 ⇒ 编号追不上远端已有的 ⇒ 远端更旧的编辑下一次**静默赢**（丢更新）。
    const cases: Array<[number | null, number | null, number | null]> = [
      [2, 4, 4],
      [4, 2, 4],
      [7, null, 7],
      [null, null, null],
    ];
    for (const [l, r, want] of cases) {
      const out = mergeBlocks([blk("b1", l, "逐字一样")], [blk("b1", r, "逐字一样")], "remote");
      expect(pick(out, "b1").choice).toBe("identical");
      expect(pick(out, "b1").rev).toBe(want);
      expect(out.conflicts).toEqual([]);
    }
  });

  it("★ rev === 0 的老块 + 远端 rev 3 ⇒ 取远端那一版、rev 抬到 3，且**不提示**", () => {
    // macOS §二 要求把三条语义钉在一起：0 = "老到不能再老"（比较时**小于**任何明确 rev）、
    // 不是"判不了"（不是冲突）、也**不是新版本**（盖章时改过的块一定拿 ≥1）。
    const out = mergeBlocks([blk("b1", 0, "老内容")], [blk("b1", 3, "远端改过的")], "remote");
    expect(pick(out, "b1")).toMatchObject({ choice: "remote", json: "远端改过的", rev: 3 });
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

describe("docContent 的接线适配器（落盘 JSON ⇄ 块表）与 mergeRemoteContent", () => {
  // 这一组是**阶段 1 接线**的判据：判定（mergeBlocks）只认"块表"，而线上两份都是整页 JSON。
  // 适配器刻意保守：**宁可回落页级 LWW，也不猜**。

  const blk = (blockId: string | undefined, rev: number | null, body: string) => ({
    type: "paragraph",
    ...(blockId === undefined ? {} : { blockId }),
    ...(rev === null ? {} : { blockRev: rev }),
    children: [{ type: "text", text: body }],
  });
  const doc = (...blocks: unknown[]) => JSON.stringify({ root: { children: blocks } });
  const bodiesOf = (json: string) =>
    ((JSON.parse(json) as { root: { children: Array<{ children: Array<{ text: string }> }> } }).root.children ?? []).map(
      (c) => c.children?.[0]?.text,
    );
  const revsOf = (json: string) =>
    (JSON.parse(json) as { root: { children: Array<{ blockRev?: number }> } }).root.children.map((c) => c.blockRev);

  it("blockSnapshotsOf：拆出 (blockId, rev, 片段)，且片段里**不含 blockRev**", () => {
    const blocks = blockSnapshotsOf(doc(blk("b1", 3, "甲"), blk("b2", null, "乙")));
    expect(blocks?.map((b) => b.blockId)).toEqual(["b1", "b2"]);
    expect(blocks?.map((b) => b.rev)).toEqual([3, null]);
    expect(blocks?.[0].json).not.toContain("blockRev");
  });

  it("★ 保守规则：只要有一个顶层块没有身份（老内容）⇒ undefined（不合并）", () => {
    expect(blockSnapshotsOf(doc(blk("b1", 1, "甲"), blk(undefined, null, "乙")))).toBeUndefined();
    expect(blockSnapshotsOf(doc(blk("", 1, "甲")))).toBeUndefined();
  });

  it("★ 保守规则：脏 JSON / 没有 root / children 不是数组 ⇒ undefined", () => {
    for (const bad of ["not json", "{}", '{"root":null}', '{"root":{"children":"nope"}}']) {
      expect(blockSnapshotsOf(bad)).toBeUndefined();
    }
  });

  it("applyBlockSnapshots：把 rev **写回**每个块（漏了它，下次合并会误判成老客户端产物）", () => {
    const merged = applyBlockSnapshots(
      doc(blk("b1", 1, "旧")),
      [
        { blockId: "b1", choice: "local", json: JSON.stringify(blk("b1", null, "新")), rev: 7 },
        { blockId: "b9", choice: "only-remote", json: JSON.stringify(blk("b9", null, "新块")), rev: null },
      ],
    )!;
    expect(bodiesOf(merged)).toEqual(["新", "新块"]);
    expect(revsOf(merged)).toEqual([7, undefined]);
  });

  it("★ mergeRemoteContent：两端各改**不同块** ⇒ 两边的编辑都在、rev 也都在", () => {
    const local = doc(blk("b1", 2, "A 改的"), blk("b2", 1, "b2 原始"));
    const remote = doc(blk("b1", 1, "b1 原始"), blk("b2", 2, "B 改的"));

    const outcome = mergeRemoteContent(local, remote);

    expect(outcome.kind).toBe("merged");
    const merged = outcome.kind === "merged" ? outcome.json : "";
    expect(bodiesOf(merged)).toEqual(["A 改的", "B 改的"]);
    expect(revsOf(merged)).toEqual([2, 2]); // 各自选中那一版的 rev
  });

  it("★ mergeRemoteContent：有冲突（rev 相等而内容不同）⇒ `conflicted`（**不静默选边**，要留痕）", () => {
    const outcome = mergeRemoteContent(doc(blk("b1", 2, "我改的")), doc(blk("b1", 2, "他改的")));
    expect(outcome.kind).toBe("conflicted");
    if (outcome.kind === "conflicted") {
      expect(outcome.conflicts).toHaveLength(1);
      expect(outcome.conflicts[0]).toMatchObject({ blockId: "b1", reason: "same-rev-different-content" });
      expect(outcome.conflicts[0].localJson).toContain("我改的");
      expect(outcome.conflicts[0].remoteJson).toContain("他改的");
    }
  });

  it("★ mergeRemoteContent：任一侧缺 rev ⇒ 也是 `conflicted`（判不了就不判）", () => {
    expect(mergeRemoteContent(doc(blk("b1", null, "我改的")), doc(blk("b1", 5, "他的"))).kind).toBe("conflicted");
    expect(mergeRemoteContent(doc(blk("b1", 5, "我的")), doc(blk("b1", null, "他改的"))).kind).toBe("conflicted");
  });

  it("★ mergeRemoteContent：老内容（没有块身份）⇒ `not-applicable`（**不是**冲突）", () => {
    expect(mergeRemoteContent(doc(blk(undefined, null, "老")), doc(blk("b1", 1, "新"))).kind).toBe("not-applicable");
    expect(mergeRemoteContent("not json", doc(blk("b1", 1, "新"))).kind).toBe("not-applicable");
  });

  it("★ 与 rev 层配合：合并产物再走一遍 `assignBlockRevs` ⇒ **rev 不倒退、内容不再变**", () => {
    // 承重：合并产物是"下一次保存的 baseline"。若物化时把 rev 丢了，assignBlockRevs 会把每个块当成
    // "老客户端产物" 重新盖 0/1 —— rev 倒退 ⇒ 下一次合并的胜负判断就错了。
    const local = doc(blk("b1", 4, "A 改的"), blk("b2", 1, "b2 原始"));
    const remote = doc(blk("b1", 1, "b1 原始"), blk("b2", 5, "B 改的"));
    const outcome = mergeRemoteContent(local, remote);
    const merged = outcome.kind === "merged" ? outcome.json : "";

    const stamped = assignBlockRevs(merged, merged);
    expect(revsOf(stamped)).toEqual([4, 5]);
    expect(bodiesOf(stamped)).toEqual(["A 改的", "B 改的"]);
  });
});

describe("docContent 的冲突留痕与裁决（表 page_conflicts）", () => {
  // 裁定 (iii)：判不了就**不静默选边** —— 冲突要落表（提示 UI 的数据），覆盖语义这一片**不变**。

  const blk = (blockId: string, rev: number | null, body: string) => ({
    type: "paragraph",
    blockId,
    ...(rev === null ? {} : { blockRev: rev }),
    children: [{ type: "text", text: body }],
  });
  const doc = (...blocks: unknown[]) => JSON.stringify({ root: { children: blocks } });
  const bodiesOf = (json: string) =>
    ((JSON.parse(json) as { root: { children: Array<{ children: Array<{ text: string }> }> } }).root.children ?? []).map(
      (c) => c.children?.[0]?.text,
    );
  const revsOf = (json: string) =>
    (JSON.parse(json) as { root: { children: Array<{ blockRev?: number }> } }).root.children.map((c) => c.blockRev);

  it("replaceBlockContent：只换那一块；块不在这份文档里 ⇒ undefined（裁决据此拒绝）", () => {
    const d = doc(blk("b1", 1, "旧"), blk("b2", 1, "别动"));
    const out = replaceBlockContent(d, "b1", JSON.stringify(blk("b1", null, "新")))!;
    expect(bodiesOf(out)).toEqual(["新", "别动"]);
    expect(replaceBlockContent(d, "nope", "{}")).toBeUndefined();
    expect(replaceBlockContent("not json", "b1", "{}")).toBeUndefined();
  });

  it("★ 落表 + 读回 + **去重**：同一 (页, 块) 的未决记录只留一条", async () => {
    const db = await freshDb();
    const conflict = {
      blockId: "b1",
      reason: "same-rev-different-content" as const,
      localJson: JSON.stringify(blk("b1", null, "我改的")),
      remoteJson: JSON.stringify(blk("b1", null, "他改的")),
    };
    recordPageConflicts(db, "p1", [conflict]);
    recordPageConflicts(db, "p1", [conflict]);

    const rows = pageConflictsOf(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ blockId: "b1", reason: "same-rev-different-content", resolvedAt: null });
    expect(rows[0].localJson).toContain("我改的");
    expect(rows[0].remoteJson).toContain("他改的");
    expect(pageConflictsOf(db, "p2")).toEqual([]);
  });

  it("★ 只有真裁决会改变未决计数（AMD：『关掉提示』≠『已裁决』）", async () => {
    // 与 Rust 侧 `only_a_real_resolution_changes_the_unresolved_count` 逐条对应。
    // 今天的提示条**没有关闭动作**（没有未决记录时它自己消失）⇒ 等价的可测形态是：
    // **只有 `resolved_at` 被写上才会让这一行从"未决"里消失**；写页面、重放、重复读都不许动这个计数。
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 2, "我改的")), text: "" }, { dirty: 0, syncSeq: 1 });
    const conflict = {
      blockId: "b1",
      reason: "same-rev-different-content" as const,
      localJson: JSON.stringify(blk("b1", null, "我改的")),
      remoteJson: JSON.stringify(blk("b1", null, "他改的")),
    };
    recordPageConflicts(db, "p1", [conflict]);
    recordPageConflicts(db, "p1", [conflict]); // 重连 / 重放同一格 ⇒ 不增长
    expect(pageConflictsOf(db, "p1")).toHaveLength(1);

    writeContent(db, "p1", { title: "页", json: doc(blk("b1", 3, "改过")), text: "" }, Date.now());
    expect(pageConflictsOf(db, "p1")).toHaveLength(1); // 写页面不是裁决

    expect(pageConflictsOf(db, "p1")).toHaveLength(1); // 重复读也不动
    resolvePageConflict(db, pageConflictsOf(db, "p1")[0].id, "remote");
    expect(pageConflictsOf(db, "p1")).toEqual([]); // 只有真裁决会变
  });

  it("★ 裁决「留本地」⇒ 该块换回本地那一版、**盖新 rev**、`dirty=1`（这次裁决要被推上去）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", {
      title: "页",
      json: doc(blk("b1", 3, "远端赢了的那版"), blk("b2", 0, "别动")),
      text: "",
    });
    recordPageConflicts(db, "p1", [
      {
        blockId: "b1",
        reason: "same-rev-different-content" as const,
        localJson: JSON.stringify(blk("b1", null, "我原来改的")),
        remoteJson: JSON.stringify(blk("b1", null, "远端赢了的那版")),
      },
    ]);
    const id = pageConflictsOf(db, "p1")[0].id;

    resolvePageConflict(db, id, "local");

    const after = readContent(db, "p1")!;
    expect(bodiesOf(after.json)).toEqual(["我原来改的", "别动"]);
    expect(revsOf(after.json)).toEqual([4, 0]); // maxSeen(3) + 1
    expect(localState(db, "p1")!.dirty).toBe(1); // 裁决 = 一笔本地编辑
    expect(pageConflictsOf(db, "p1")).toEqual([]); // 已决
    expect(() => resolvePageConflict(db, id, "remote")).toThrow("冲突不存在或已裁决");
  });

  it("★ applyRemoteContent：冲突时**落表**且覆盖语义不变（仍用远端原样）", async () => {
    const db = await freshDb();
    const localJson = doc(blk("b1", 2, "我改的"));
    seedPage(db, "p1", { title: "页", json: localJson, text: "" }, { dirty: 0, syncSeq: 1 });

    const merged = applyRemoteContent(
      db,
      "p1",
      { id: "p1", title: "页", content_json: doc(blk("b1", 2, "他改的")), content_text: "" },
      9,
    );

    // ★ 返回值必须把"有未裁决冲突"交出来（AMD 2026-09-22："留痕 ≠ 已裁决"，哪怕只是个计数）
    expect(merged).toEqual({ merged: false, unresolved: 1 });
    expect(bodiesOf(readContent(db, "p1")!.json)).toEqual(["他改的"]); // 页级 LWW：落的是远端原样
    const rows = pageConflictsOf(db, "p1");
    expect(rows).toHaveLength(1);
    expect(rows[0].localJson).toContain("我改的");
    expect(rows[0].remoteJson).toContain("他改的");
  });

  it("★ applyRemoteContent：无冲突时合并 + **不落表**", async () => {
    const db = await freshDb();
    seedPage(
      db,
      "p1",
      { title: "页", json: doc(blk("b1", 2, "A 改的"), blk("b2", 1, "b2 原始")), text: "" },
      { dirty: 0, syncSeq: 1 },
    );

    const merged = applyRemoteContent(
      db,
      "p1",
      { id: "p1", title: "页", content_json: doc(blk("b1", 1, "b1 原始"), blk("b2", 2, "B 改的")), content_text: "" },
      9,
    );

    expect(merged).toEqual({ merged: true, unresolved: 0 });
    expect(bodiesOf(readContent(db, "p1")!.json)).toEqual(["A 改的", "B 改的"]);
    expect(pageConflictsOf(db, "p1")).toEqual([]);
  });

  it("★ 物化会把**嵌层**的同名 `blockRev` 剥掉（今天已知边界），但内容一个字节不许动", () => {
    // macOS §四 (d)：要么限定只剥顶层、要么写进文档。这里选"写进文档 + 钉成判据"：
    // `blockRev` 是管道，哪一层都不是内容 ⇒ 比较与物化都剥；代价是物化的嵌层同名字段会消失。
    const nested = {
      type: "quote",
      blockId: "b1",
      children: [
        { type: "paragraph", blockId: "nested-1", blockRev: 9, children: [{ type: "text", text: "引用里的字" }] },
      ],
    };
    const merged = applyBlockSnapshots(doc(nested), [
      { blockId: "b1", choice: "identical", json: canonicalContent(nested), rev: 4 },
    ])!;
    const parsed = JSON.parse(merged) as { root: { children: Array<Record<string, unknown>> } };
    const b1 = parsed.root.children[0] as { blockRev?: number; children: Array<Record<string, unknown>> };
    expect(b1.blockRev).toBe(4);
    expect(b1.children[0].blockRev).toBeUndefined(); // 嵌层会被剥掉（边界）
    expect(b1.children[0].blockId).toBe("nested-1"); // 内容（身份、文字）不许动
    expect((b1.children[0].children as Array<{ text: string }>)[0].text).toBe("引用里的字");
  });
});

describe("docContent 的正文文本本地修复（阶段 1 的收口）", () => {
  it("★ writeContentText：**只动正文** —— 内容 JSON、dirty、sync_seq 一个都不许动", async () => {
    // 它是"合并/裁决产物的正文补算"用的写入（那类内容没有编辑器参与 ⇒ 正文滞后一拍）。
    // 标脏就会把它当成一笔本地编辑推上去 —— 那不是这一层的职责。
    const db = await freshDb();
    const json = JSON.stringify({ root: { children: [{ type: "paragraph", blockId: "b1", blockRev: 2 }] } });
    seedPage(db, "p1", { title: "页", json, text: "旧文本（页级胜方那一份）" }, { dirty: 1, syncSeq: 3 });

    writeContentText(db, "p1", "按编辑器语义补算出来的正文");

    const after = readContent(db, "p1")!;
    expect(after.text).toBe("按编辑器语义补算出来的正文");
    expect(after.json).toBe(json);
    expect(localState(db, "p1")).toEqual({ syncSeq: 3, dirty: 1 });

    // 带判据的那一个：**相同 ⇒ 一次写库都没有**（绝大多数页面走这条）
    expect(refreshPageTextIfStale(db, "p1", "按编辑器语义补算出来的正文")).toBe(false);
    expect(refreshPageTextIfStale(db, "p1", "又变了")).toBe(true);
    expect(readContent(db, "p1")!.text).toBe("又变了");
    // 页面不存在 ⇒ 不修（不猜）
    expect(refreshPageTextIfStale(db, "nope", "随便")).toBe(false);
  });
});

// B1（2026-09-22）· 「正文待重建」标记 ＋ 队列 —— 与 Rust 侧 `doc_content::tests` 的同名三条**逐条对应**。
describe("docContent 的「正文待重建」标记与队列（B1）", () => {
  // 夹具就在这一段里（同文件其它 describe 各自也有一份，互不借用）
  const blk = (blockId: string | undefined, rev: number | null, body: string) => ({
    type: "paragraph",
    ...(blockId === undefined ? {} : { blockId }),
    ...(rev === null ? {} : { blockRev: rev }),
    children: [{ type: "text", text: body }],
  });
  const doc = (...blocks: unknown[]) => JSON.stringify({ root: { children: blocks } });

  it("★ 只有真合并/裁决才打标记（冲突回落与「没什么可合」两支不許打）", async () => {
    const db = await freshDb();
    // ① 合并成功 ⇒ 打
    seedPage(
      db,
      "p1",
      { title: "页", json: doc(blk("b1", 2, "本地改的"), blk("b2", 1, "b2 原始")), text: "本地正文" },
      { dirty: 0, syncSeq: 1 },
    );
    const merged = applyRemoteContent(
      db,
      "p1",
      {
        id: "p1",
        title: "页",
        content_json: doc(blk("b1", 1, "b1 原始"), blk("b2", 2, "远端改的")),
        content_text: "远端正文",
      },
      9,
    );
    expect(merged.merged).toBe(true);
    expect(textStale(db, "p1")).toBe(true);

    // ② 冲突回落（用远端原样）⇒ 不打
    seedPage(db, "p2", { title: "页", json: doc(blk("b1", 2, "我改的")), text: "" }, { dirty: 0, syncSeq: 1 });
    const conflicted = applyRemoteContent(
      db,
      "p2",
      { id: "p2", title: "页", content_json: doc(blk("b1", 2, "他改的")), content_text: "" },
      9,
    );
    expect(conflicted.unresolved).toBe(1);
    expect(textStale(db, "p2")).toBe(false);

    // ③ 没什么可合（老内容没有块身份）⇒ 也不打
    seedPage(db, "p3", { title: "页", json: doc(blk(undefined, null, "老")), text: "" }, { dirty: 0, syncSeq: 1 });
    applyRemoteContent(db, "p3", { id: "p3", title: "页", content_json: doc(blk("b1", 1, "新")), content_text: "" }, 9);
    expect(textStale(db, "p3")).toBe(false);

    // ④ **产物 == 远端那一版**（两端逐字相同）⇒ 也**不许**打（正文列与内容一致；打了就是假账）
    seedPage(db, "p4", { title: "页", json: doc(blk("b1", 7, "一模一样")), text: "一模一样" }, { dirty: 0, syncSeq: 1 });
    const same = applyRemoteContent(
      db,
      "p4",
      { id: "p4", title: "页", content_json: doc(blk("b1", 7, "一模一样")), content_text: "一模一样" },
      9,
    );
    expect(same.merged).toBe(true); // 合得上（虽然什么都没变）
    expect(textStale(db, "p4")).toBe(false);
  });

  it("★ 裁决打标记；队列交得出来（id/标题/文档 JSON），补算后清标记、队列空", async () => {
    const db = await freshDb();
    seedPage(
      db,
      "p1",
      { title: "页", json: doc(blk("b1", 3, "远端赢了的那版"), blk("b2", 0, "别动")), text: "" },
      { dirty: 0, syncSeq: 1 },
    );
    recordPageConflicts(db, "p1", [
      {
        blockId: "b1",
        reason: "same-rev-different-content" as const,
        localJson: JSON.stringify(blk("b1", null, "我原来改的")),
        remoteJson: JSON.stringify(blk("b1", null, "远端赢了的那版")),
      },
    ]);
    resolvePageConflict(db, pageConflictsOf(db, "p1")[0].id, "local");
    expect(textStale(db, "p1")).toBe(true);

    const q = staleTextQueue(db, 10);
    expect(q.total).toBe(1);
    expect(q.pages).toHaveLength(1);
    expect(q.pages[0].pageId).toBe("p1");
    expect(q.pages[0].title).toBe("页");
    expect(q.pages[0].docJson).toContain("我原来改的");
    // `limit` 夹到 ≥1（后台动作不许一次把整库拖进来）
    expect(staleTextQueue(db, 0).pages).toHaveLength(1);

    // 补算之后：标记清掉、队列空
    expect(refreshPageTextIfStale(db, "p1", "补算出来的正文")).toBe(true);
    expect(textStale(db, "p1")).toBe(false);
    expect(staleTextQueue(db, 10).total).toBe(0);
  });

  it("★ 算出来与库里相同也清标记（否则「还有 N 页」会挂着假账）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "正文")), text: "" }, { dirty: 0, syncSeq: 1 });
    markTextStale(db, "p1");
    expect(textStale(db, "p1")).toBe(true);

    expect(refreshPageTextIfStale(db, "p1", "")).toBe(false); // 相同 ⇒ 不写正文

    expect(textStale(db, "p1")).toBe(false); // 但标记必须清掉
    expect(staleTextQueue(db, 10).total).toBe(0);
    // 页面不存在 ⇒ 不猜（也不报错）
    expect(textStale(db, "nope")).toBeUndefined();
  });

  // ── 2026-09-23（Windows 侧）：数据库页与这条队列的**交叉口子** ────────────────────────
  // P3-② 接线（`1e68f680`）之后，数据库页的正文 ＝ 列名 ＋ 行 ＋ 规则，由**视图侧**写进去；
  // 而它**不在 `content_json` 里** ⇒ 补算器从 JSON 派生出来的是空 ⇒ 一旦入队就会把行文本**抹掉**。
  it("★ 数据库页不打「待重建」：它的正文不来自 JSON，补算只会抹掉行文本", async () => {
    const db = await freshDb();
    const ROWS_TEXT = "数据库：任务库\n列：状态（选项：待办、进行中）\n行：\n审批：状态＝进行中";
    seedPage(db, "db1", { title: "任务库", json: "{}", text: "" }, { kind: "database" });
    db.run("UPDATE pages SET content_text = ? WHERE id = ?", [ROWS_TEXT, "db1"]);

    markTextStale(db, "db1");

    expect(textStale(db, "db1")).toBe(false);
    expect(staleTextQueue(db, 10).total).toBe(0);
    // 行文本一个字节都没动（这才是这条判据真正要守的东西）
    expect(db.query<{ t: string }>("SELECT content_text AS t FROM pages WHERE id = ?", ["db1"])[0].t).toBe(ROWS_TEXT);
  });

  it("★ 存量库：接线之前被标过的数据库页也不入队（双保险）", async () => {
    const db = await freshDb();
    seedPage(db, "db1", { title: "任务库", json: "{}", text: "" }, { kind: "database" });
    // 绕过 markTextStale，直接置标记 —— 模拟接线之前留下的存量行
    db.run("UPDATE pages SET text_stale = 1 WHERE id = ?", ["db1"]);
    expect(staleTextQueue(db, 10).total).toBe(0);
    expect(staleTextQueue(db, 10).pages).toHaveLength(0);
  });

  it("普通页面照旧：标记 + 入队（回归守护 —— 别把整类页面一起排除掉）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "正文")), text: "" });
    markTextStale(db, "p1");
    expect(textStale(db, "p1")).toBe(true);
    expect(staleTextQueue(db, 10).total).toBe(1);
  });
});

// B 方案（2026-09-22）·「未取回的远端版本」——与 Rust `doc_content.rs` 的 `pending_remote_*` 逐条对应。
// 要修的东西：页级保留本地（裁定 ④）语义正确，但那一版远端内容会被游标吃掉
// ⇒ 取证文件 `docs/plans/2026-09-22-merge-push-and-cursor-forensics.md` §3.2 的 L。
describe("docContent 的「未取回的远端版本」（B 方案）", () => {
  // 夹具就在这一段里（同文件其它 describe 各自也有一份，互不借用）
  const blk = (blockId: string, rev: number | null, body: string) => ({
    type: "paragraph",
    blockId,
    ...(rev === null ? {} : { blockRev: rev }),
    children: [{ type: "text", text: body }],
  });
  const doc = (...blocks: unknown[]) => JSON.stringify({ root: { children: blocks } });
  const remoteRow = (id: string, json: string, title = "远端标题") => ({
    id,
    workspace_id: "active",
    title,
    content_json: json,
    content_text: "",
    updated_at: 5,
  });

  it("每页只留最新一条（第二次 stash 是覆盖，不是追加）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "本地")), text: "" });
    stashPendingRemote(db, remoteRow("p1", doc(blk("b1", 2, "远端旧"))), 7, 100);
    stashPendingRemote(db, remoteRow("p1", doc(blk("b1", 3, "远端新"))), 9, 200);

    const q = pendingRemoteQueue(db, 10);
    expect(q.total).toBe(1);
    expect(q.pages[0]).toMatchObject({ page_id: "p1", seq: 9, stashed_at: 200 });
    const archived = pendingRemotePayload(db, "p1")!;
    expect(archived.seq).toBe(9);
    expect(String(archived.row.content_json)).toContain("远端新");
    expect(String(archived.row.content_json)).not.toContain("远端旧");
    // `limit` 只影响这一批、不影响总数
    expect(pendingRemoteQueue(db, 0).pages).toHaveLength(0);
    expect(pendingRemoteQueue(db, 0).total).toBe(1);
  });

  it("没存着 ⇒ 清一次、查一次都不报错（绝大多数页面走这条）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "本地")), text: "" });
    expect(pendingRemoteSeq(db, "p1")).toBeUndefined();
    expect(pendingRemotePayload(db, "p1")).toBeUndefined();
    clearPendingRemote(db, "p1");
    expect(pendingRemoteQueue(db, 10).total).toBe(0);
  });

  it("采用远端：整页换掉 ＋ dirty 归零 ＋ 把旧的未裁决冲突标掉", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "本地")), text: "" }, { dirty: 1 });
    recordPageConflicts(db, "p1", [
      {
        blockId: "b1",
        reason: "same-rev-different-content" as const,
        localJson: JSON.stringify(blk("b1", null, "本地")),
        remoteJson: JSON.stringify(blk("b1", null, "远端")),
      },
    ]);
    expect(pageConflictsOf(db, "p1")).toHaveLength(1);

    takeRemoteWholePage(db, remoteRow("p1", doc(blk("b1", 9, "远端赢了"))), 11);

    const after = readContent(db, "p1")!;
    expect(after.title).toBe("远端标题");
    expect(after.json).toContain("远端赢了");
    expect(after.json).not.toContain("本地");
    expect(localState(db, "p1")).toMatchObject({ syncSeq: 11, dirty: 0 });
    expect(pageConflictsOf(db, "p1")).toHaveLength(0); // 整页换掉 ⇒ 旧的那些痕没有可裁决的对象了
  });

  it("markPageDirty 是 dirty 这一列的第三个写者（write 写 1 / upsertRemote 写 0 / writeText 不动）", async () => {
    const db = await freshDb();
    seedPage(db, "p1", { title: "页", json: doc(blk("b1", 1, "本地")), text: "" }, { dirty: 0 });
    markPageDirty(db, "p1");
    expect(localState(db, "p1")!.dirty).toBe(1);
    // 远端应用会把它压回 0（这就是"合并之后要重新标上"的原因）
    takeRemoteWholePage(db, remoteRow("p1", doc(blk("b1", 1, "远端"))), 3);
    expect(localState(db, "p1")!.dirty).toBe(0);
    markPageDirty(db, "p1");
    expect(localState(db, "p1")!.dirty).toBe(1);
  });
});
