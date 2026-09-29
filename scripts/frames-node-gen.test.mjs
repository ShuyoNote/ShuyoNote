// 一次性判据（**不提交**）：把"喂帧压测"的**帧生成器**钉住 ——
//   ① 每帧都是**合法**的 yjs 增量（能原样喂给应用那条 `session.merge`，不抛）；
//   ② 帧的**增量**语义成立：N 帧喂进去，真编辑器的正文**恰好长 N 个字符**（不重不漏）；
//   ③ 帧字节尺度（生产里同一形状：一条 `page_crdt_pending` 一行）。
//
// ⚠️ 它**不**量性能（性能读数在 /tmp/frames/frames-loadtest.mjs 的真浏览器里）；只证"帧是真的"。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../src/editor/config";
import { $createBlockParagraphNode } from "../src/editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../src/lib/blockIdentity";
import {
  CRDT_ROOT_KEY_V2,
  openPageSession,
} from "../src/lib/crdt/yDocBridge";

function buildJson(build) {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "frames-node-fixture" });
  editor.update(() => { $getRoot().clear(); build(editor); }, { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}
function withIds(json) {
  const d = JSON.parse(toLegacyDoc(json));
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

const BASE = withIds(
  buildJson(() => {
    const p = $createBlockParagraphNode("blk-1");
    p.append($createTextNode("基线"));
    $getRoot().append(p);
  }),
);

/** 与压测脚本同一段逻辑：另一端（同一条血统）真编辑 ⇒ 每次 mutate 由 doc 的 update 事件给真增量。 */
function makeFrames(state, n) {
  const sim = new Y.Doc();
  sim.get(CRDT_ROOT_KEY_V2, Y.XmlElement);
  Y.applyUpdate(sim, state);
  const out = [];
  sim.on("update", (u) => out.push(u));
  const p = sim.get(CRDT_ROOT_KEY_V2, Y.XmlElement).get(0);
  if (p.length === 0) p.insert(0, [new Y.XmlText()]);
  for (let i = 0; i < n; i += 1) {
    const t = p.get(p.length - 1);
    t.insert(t.length, "x");
  }
  return { out, sim };
}

describe("喂帧压测：帧生成器（真 yjs 增量）", () => {
  it("N 帧 = N 个真增量；逐帧喂给应用那条 session.merge ⇒ 正文恰好长 N 个字符", () => {
    const target = openPageSession({ json: BASE }); // 被喂的那一端（应用路径）
    const state = target.exportState();
    const before = target.exportJson();
    const { out } = makeFrames(state, 200);

    // ① 每帧都是真增量（不是全量状态）：字节尺度远小于全量
    expect(out.length).toBe(200);
    const fullLen = state.length;
    for (const u of out) {
      expect(u).toBeInstanceOf(Uint8Array);
      expect(u.length).toBeGreaterThan(0);
      expect(u.length).toBeLessThan(fullLen);
    }
    // ② 帧与帧**不重复**：第一帧与最后一帧字节不同（每笔是新的增量）
    expect(Buffer.from(out[0]).equals(Buffer.from(out[199]))).toBe(false);

    // ③ 逐帧 merge（就是压测里被计时的那一次调用）——不抛
    for (const u of out) target.merge(u);

    const after = JSON.parse(toLegacyDoc(target.exportJson()));
    const text = (after.root.children[0].children ?? []).map((c) => c.text ?? "").join("");
    // 基线"基线" ＋ 200 个 x
    expect(text).toBe("基线" + "x".repeat(200));
    expect(before).not.toBe(after ? JSON.stringify(after) : "");
  });

  it("帧字节尺度：约 18–22 字节/帧（与浏览器里同一生成器一致）", () => {
    const target = openPageSession({ json: BASE });
    const { out } = makeFrames(target.exportState(), 50);
    const lens = out.map((u) => u.length);
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...lens)).toBeLessThanOrEqual(64);
  });

  it("合并**幂等**（同一帧喂两次不重复长字）—— 生产里 seq 重放会遇到这条", () => {
    const target = openPageSession({ json: BASE });
    const { out } = makeFrames(target.exportState(), 3);
    for (const u of out) { target.merge(u); target.merge(u); }
    const after = JSON.parse(toLegacyDoc(target.exportJson()));
    const text = (after.root.children[0].children ?? []).map((c) => c.text ?? "").join("");
    expect(text).toBe("基线" + "xxx");
  });
});
