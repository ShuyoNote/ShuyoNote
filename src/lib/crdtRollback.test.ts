// ⭐ P3-3a 第二小步（task-52）：**CRDT 回滚演练**（真 yjs）——"清状态 → 重开 → 恢复"。
//
// 这不是 UI 判据：它证明"把某页的 CRDT 状态清掉之后，页面仍能从**落盘正文**打开（不丢内容），
// 重建状态后投影又与原文一致" —— 这就是紧急回滚（删 `page_crdt` 那一行）的安全边界。
import { describe, expect, it } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../editor/config";
import { toLegacyDoc } from "../lib/blockIdentity";
import { clearPageCrdtState, readPageCrdtState, writePageCrdtState, type ContentSql } from "../lib/docContent";
import { contentJsonToYDoc } from "../lib/crdt/yDocBridge";
import { loadJsonForEditor } from "../lib/crdt/pageBinding";
import { shadowCompareProjection } from "./crdtShadow";

function fixtureJson(): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-rollback-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      const p1 = $createParagraphNode();
      p1.append($createTextNode("回滚演练第一段"));
      const p2 = $createParagraphNode();
      p2.append($createTextNode("回滚演练第二段"));
      $getRoot().append(p1, p2);
    },
    { discrete: true },
  );
  const legacy = JSON.parse(toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()))) as {
    root: { children: Array<Record<string, unknown>> };
  };
  legacy.root.children = legacy.root.children.map((c, i) => ({ ...c, blockId: `rb-${i + 1}` }));
  return JSON.stringify(legacy);
}

/** 只认 `page_crdt` 三条 SQL 的极简库（形状抄 pageStateStore 判据）。 */
function fakeDb() {
  const rows = new Map<string, Uint8Array>();
  const db: ContentSql = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql) || /UPDATE page_crdt/.test(sql)) {
        rows.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/DELETE FROM page_crdt/.test(sql)) {
        rows.delete(String(params[0]));
        return;
      }
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query<T>(sql: string, params?: readonly unknown[]): T[] {
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const s = rows.get(String((params ?? [])[0]));
        return (s ? [{ state: s }] : []) as T[];
      }
      throw new Error(`fakeDb 不认这条 query：${sql.slice(0, 48)}`);
    },
  };
  return { db, rows };
}

describe("CRDT 回滚演练（清状态 → 重开 → 恢复）", () => {
  it("清掉 page_crdt 后从落盘正文打开；重建状态后投影与原文一致", () => {
    const json = fixtureJson();
    const { db, rows } = fakeDb();
    const state = contentJsonToYDoc(json).update;

    // ① 正常：有状态 ⇒ 打开时用状态投影（内容与原文一致）。
    writePageCrdtState(db, "p1", state, 1);
    expect(shadowCompareProjection(json, state).equal).toBe(true);
    const opened = loadJsonForEditor(db, "p1", json);
    expect(opened).toContain("回滚演练第一段");
    expect(opened).toContain("回滚演练第二段");

    // ② 回滚：清掉状态 ⇒ 读不到状态，打开时**回落到落盘 JSON**（⛔ 不丢内容、不炸）。
    clearPageCrdtState(db, "p1");
    expect(readPageCrdtState(db, "p1")).toBeNull();
    const fallback = loadJsonForEditor(db, "p1", json);
    expect(fallback).toBe(json);
    expect(fallback).toContain("回滚演练第一段");

    // ③ 恢复：按落盘正文重建状态（与首开同一条路）⇒ 状态回、投影与原文一致。
    const rebuilt = contentJsonToYDoc(json).update;
    writePageCrdtState(db, "p1", rebuilt, 2);
    expect(rows.has("p1")).toBe(true);
    expect(shadowCompareProjection(json, rebuilt).equal).toBe(true);
    const reopened = loadJsonForEditor(db, "p1", json);
    expect(reopened).toContain("回滚演练第二段");
    expect(shadowCompareProjection(json, readPageCrdtState(db, "p1")!).equal).toBe(true);
  });

  it("清状态可重复调用（再清一次不炸）", () => {
    const { db } = fakeDb();
    clearPageCrdtState(db, "p1");
    clearPageCrdtState(db, "p1");
    expect(readPageCrdtState(db, "p1")).toBeNull();
  });
});
