// 冲刺切片 **S3b-2b** 的判据：一页 ↔ **真编辑器** 的绑定（含"重开页面仍是同一条血统"）。
//
// 这一条把前面几片串起来：真编辑器（`createEditor` ＋ `setEditorState`，与 `LexicalComposer` 同款做法）
// ＋ 首开只建一次血统（S3b-2a）＋ 活会话（S3a/S3b-1）＋ 状态落盘（S2b）。
// 少了任何一片，这里就红。
import { describe, expect, it, vi } from "vitest";
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
import { bindPageToEditor, bindPageToEditorViaPort, loadJsonForEditor, mergeRemotePageState } from "./pageBinding";
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
      // S6 起：合并（`mergeRemotePageState`）会给这一页打「待重建」标记 ⇒ 这个形状要认。
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

  // ---------------------------------------------------------------------------------------
  // S4a：远端来的状态并进本机（"真正的合并同步"在客户端这一侧）
  // ---------------------------------------------------------------------------------------

  it("⑮⑯⑰ 远端状态并进本机：本机没有 ⇒ **采用**；两端各改一处 ⇒ 都在且不重复；**次序无关**", () => {
    const { db } = fakeDb();

    // 造两条**同血统**的编辑（模拟两台设备：都从同一条血统出发，各改一处）
    const base = openPageSession({ json: BASE });
    const s0 = base.exportState();
    base.dispose();
    const devA = openPageSession({ state: s0 });
    const devB = openPageSession({ state: s0 });
    devA.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("A 那边加的"));
      $getRoot().append(p);
    });
    devB.edit(() => {
      const p = $createBlockParagraphNode("blk-B");
      p.append($createTextNode("B 那边加的"));
      $getRoot().append(p);
    });
    const stateA = devA.exportState();
    const stateB = devB.exportState();
    devA.dispose();
    devB.dispose();

    // ⑮ 本机还没有这一页的状态 ⇒ **采用**远端那一版（不是从 JSON 重建）
    const first = mergeRemotePageState(db, "p1", stateA, 1);
    expect(first.adopted).toBe(true);
    const afterA = idsOf(projectStateToJson(readPageCrdtState(db, "p1")!));
    expect([...afterA].sort()).toEqual(["blk-1", "blk-2", "blk-A"]);

    // ⑯ 再并 B 那一版 ⇒ **两处都在、不重复**；重复并同一版 ⇒ 幂等
    const second = mergeRemotePageState(db, "p1", stateB, 2);
    expect(second.adopted).toBe(false);
    const ids = idsOf(projectStateToJson(readPageCrdtState(db, "p1")!));
    console.log(`【⑯ 实测】两版并进本机 = ${JSON.stringify(ids)}`);
    expect(new Set(ids).size).toBe(ids.length); // 没有重复块（＝没有各起一条血统）
    expect([...ids].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]);
    mergeRemotePageState(db, "p1", stateB, 3);
    expect(idsOf(projectStateToJson(readPageCrdtState(db, "p1")!))).toEqual(ids);

    // ⑰ **次序无关**：换一个库，先 B 后 A ⇒ 最终投影与上面**完全一致**（含顺序）
    const db2 = fakeDb().db;
    mergeRemotePageState(db2, "p1", stateB, 1);
    mergeRemotePageState(db2, "p1", stateA, 2);
    expect(idsOf(projectStateToJson(readPageCrdtState(db2, "p1")!))).toEqual(ids);
  });

  // ---------------------------------------------------------------------------------------
  // §11.4 收口（第 42 轮）：桌面 pull 收下的**待并远端状态** —— 打开页面时合并
  // ---------------------------------------------------------------------------------------

  /** 造一台"对端设备"的状态：从 `base` 那条血统出发，加一块。 */
  function peerStateFrom(base: Uint8Array | { json: string }, blockId: string, text: string): Uint8Array {
    const s = "json" in base ? openPageSession({ json: base.json }) : openPageSession({ state: base });
    s.edit(() => {
      const p = $createBlockParagraphNode(blockId);
      p.append($createTextNode(text));
      $getRoot().append(p);
    });
    const out = s.exportState();
    s.dispose();
    return out;
  }

  it("⑱ ★ 本机**没有**状态但收下了对端的（待并）⇒ 打开页面就**承接**那条血统：不 claim、不新建", async () => {
    const peerState = peerStateFrom({ json: BASE }, "blk-peer", "对端加的");

    const store = new Map<string, Uint8Array>();
    let pending: Array<{ seq: number; state: Uint8Array }> = [{ seq: 7, state: peerState }];
    let claimCalls = 0;
    const port = {
      read: async (id: string) => store.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store.set(id, state);
        return null;
      },
      readPending: async () => pending,
      clearPending: async () => {
        const n = pending.length;
        pending = [];
        return n;
      },
    };
    const claim = {
      claim: async () => {
        claimCalls += 1;
        return true;
      },
    };

    const e = appEditor(BASE);
    const b = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e, seedJson: serialize(e), claim, deviceId: "dev" });

    console.log(`【⑱ 实测】承接后 = ${JSON.stringify(idsOf(b.session.exportJson()))}`);
    expect(b.seeded).toBe(false); // 血统**不是**本机建的
    expect(b.adopted).toBe(true); // 是**承接**对端那条
    expect(claimCalls).toBe(0); // ★ 根本没问服务端（血统已经由对端建了）
    expect(store.has("p1")).toBe(true); // 承接的那条立刻落盘（下次打开就是"载入既有血统"）
    expect(pending).toEqual([]); // 合并过就清（不清就是每次打开都再并一遍）
    expect(idsOf(b.session.exportJson())).toEqual(["blk-1", "blk-2", "blk-peer"]);
    expect(idsOf(serialize(e))).toEqual(["blk-1", "blk-2", "blk-peer"]); // hydration 落进了编辑器
    b.dispose();
  });

  it("⑲ ★ 本机有状态 ＋ 待并 ⇒ 合并（两处都在）并清空；**两条独立血统** ⇒ 拒绝合并（留痕、本机保留）", async () => {
    const store = new Map<string, Uint8Array>();
    let pending: Array<{ seq: number; state: Uint8Array }> = [];
    const port = {
      read: async (id: string) => store.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store.set(id, state);
        return null;
      },
      readPending: async () => pending,
      clearPending: async () => {
        const n = pending.length;
        pending = [];
        return n;
      },
    };

    // 本机首开建血统，并打一块
    const e0 = appEditor(BASE);
    const b0 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e0, seedJson: serialize(e0) });
    expect(b0.seeded).toBe(true);
    typeBlock(e0, "blk-mine", "本机打的");
    await b0.persist();
    const mineState = store.get("p1")!;
    b0.dispose();

    // ① 同血统的对端状态 ⇒ 合并：两处都在、不重复，pending 清空
    pending = [{ seq: 8, state: peerStateFrom(mineState, "blk-peer", "对端加的") }];
    const e1 = appEditor(projectStateToJson(mineState));
    const b1 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e1, seedJson: serialize(e1) });
    const mergedIds = idsOf(b1.session.exportJson());
    console.log(`【⑲ 实测】合并后 = ${JSON.stringify(mergedIds)}`);
    expect(b1.adopted).toBe(false); // 本机本来就有状态
    expect(b1.pendingSkipped).toBe(0);
    expect(new Set(mergedIds).size).toBe(mergedIds.length); // 没有重复块
    expect([...mergedIds].sort()).toEqual(["blk-1", "blk-2", "blk-mine", "blk-peer"]);
    expect(pending).toEqual([]);
    expect(idsOf(projectStateToJson(store.get("p1")!))).toEqual(mergedIds); // 合并结果已落盘
    b1.dispose();

    // ② **独立血统**（对端从 JSON 新建 ⇒ 另一套身份）⇒ 拒绝合并、留痕、本机保留
    const independent = peerStateFrom({ json: BASE }, "blk-other", "另一套身份");
    pending = [{ seq: 9, state: independent }];
    const before = idsOf(projectStateToJson(store.get("p1")!));
    const e2 = appEditor(projectStateToJson(store.get("p1")!));
    const b2 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e2, seedJson: serialize(e2) });
    const after = idsOf(b2.session.exportJson());
    console.log(`【⑲② 实测】独立血统被拒后 = ${JSON.stringify(after)}`);
    expect(b2.pendingSkipped).toBe(1); // ★ 有痕（调用方能如实报出来）
    expect(after).toEqual(before); // 本机版本原样保留（没有被并进来）
    expect(after).not.toContain("blk-other");
    expect(pending).toEqual([]); // 拒了也要清（否则每次打开都重试同一批）
    b2.dispose();
  });

  // ---------------------------------------------------------------------------------------
  // ★ 冲刺 §13.3 第 1 条（2026-09-23 第 49 轮）：**投影也要跟上**
  //
  // 原先这条路只写状态 ⇒ `pages` 那一列（反链/插件/AI/导出读的投影）要等**下一次保存**才跟上
  // （"搜不到刚同步过来的字"）。下面钉的就是"什么时候必须调 `writeProjection`"，
  // **以及什么时候一个字都不许写**（没变 / 没有待并状态）。
  // ⚠️ 端口**不实现** `writeProjection` 时行为必须与接线前逐字相同（老调用方零感知）——
  //    上面 ⑭/⑲ 两条用例用的就是不实现它的端口，它们照样绿**就是**这条零回归判据。
  // ---------------------------------------------------------------------------------------

  it("⑳ ★ 有待并状态时投影写回：合并⇒按合并结果写；被拒⇒不写；承接⇒必写；无待并⇒不调用", async () => {
    const store = new Map<string, Uint8Array>();
    let pending: Array<{ seq: number; state: Uint8Array }> = [];
    const writes: Array<{ id: string; json: string }> = [];
    const port = {
      read: async (id: string) => store.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store.set(id, state);
        return null;
      },
      readPending: async () => pending,
      clearPending: async () => {
        const n = pending.length;
        pending = [];
        return n;
      },
      writeProjection: async (id: string, json: string) => {
        writes.push({ id, json });
        return true;
      },
    };

    // ① 本机有状态 ＋ **同血统**待并 ⇒ 合并 ⇒ 按**合并结果**写
    const e0 = appEditor(BASE);
    const b0 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e0, seedJson: serialize(e0) });
    typeBlock(e0, "blk-mine", "本机打的");
    await b0.persist();
    const mineState = store.get("p1")!;
    b0.dispose();

    pending = [{ seq: 8, state: peerStateFrom(mineState, "blk-peer", "对端加的") }];
    const e1 = appEditor(projectStateToJson(mineState));
    const b1 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e1, seedJson: serialize(e1) });
    expect(writes.length, "合并改变了内容 ⇒ 必须写一次投影").toBe(1);
    expect(writes[0].id).toBe("p1");
    expect(idsOf(writes[0].json), "写的必须是**合并后**那一版（不是旧的、也不是只有对端的）").toEqual(
      idsOf(b1.session.exportJson()),
    );
    expect(idsOf(writes[0].json)).toContain("blk-mine");
    expect(idsOf(writes[0].json)).toContain("blk-peer");
    b1.dispose();

    // ② **独立血统**（被拒 ⇒ 内容没变）⇒ 一次都不许写
    writes.length = 0;
    const before = store.get("p1")!;
    pending = [{ seq: 9, state: peerStateFrom({ json: BASE }, "blk-other", "另一套身份") }];
    const e2 = appEditor(projectStateToJson(before));
    const b2 = await bindPageToEditorViaPort({ port, pageId: "p1", editor: e2, seedJson: serialize(e2) });
    expect(b2.pendingSkipped).toBe(1);
    expect(writes.length, "没有并进来任何东西 ⇒ 一次写库都不该发生").toBe(0);
    b2.dispose();

    // ③ 本机**没有**状态 ＋ 有待并 ⇒ **承接**（整页内容都来自对端）⇒ 必须写
    writes.length = 0;
    pending = [{ seq: 10, state: peerStateFrom({ json: BASE }, "blk-adopt", "对端建的") }];
    const e3 = appEditor(BASE);
    const b3 = await bindPageToEditorViaPort({ port, pageId: "p2", editor: e3, seedJson: serialize(e3) });
    expect(b3.adopted).toBe(true);
    expect(writes.length, "承接 ⇒ 这一页的内容整个来自对端，投影必须写").toBe(1);
    expect(idsOf(writes[0].json)).toContain("blk-adopt");
    b3.dispose();

    // ④ **没有待并状态**（今天最常见的那条路）⇒ 连调用都不该有
    writes.length = 0;
    pending = [];
    const e4 = appEditor(BASE);
    const b4 = await bindPageToEditorViaPort({ port, pageId: "p3", editor: e4, seedJson: serialize(e4) });
    expect(writes.length, "没有待并 ⇒ 一个字都不多算、一次都不调").toBe(0);
    b4.dispose();
  });

  it("⑳② 端口**不实现** writeProjection ⇒ 行为与接线前逐字相同（零回归）；实现里抛错 ⇒ 有痕但不拖垮开页", async () => {
    // ① 不实现：有待并状态、真合并 ⇒ 绑定照样成功
    const store = new Map<string, Uint8Array>();
    let pending: Array<{ seq: number; state: Uint8Array }> = [];
    const bare = {
      read: async (id: string) => store.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store.set(id, state);
        return null;
      },
      readPending: async () => pending,
      clearPending: async () => {
        const n = pending.length;
        pending = [];
        return n;
      },
    };
    const e0 = appEditor(BASE);
    const b0 = await bindPageToEditorViaPort({ port: bare, pageId: "q1", editor: e0, seedJson: serialize(e0) });
    typeBlock(e0, "blk-mine", "本机");
    await b0.persist();
    const mine = store.get("q1")!;
    b0.dispose();

    pending = [{ seq: 1, state: peerStateFrom(mine, "blk-peer", "对端") }];
    const e1 = appEditor(projectStateToJson(mine));
    const b1 = await bindPageToEditorViaPort({ port: bare, pageId: "q1", editor: e1, seedJson: serialize(e1) });
    expect(b1.seeded).toBe(false);
    expect(idsOf(b1.session.exportJson())).toEqual(["blk-1", "blk-2", "blk-mine", "blk-peer"]);
    b1.dispose();

    // ② 实现里抛错 ⇒ 绑定**不该**因此失败；但必须**有痕**（console.warn），不许静默吞
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store2 = new Map<string, Uint8Array>();
    let pending2: Array<{ seq: number; state: Uint8Array }> = [];
    const angry = {
      read: async (id: string) => store2.get(id) ?? null,
      save: async (id: string, state: Uint8Array) => {
        store2.set(id, state);
        return null;
      },
      readPending: async () => pending2,
      clearPending: async () => {
        const n = pending2.length;
        pending2 = [];
        return n;
      },
      writeProjection: async () => {
        throw new Error("投影写不进去");
      },
    };
    const e2 = appEditor(BASE);
    const b2 = await bindPageToEditorViaPort({ port: angry, pageId: "q2", editor: e2, seedJson: serialize(e2) });
    typeBlock(e2, "blk-mine", "本机");
    await b2.persist();
    const mine2 = store2.get("q2")!;
    b2.dispose();

    pending2 = [{ seq: 2, state: peerStateFrom(mine2, "blk-peer", "对端") }];
    const e3 = appEditor(projectStateToJson(mine2));
    const b3 = await bindPageToEditorViaPort({ port: angry, pageId: "q2", editor: e3, seedJson: serialize(e3) });
    expect(idsOf(b3.session.exportJson())).toContain("blk-peer"); // 绑定成功、合并生效
    expect(warn.mock.calls.some((c) => String(c[0]).includes("投影写回失败")), "失败必须留痕").toBe(true);
    b3.dispose();
    warn.mockRestore();
  });
});
