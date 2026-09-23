// 冲刺切片 **S3b-2b** 的判据：一页 ↔ **真编辑器** 的绑定（含"重开页面仍是同一条血统"）。
//
// 这一条把前面几片串起来：真编辑器（`createEditor` ＋ `setEditorState`，与 `LexicalComposer` 同款做法）
// ＋ 首开只建一次血统（S3b-2a）＋ 活会话（S3a/S3b-1）＋ 状态落盘（S2b）。
// 少了任何一片，这里就红。
import { describe, expect, it } from "vitest";
import {
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, toModelDoc } from "../blockIdentity";
import { readPageCrdtState, type ContentSql } from "../docContent";
import { bindPageToEditor, bindPageToEditorViaPort, loadJsonForEditor } from "./pageBinding";
import { openPageSession, projectStateToJson } from "./yDocBridge";

/** 只认 `page_crdt` 三条 SQL 的极简库（不认识的形状当场抛）。 */
function fakeDb() {
  const rows = new Map<string, Uint8Array>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/INSERT INTO page_crdt/.test(sql)) {
        rows.set(String(params[0]), params[1] as Uint8Array);
        return;
      }
      if (/DELETE FROM page_crdt/.test(sql)) {
        rows.delete(String(params[0]));
        return;
      }
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
  return { db: db as unknown as ContentSql, rows };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-binding-fixture" });
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

const idsOf = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<{ blockId?: string }> } }).root.children.map(
    (c) => c.blockId ?? "-",
  );

const BASE = withIds(
  buildJson(() => {
    const p1 = $createBlockParagraphNode("blk-1");
    p1.append($createTextNode("第一段"));
    const p2 = $createBlockParagraphNode("blk-2");
    p2.append($createTextNode("第二段"));
    $getRoot().append(p1, p2);
  }),
);

/**
 * 造一个"真编辑器"：与 `LexicalComposer` ＋ `editor/Editor.tsx` 的载入路径同款 ——
 * 落盘 JSON **先过 `toModelDoc`**（把老形态升成模型形态；缺身份才铸），再 `parseEditorState`。
 *
 * ⚠️ 第一版这里**漏了** `toModelDoc` ⇒ 编辑器里是内置 `paragraph`（不带 `blockId`）⇒ 序列化出去缺身份
 * ⇒ 判据当场红。这一步不是可选的：**落盘形态与编辑器形态不是同一个形态**。
 */
function appEditor(json: string): LexicalEditor {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "app-like-editor" });
  const modeled = toModelDoc(json, () => {
    throw new Error("fixture 不该铸身份（样本里每个顶层块都已有 blockId）");
  });
  editor.setEditorState(editor.parseEditorState(modeled));
  return editor;
}

/** 编辑器当前内容的**落盘形态** JSON（生产是保存路径那个 serializer 的产物）。 */
const serialize = (editor: LexicalEditor) => toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()));

function typeBlock(editor: LexicalEditor, blockId: string, text: string): void {
  editor.update(
    () => {
      const p = $createBlockParagraphNode(blockId);
      p.append($createTextNode(text));
      $getRoot().append(p);
    },
    { discrete: true },
  );
}

describe("冲刺 S3b-2b：一页 ↔ 真编辑器的绑定", () => {
  it("⑪ 首次绑定：`seeded=true` ⇒ 库里有了状态，且编辑器与会话是同一条血统", () => {
    const { db, rows } = fakeDb();
    const editor = appEditor(BASE);
    const binding = bindPageToEditor({ db, pageId: "p1", editor, seedJson: serialize(editor), now: 1 });

    expect(binding.seeded).toBe(true);
    expect(rows.size).toBe(1); // 状态已落盘
    expect(idsOf(binding.session.exportJson())).toEqual(idsOf(BASE));
    expect(idsOf(serialize(editor))).toEqual(idsOf(BASE));
    binding.dispose();
  });

  it("⑫ ★★ 承重：真编辑器打字 → 存回 → **重开页面** ⇒ 还是同一条血统，两端各改一处**两处都在**", () => {
    const { db } = fakeDb();

    // —— 第一次打开这一页（库里还没有状态）——
    const e1 = appEditor(loadJsonForEditor(db, "p1", BASE));
    const b1 = bindPageToEditor({ db, pageId: "p1", editor: e1, seedJson: serialize(e1), now: 1 });
    expect(b1.seeded).toBe(true);

    typeBlock(e1, "blk-live", "真编辑器打的字"); // 用户直接在那个编辑器里打字
    const stateAfterTyping = b1.session.exportState();
    b1.persist(2);
    b1.dispose();

    // —— 重开这一页：给编辑器的内容必须来自**状态的投影**（不是落后的落盘那份）——
    const loaded = loadJsonForEditor(db, "p1", BASE);
    expect(idsOf(loaded)).toEqual(["blk-1", "blk-2", "blk-live"]);
    expect(loaded).toContain("真编辑器打的字");

    const e2 = appEditor(loaded);
    const b2 = bindPageToEditor({ db, pageId: "p1", editor: e2, seedJson: serialize(e2), now: 3 });
    expect(b2.seeded).toBe(false); // ★ 不再建第二条血统

    // 重开之后继续打字 ⇒ 与"第一次打开时那一笔"合起来两处都在、不翻倍
    typeBlock(e2, "blk-reopened", "重开之后打的字");
    b2.session.merge(stateAfterTyping);

    const ids = idsOf(b2.session.exportJson());
    console.log(`【⑫ 实测】重开后合并 = ${JSON.stringify(ids)}`);
    expect(new Set(ids).size).toBe(ids.length); // 没有重复块（两套身份的症状）
    expect([...ids].sort()).toEqual(["blk-1", "blk-2", "blk-live", "blk-reopened"]);
    expect(b2.session.exportJson()).toContain("真编辑器打的字");
    expect(b2.session.exportJson()).toContain("重开之后打的字");

    // 存回之后，从库里的状态再开一个会话 ⇒ 与重开那一次完全一致（收敛、可继续用）
    b2.persist(4);
    b2.dispose();
    const fromStore = openPageSession({ state: readPageCrdtState(db, "p1")! });
    expect(idsOf(fromStore.exportJson())).toEqual(ids);
  });

  it("⑬ `loadJsonForEditor`：没有状态 ⇒ **原样返回**（未建血统的页面零感知）；有状态 ⇒ 用状态的投影", () => {
    const { db } = fakeDb();
    expect(loadJsonForEditor(db, "p1", BASE)).toBe(BASE); // 逐字节相同

    const editor = appEditor(BASE);
    const b = bindPageToEditor({ db, pageId: "p1", editor, seedJson: serialize(editor), now: 1 });
    typeBlock(editor, "blk-x", "加了");
    b.persist(2);
    b.dispose();

    const projected = loadJsonForEditor(db, "p1", BASE);
    expect(projected).not.toBe(BASE);
    expect(idsOf(projected)).toEqual(["blk-1", "blk-2", "blk-x"]);
  });

  it("⑭ 端口版（界面侧走 `api` 的那条路）：首开建一次并落盘；第二次**只载入**、不再建血统", async () => {
    const store = new Map<string, Uint8Array>();
    const port = {
      read: async (id: string) => store.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store.set(id, state);
        return null;
      },
    };

    const e1 = appEditor(BASE);
    const b1 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e1, seedJson: serialize(e1) });
    expect(b1.seeded).toBe(true);
    expect(store.has("p1")).toBe(true); // 首开那次已经落盘

    typeBlock(e1, "blk-port", "端口版写的");
    await b1.persist();
    b1.dispose();

    // 换一个编辑器（＝重开页面）：这一次必须**只载入**（给编辑器的内容用状态的投影）
    const seedForSecond = projectStateToJson(store.get("p1")!);
    const e2 = appEditor(seedForSecond);
    const b2 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e2, seedJson: serialize(e2) });
    expect(b2.seeded).toBe(false);
    expect(idsOf(b2.session.exportJson())).toEqual(["blk-1", "blk-2", "blk-port"]);

    // ⚠️ 顺序有讲究：**先在还挂着的会话里改**，再取状态、最后 dispose
    //    （dispose 之后监听已撤，编辑不再进 doc —— 第一版就是把这两步写反了，判据当场红）
    typeBlock(e2, "blk-port2", "端口版再写");
    const stateB2 = b2.session.exportState();
    b2.dispose();

    // 两个绑定是**同一条血统**：与 b1 那一支的状态合并 ⇒ 两处都在
    const e1Again = appEditor(seedForSecond);
    const b3 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e1Again, seedJson: serialize(e1Again) });
    b3.session.merge(stateB2);
    const ids = idsOf(b3.session.exportJson());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["blk-1", "blk-2", "blk-port", "blk-port2"]);
    b3.dispose();
  });
});
