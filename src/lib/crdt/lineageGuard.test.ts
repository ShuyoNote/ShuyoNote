// 冲刺 **血统护栏**（2026-09-23，读完那篇 Lexical+Yjs 生产实践要点后加的）的判据。
//
// 那篇第 2 条说："**切勿在客户端初始化文档内容**，两个客户端同时写初始内容会导致文档损坏"。
// 我们这一路已经把它量化过：S1 实测"从 JSON 各自新建的两份状态合起来 ⇒ 一块变两块且 `blockId` 重复"。
// 生产路径上的窗口是真实的（两台设备**同时**首开同一张从没建过血统的页、且各自离线）。
//
// S3b-2a 的 `ensurePageCrdtState`（首开只建一次）挡住的是"**将来**别建两次"；
// 这一片挡的是"**已经**出现了两条血统"—— 在**合并**那一处验血统，不相关就**拒绝合并并报出来**：
// 宁可不合，也不合出"一块变两块"（本仓纪律：不静默）。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, topLevelBlockIds } from "../blockIdentity";
import { readPageCrdtState, type ContentSql } from "../docContent";
import { lineageClientIds, lineagesRelated, mergeRemotePageState } from "./pageBinding";
import { openPageSession, projectStateToJson } from "./yDocBridge";

function fakeDb() {
  const rows = new Map<string, Uint8Array>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        rows.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) return;
      // S6 尾巴起：合并会把**投影写回**那一列（本判据不关心值，只要求形状被认）。
      if (/UPDATE pages SET content_json = \?/.test(sql)) return;
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
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-lineage-fixture" });
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
    const p = $createBlockParagraphNode("blk-1");
    p.append($createTextNode("第一段"));
    $getRoot().append(p);
  }),
);

const idsInStore = (db: ContentSql) => topLevelBlockIds(projectStateToJson(readPageCrdtState(db, "p1")!));

describe("冲刺 · 血统护栏：两条独立血统**不许合**（宁可不合，也不合出'一块变两块'）", () => {
  it("① 同一条血统（都从同一份 seed 出发）⇒ 正常合并，护栏**不**误报", () => {
    const { db } = fakeDb();
    const seed = openPageSession({ json: BASE });
    const s0 = seed.exportState();
    seed.dispose();

    mergeRemotePageState(db, "p1", s0, 1); // 采用 seed
    const a = openPageSession({ state: s0 });
    a.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("A"));
      $getRoot().append(p);
    });
    const stateA = a.exportState();
    a.dispose();

    const res = mergeRemotePageState(db, "p1", stateA, 2);
    expect(res.lineageConflict).toBeUndefined(); // ★ 同血统 ⇒ 不拦
    expect([...idsInStore(db)].sort()).toEqual(["blk-1", "blk-A"]);
  });

  it("② ★ 两条**独立创建**的血统 ⇒ **拒绝合并**：有痕、本机那一版原样保留、**内容没翻倍**", () => {
    const { db } = fakeDb();
    // 两台设备各自把**同一份 JSON** 变成状态 ⇒ 两条互不相交的血统（S1 红线的成因）
    const devA = openPageSession({ json: BASE });
    const devB = openPageSession({ json: BASE });
    const stateA = devA.exportState();
    const stateB = devB.exportState();
    devA.dispose();
    devB.dispose();

    expect(lineagesRelated(lineageClientIds(stateA), lineageClientIds(stateB))).toBe(false);

    mergeRemotePageState(db, "p1", stateA, 1); // 本机采用 A
    const before = idsInStore(db);
    const res = mergeRemotePageState(db, "p1", stateB, 2); // 再来一条**独立**血统

    expect(res.lineageConflict).toBeDefined(); // ★ 有痕（调用方必须报出去）
    expect(res.lineageConflict!.mine.length).toBeGreaterThan(0);
    expect(res.lineageConflict!.remote.length).toBeGreaterThan(0);
    expect(res.adopted).toBe(false);
    expect(res.derivedStale).toBe(false); // 没合 ⇒ 派生文本也没被影响

    const after = idsInStore(db);
    console.log(`【② 实测】拒绝合并后本机块身份 = ${JSON.stringify(after)}`);
    expect(after).toEqual(before); // ★ 本机那一版原样保留
    expect(new Set(after).size).toBe(after.length); // ★ 没有重复块（没有被合出损坏）
  });

  it("③ 空状态/没有指纹 ⇒ **不**误判（视为相关：没什么可冲突的）", () => {
    expect(lineageClientIds(new Uint8Array([0, 0])).size).toBe(0);
    expect(lineagesRelated(new Set(), new Set([1]))).toBe(true);
    expect(lineagesRelated(new Set([1]), new Set())).toBe(true);

    const { db } = fakeDb();
    mergeRemotePageState(db, "p1", openPageSession({ json: BASE }).exportState(), 1);
    const before = idsInStore(db);
    // 载荷里那份**没有指纹**（`[0,0]` ＝ 空 update）⇒ 视为相关、**不拦**；内容不变（等于合了个空）。
    // ⚠️ 这里**不能**拿"另开一个会话生成的状态"来测"不误判" —— 那正是**两条独立血统**，
    //    护栏拦它是对的（本判据第一版就是在这儿写错了预期，实测当场红）。
    const res = mergeRemotePageState(db, "p1", new Uint8Array([0, 0]), 2);
    expect(res.lineageConflict).toBeUndefined();
    expect(idsInStore(db)).toEqual(before);
  });
});
