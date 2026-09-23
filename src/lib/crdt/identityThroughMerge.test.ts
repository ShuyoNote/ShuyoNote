// 冲刺 **S6b** 的判据：**块身份穿过合并**（集合不变、不重复、不新铸）。
//
// 为什么这条要单独钉：S1 红线（"从 JSON 各自新建 ⇒ 一块变两块"）在**合并**这条路上的表现就是
// `blockId` 重复 —— 而块引用、反链、冲突裁决全都按 `blockId` 认人。所以这里用**产品自己那个读块身份
// 的函数**（`blockIdentity::topLevelBlockIds`，`editor/Editor.tsx` 与反链那条路都从它出发）来验，
// 而不是自己再数一遍 JSON（那证明的是"我的检查器"，不是"产品读得到"）。
//
// 口径（S6b 收口的那一句）：
//   · **铸身份只发生在一处**：保存路径/首开补种（`serializeWithBlockIds` / `Editor.tsx` 载入时那次）
//     —— 已由 S3b-2a 的 `ensurePageCrdtState` 收成"只发生一次"；
//   · **转换层与合并路径一律不铸**（桥接层缺身份时当场抛是它的正面判据）。
//   ⇒ 于是"合并前后 id 集合 = 两侧并集、每个 id 只出现一次、没有任何新面孔"就是可验的。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, topLevelBlockIds } from "../blockIdentity";
import { readPageCrdtState, type ContentSql } from "../docContent";
import { mergeRemotePageState } from "./pageBinding";
import { openPageSession, projectStateToJson } from "./yDocBridge";

/** 只认 `page_crdt` ＋「待重建」那一条的极简库。 */
function fakeDb() {
  const rows = new Map<string, Uint8Array>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        rows.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) return;
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const s = rows.get(String((params ?? [])[0]));
        return s ? [{ state: s }] : [];
      }
      return [];
    },
  };
  return { db: db as unknown as ContentSql };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-s6b-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build(editor);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

const BASE = withIds(
  buildJson(() => {
    const p1 = $createBlockParagraphNode("blk-1");
    p1.append($createTextNode("第一段"));
    const p2 = $createBlockParagraphNode("blk-2");
    p2.append($createTextNode("第二段"));
    $getRoot().append(p1, p2);
  }),
);

/** 同血统的两条分支（各自加一块 ⇒ 合并的并集是 4 块）。 */
function twoBranches() {
  const seed = openPageSession({ json: BASE });
  const s0 = seed.exportState();
  seed.dispose();
  const a = openPageSession({ state: s0 });
  const b = openPageSession({ state: s0 });
  a.edit(() => {
    const p = $createBlockParagraphNode("blk-A");
    p.append($createTextNode("A 加的"));
    $getRoot().append(p);
  });
  b.edit(() => {
    const p = $createBlockParagraphNode("blk-B");
    p.append($createTextNode("B 加的"));
    $getRoot().append(p);
  });
  const out = { stateA: a.exportState(), stateB: b.exportState() };
  a.dispose();
  b.dispose();
  return out;
}

/** 库里那一页的块身份（走**产品自己**的读取函数，不是自己数 JSON）。 */
const idsInStore = (db: ContentSql) => topLevelBlockIds(projectStateToJson(readPageCrdtState(db, "p1")!));

describe("冲刺 S6b：块身份穿过合并（集合不变、不重复、不新铸）", () => {
  it("⑳ ★ 合并前后 `topLevelBlockIds` = 两侧**并集**、每个 id 只出现一次、**没有新面孔**", () => {
    const { db } = fakeDb();
    const { stateA, stateB } = twoBranches();

    mergeRemotePageState(db, "p1", stateA, 1);
    const afterA = idsInStore(db);
    expect(afterA).toEqual(["blk-1", "blk-2", "blk-A"]);

    mergeRemotePageState(db, "p1", stateB, 2);
    const merged = idsInStore(db);
    console.log(`【⑳ 实测】合并后块身份 = ${JSON.stringify(merged)}`);

    expect(new Set(merged).size).toBe(merged.length); // ★ 没有重复（S1 红线的症状）
    expect([...merged].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]); // 并集
    // ★ **没有任何新面孔**：合并路径**不铸身份**（口径见文件头）
    for (const id of merged) expect(["blk-1", "blk-2", "blk-A", "blk-B"]).toContain(id);
  });

  it("㉑ ★ 幂等且**不铸身份**：同一版再并一次 ⇒ 集合一字不变；换顺序 ⇒ 仍是同一个集合", () => {
    const { db } = fakeDb();
    const { stateA, stateB } = twoBranches();
    mergeRemotePageState(db, "p1", stateA, 1);
    mergeRemotePageState(db, "p1", stateB, 2);
    const once = idsInStore(db);

    mergeRemotePageState(db, "p1", stateB, 3); // 同一版再来
    mergeRemotePageState(db, "p1", stateA, 4);
    expect(idsInStore(db)).toEqual(once); // 一字不变

    // 换一个库、换顺序 ⇒ 仍是同一个集合（顺序由 CRDT 定，集合必须一致）
    const db2 = fakeDb().db;
    mergeRemotePageState(db2, "p1", stateB, 1);
    mergeRemotePageState(db2, "p1", stateA, 2);
    expect([...idsInStore(db2)].sort()).toEqual([...once].sort());
  });
});
