// 冲刺 **S6 尾巴**的判据：合并/采用之后，**投影写回落盘那一列**（这样反链/插件/AI/导出不必等
// 编辑器打开那一页才看到新内容）。
//
// 为什么这条值得单独钉：合并把内容改对了，但落盘那份（其他读侧读的**投影**）可能还是旧的 ⇒
// 表现就是"页面上看得到、但别处（反链/搜索/导出）看不到"。正文文本那一半有「待重建」标记 ＋ 补算器
// （S6a）；这一半由**状态重新序列化**写回，且**只动那一列、不动 `dirty`**（它不是用户编辑）。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, topLevelBlockIds } from "../blockIdentity";
import { readContent, readPageCrdtState, type ContentSql } from "../docContent";
import { mergeRemotePageState } from "./pageBinding";
import { openPageSession, projectStateToJson } from "./yDocBridge";

/** 认 `page_crdt` ＋ `pages` 上那三条；**额外记住 `dirty`**，用来断言"没被标脏"。 */
function fakeDb() {
  const crdt = new Map<string, Uint8Array>();
  const pages = new Map<string, { json: string; text: string; stale: number; dirty: number }>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        crdt.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/UPDATE pages SET content_json = \?/.test(sql)) {
        const [json, id] = params as [string, string];
        const cur = pages.get(id) ?? { json: "{}", text: "", stale: 0, dirty: 0 };
        pages.set(id, { ...cur, json });
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) {
        const cur = pages.get(String(params[0])) ?? { json: "{}", text: "", stale: 0, dirty: 0 };
        pages.set(String(params[0]), { ...cur, stale: 1 });
        return;
      }
      if (/UPDATE pages SET content_text = \?/.test(sql)) {
        const [text, id] = params as [string, string];
        const cur = pages.get(id) ?? { json: "{}", text: "", stale: 0, dirty: 0 };
        pages.set(id, { ...cur, text });
        return;
      }
      // ⚠️ **故意不认** `dirty = 1`：这条路径一旦标脏（＝把投影当成用户编辑），当场红。
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 56)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const s = crdt.get(String((params ?? [])[0]));
        return s ? [{ state: s }] : [];
      }
      if (/SELECT title, content_json, content_text FROM pages WHERE id = \?/.test(sql)) {
        const r = pages.get(String((params ?? [])[0]));
        return r ? [{ title: "页", content_json: r.json, content_text: r.text }] : [];
      }
      return [];
    },
  };
  const ensure = (id: string, json = "{}") => {
    if (!pages.has(id)) pages.set(id, { json, text: "旧正文", stale: 0, dirty: 0 });
  };
  return { db: db as unknown as ContentSql, pages, ensure };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-s6tail-fixture" });
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

describe("冲刺 S6 尾巴：合并之后**投影写回**落盘那一列", () => {
  it("㉒ ★ 采用别人的一版 ⇒ 落盘那份**立刻**就是新内容（不必等编辑器打开）", () => {
    const { db, ensure, pages } = fakeDb();
    ensure("p1", "{}"); // 库里原先那份是空的
    const remote = openPageSession({ json: BASE }).exportState();

    mergeRemotePageState(db, "p1", remote, 1);

    // 落盘那份 = 状态的投影（含块身份）⇒ 反链/插件/导出读到的就是新内容
    const stored = readContent(db, "p1")!.json;
    expect(stored).toBe(projectStateToJson(remote));
    expect(topLevelBlockIds(stored)).toEqual(["blk-1"]);
    expect(pages.get("p1")!.dirty).toBe(0); // ★ 没被标脏（它不是用户编辑）
  });

  it("㉓ ★ 合并出新内容 ⇒ 写回；**没变**（重复并同一版）⇒ 一次写库都不做（不造假账）", () => {
    const { db, ensure, pages } = fakeDb();
    ensure("p1", "{}");
    const seed = openPageSession({ json: BASE });
    const s0 = seed.exportState();
    seed.dispose();
    const a = openPageSession({ state: s0 });
    a.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("A 加的"));
      $getRoot().append(p);
    });
    const stateA = a.exportState();
    a.dispose();

    mergeRemotePageState(db, "p1", s0, 1); // 先采用 seed
    const afterSeed = readContent(db, "p1")!.json;

    const res = mergeRemotePageState(db, "p1", stateA, 2); // 真并进新内容
    expect(res.derivedStale).toBe(true);
    const afterMerge = readContent(db, "p1")!.json;
    expect(afterMerge).not.toBe(afterSeed);
    expect(topLevelBlockIds(afterMerge)).toEqual(["blk-1", "blk-A"]);

    // 同一版再来一次 ⇒ 内容没变 ⇒ **不**写库（把那一列换成一个哨兵值，验它没被覆盖）
    pages.set("p1", { ...pages.get("p1")!, json: "SENTINEL" });
    const again = mergeRemotePageState(db, "p1", stateA, 3);
    expect(again.derivedStale).toBe(false);
    expect(readContent(db, "p1")!.json).toBe("SENTINEL"); // ★ 没被动过
    expect(readPageCrdtState(db, "p1")).not.toBeNull(); // 状态本身仍在
  });
});
