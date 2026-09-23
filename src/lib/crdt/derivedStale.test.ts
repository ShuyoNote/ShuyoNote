// 冲刺 S6 的判据：**合并之后派生文本有痕**（不静默落后）＋ 不制造假账。
//
// 为什么这条重要：合并产物是"拼出来"的，而正文列（FTS 的输入）还是旧的 ⇒ 不落痕就会
// "搜不到刚并进来的字"。而本仓的纪律是**不引第二份派生实现** ⇒ 这里只验两件事：
//   · 真变了 ⇒ 打「待重建」标记（补算器会拾起）；
//   · 没变 ⇒ **不**打（否则是假账：补算器白解析一遍再清掉）。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import {
  readPageCrdtState,
  refreshPageTextIfStale,
  textStale,
  type ContentSql,
} from "../docContent";
import { mergeRemotePageState } from "./pageBinding";
import { openPageSession } from "./yDocBridge";

/** 认 `page_crdt` ＋ `pages` 上那三条（正文列/待重建标记）的极简库。 */
function fakeDb() {
  const crdt = new Map<string, Uint8Array>();
  const pages = new Map<string, { text: string; stale: number }>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        crdt.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) {
        const cur = pages.get(String(params[0])) ?? { text: "", stale: 0 };
        pages.set(String(params[0]), { ...cur, stale: 1 });
        return;
      }
      if (/UPDATE pages SET text_stale = 0/.test(sql)) {
        const cur = pages.get(String(params[0])) ?? { text: "", stale: 0 };
        pages.set(String(params[0]), { ...cur, stale: 0 });
        return;
      }
      if (/UPDATE pages SET content_text = \?/.test(sql)) {
        const [text, id] = params as [string, string];
        const cur = pages.get(id) ?? { text: "", stale: 0 };
        pages.set(id, { ...cur, text });
        return;
      }
      if (/UPDATE pages SET title = \?/.test(sql)) return; // writeContent 那条（本判据不关心）
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/COALESCE\(text_stale, 0\)/.test(sql)) {
        const r = pages.get(String((params ?? [])[0]));
        return r ? [{ text_stale: r.stale }] : [];
      }
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const s = crdt.get(String((params ?? [])[0]));
        return s ? [{ state: s }] : [];
      }
      if (/SELECT title, content_json, content_text FROM pages WHERE id = \?/.test(sql)) {
        const r = pages.get(String((params ?? [])[0]));
        return r ? [{ title: "页", content_json: "{}", content_text: r.text }] : [];
      }
      return [];
    },
  };
  const ensurePage = (id: string, text = "旧正文") => {
    if (!pages.has(id)) pages.set(id, { text, stale: 0 });
  };
  return { db: db as unknown as ContentSql, pages, ensurePage, crdt };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-s6-fixture" });
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

/** 同血统的两条分支：A 加一块、B 加另一块。 */
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

describe("冲刺 S6：合并之后的派生文本要**有痕**（不静默落后）", () => {
  it("⑱ ★ 并进**真有新内容**的一版 ⇒ `text_stale` 打上；补算器收口后清掉", () => {
    const { db, ensurePage } = fakeDb();
    ensurePage("p1");
    const { stateA, stateB } = twoBranches();

    mergeRemotePageState(db, "p1", stateA, 1); // 采用
    expect(textStale(db, "p1")).toBe(true);

    const second = mergeRemotePageState(db, "p1", stateB, 2); // 真并进了新内容
    expect(second.derivedStale).toBe(true);
    expect(textStale(db, "p1")).toBe(true);

    // 补算器（编辑器侧按编辑器语义算一遍的那条路）收口 ⇒ 正文列跟上、标记清掉
    const repaired = refreshPageTextIfStale(db, "p1", "第一段\nA 加的\nB 加的");
    expect(repaired).toBe(true);
    expect(textStale(db, "p1")).toBe(false);
  });

  it("⑲ ★ 重复并**同一版**（没有新内容）⇒ **不**打标记（避免假账）", () => {
    const { db, ensurePage } = fakeDb();
    ensurePage("p1");
    const { stateA } = twoBranches();

    mergeRemotePageState(db, "p1", stateA, 1);
    refreshPageTextIfStale(db, "p1", "第一段\nA 加的"); // 先把账做平
    expect(textStale(db, "p1")).toBe(false);

    const again = mergeRemotePageState(db, "p1", stateA, 2); // 同一版再来一次
    expect(again.adopted).toBe(false);
    expect(again.derivedStale).toBe(false);
    expect(textStale(db, "p1")).toBe(false); // ★ 没有假账
    // 状态本身还在（合并是幂等的，不是"丢弃"）
    expect(readPageCrdtState(db, "p1")).not.toBeNull();
  });
});
