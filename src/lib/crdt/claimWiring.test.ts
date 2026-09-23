// 冲刺 S9 · 客户端接线（第二片）的判据：把 claim 的**决策**接进"打开一页"的路径。
//
// 三条要钉死的（前两条是新增语义，第三条保证**不接线时行为不变**）：
//   ① claim 成功 ⇒ 建血统并落盘（＝今天的行为）；
//   ② ★ claim **被拒（denied）** ⇒ **不建**、**不落盘**、**如实抛**（措辞要让用户看懂）——
//      这正是"关掉两台设备各建一条血统"的那个窗口；
//   ③ **不传 claim 端口**（今天）⇒ 归一成 `unavailable` ⇒ 走"离线临时建"⇒ 与接线前**逐字相同**。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, toModelDoc } from "../blockIdentity";
import { readPageCrdtState, type ContentSql } from "../docContent";
import { bindPageToEditorViaPort } from "./pageBinding";
import type { PageClaimPort } from "./bootstrap";

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
  return { db: db as unknown as ContentSql, rows };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-claim-wiring-fixture" });
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

const appEditor = (json: string): LexicalEditor => {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-claim-wiring-editor" });
  // ⚠️ 与真加载路径一致：落盘形态**先过 `toModelDoc`**（否则编辑器里是内置 paragraph、不带 blockId
  //    ⇒ 序列化出去缺身份 ⇒ `openPageSession({json})` 当场抛）。这条坑上一轮刚踩过，fixture 别再漏。
  editor.setEditorState(
    editor.parseEditorState(
      toModelDoc(json, () => {
        throw new Error("fixture 不该铸身份（样本里每个顶层块都已有 blockId）");
      }),
    ),
  );
  return editor;
};

const serialize = (editor: LexicalEditor) => toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()));

describe("冲刺 S9 · 接线：claim 的决策进「打开一页」这条路径", () => {
  it("① claim 成功 ⇒ 建血统并落盘（`seeded=true`、库里有了状态）", async () => {
    const { db, rows } = fakeDb();
    const saved: string[] = [];
    const port = {
      read: async () => null,
      save: async (id: string, state: Uint8Array) => {
        saved.push(id);
        db.run("INSERT INTO page_crdt (page_id, state, updated_at) VALUES (?,?,?)", [id, state, 1]);
        return null;
      },
    };
    const granted: PageClaimPort = { claim: async () => true };
    const editor = appEditor(BASE);
    const b = await bindPageToEditorViaPort({
      port,
      pageId: "p1",
      editor,
      seedJson: serialize(editor),
      claim: granted,
      deviceId: "devA",
    });
    expect(b.seeded).toBe(true);
    expect(saved).toEqual(["p1"]);
    expect(rows.size).toBe(1);
    b.dispose();
  });

  it("② ★ claim **被拒** ⇒ **不建、不落盘、如实抛**（关掉「各建一条血统」的那个窗口）", async () => {
    const { db, rows } = fakeDb();
    let saved = 0;
    const port = {
      read: async () => null,
      save: async () => {
        saved += 1;
        return null;
      },
    };
    const denied: PageClaimPort = { claim: async () => false };
    const editor = appEditor(BASE);

    await expect(
      bindPageToEditorViaPort({
        port,
        pageId: "p1",
        editor,
        seedJson: serialize(editor),
        claim: denied,
        deviceId: "devB",
      }),
    ).rejects.toThrow(/属于另一台设备/);

    expect(saved).toBe(0); // ★ 一次都没落盘
    expect(readPageCrdtState(db, "p1")).toBeNull(); // ★ 本机没有建血统
    expect(rows.size).toBe(0);
  });

  it("③ 不传 claim 端口（今天）⇒ 走「离线临时建」，与接线前**逐字相同**", async () => {
    const { rows } = fakeDb();
    const port = {
      read: async () => null,
      save: async (id: string, state: Uint8Array) => {
        rows.set(id, state);
        return null;
      },
    };
    const editor = appEditor(BASE);
    const b = await bindPageToEditorViaPort({ port, pageId: "p1", editor, seedJson: serialize(editor) });
    expect(b.seeded).toBe(true); // 照旧建（离线可用性优先）
    expect(rows.size).toBe(1);
    b.dispose();
  });
});
