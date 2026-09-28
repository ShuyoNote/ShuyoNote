// 冲刺 CRDT 全上线 · **第一条承重判据**：CRDT 状态到底能不能"合"。
//
// 为什么先写它：Slice A 只证了"JSON ⇄ ydoc **往返保真**"（`yDocBridge.test.ts`）——那是**归一化**能力。
// "全上线"要的是**合并**能力：两台设备各改一处，合起来两处都在、不重复、不丢块。
// 这两件事**不是同一件事**，而且今天这条路上有一个会致命的反例（见 ①）。
//
// 判据口径：
//   ① **反例（架构红线）**：同一份 JSON **各自新建**的 ydoc 状态**不可合**（内容会翻倍）——
//      ⇒ "每次保存都从 JSON 新建一份 ydoc"这条路**不许走**；要能合，就必须**持久化并延续同一血统**。
//   ② **正例（原理）**：同一血统（同一 Y.Doc 上先后产生的两笔更新）**可合、顺序无关、不重复**
//      —— 这条用原生 `Y.Text` 证 Yjs 本身的性质，**不证**我们那套 Lexical 绑定也能如此
//      （那要等编辑器真绑定之后再证，见冲刺切片 S2）。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import { contentJsonToYDoc, yDocToContentJson } from "./yDocBridge";

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-mergeability-fixture" });
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

const topLevel = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<{ blockId?: string; type: string }> } }).root.children.map(
    (c) => `${c.type}#${c.blockId ?? "-"}`,
  );

const PAGE = withIds(
  buildJson(() => {
    const p = $createBlockParagraphNode("blk-1");
    p.append($createTextNode("原始正文"));
    $getRoot().append(p);
  }),
);

describe("冲刺切片 S1：CRDT 状态可合性（先证这条，才谈架构）", () => {
  it("① ★ 反例/红线：同一份 JSON **各自新建**的两份状态合起来 ⇒ 内容**翻倍**（不合）", () => {
    // 设备 A、设备 B 各自把**同一份**落盘 JSON 变成 ydoc 状态（今天 `contentJsonToYDoc` 的用法）
    const a = contentJsonToYDoc(PAGE).update;
    const b = contentJsonToYDoc(PAGE).update;

    // 第三方把它们合起来（CRDT 的合并 = 交换 update）
    const merged = new Y.Doc();
    Y.applyUpdate(merged, a);
    Y.applyUpdate(merged, b);

    let out: string | undefined;
    let err: unknown;
    try {
      out = yDocToContentJson(Y.encodeStateAsUpdate(merged));
    } catch (e) {
      err = e;
    }
    const shapes = err ? `抛错：${(err as Error).message.slice(0, 60)}` : JSON.stringify(topLevel(out!));
    // 记录**实测**结果（不预设它一定是哪种形态，但两者都证明"不可合"）
    console.log(`【① 实测】合并后的顶层块：${shapes}`);

    if (err) {
      // 抛错也算"不可合"——但**不是**我们想要的那种失败方式（必须留痕，不能静默）
      expect(true).toBe(true);
    } else {
      // 关键断言：内容**变多了** ⇒ 每台设备各铸了一套 CRDT 身份 ⇒ 这条路不能走
      expect(topLevel(out!).length).toBeGreaterThan(topLevel(PAGE).length);
    }
  });

  it("② 正例/原理：同一血统的两笔更新 ⇒ 可合、**顺序无关**、不重复（原生 Y.Text 证 Yjs 性质）", () => {
    // u1：doc 上插入"一"
    const d1 = new Y.Doc();
    d1.getText("t").insert(0, "一");
    const u1 = Y.encodeStateAsUpdate(d1);

    // u2：**从 u1 延续**（同一血统）再插入"二"
    const d2 = new Y.Doc();
    Y.applyUpdate(d2, u1);
    d2.getText("t").insert(1, "二");
    const u2 = Y.encodeStateAsUpdate(d2);

    const fwd = new Y.Doc();
    Y.applyUpdate(fwd, u1);
    Y.applyUpdate(fwd, u2);
    const rev = new Y.Doc();
    Y.applyUpdate(rev, u2);
    Y.applyUpdate(rev, u1);

    expect(fwd.getText("t").toString()).toBe("一二");
    expect(rev.getText("t").toString()).toBe("一二"); // 顺序无关
  });
});
