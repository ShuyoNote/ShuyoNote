// ⭐ P3-3a 第一小步（task-51）判据：影子比对纯函数（真 yjs / 真编辑器 fixture）。
//
// 样本**用真编辑器搭**（与 yDocBridge/pageBinding 判据同款）：手写节点 schema 会写出
// "看起来像、其实非法"的 JSON，那样证明不了任何事。
import { describe, expect, it } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../editor/config";
import { toLegacyDoc } from "./blockIdentity";
import { contentJsonToYDoc } from "./crdt/yDocBridge";
import {
  canonicalJson,
  SHADOW_IGNORED_KEYS,
  shadowCanonicalJson,
  shadowCompareProjection,
  shadowCompareRows,
} from "./crdtShadow";

function buildJson(build: (append: (node: ReturnType<typeof $createParagraphNode>) => void) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-shadow-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build((n) => $getRoot().append(n));
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

/** 生产里补种由保存路径做；本层不造身份（与 yDocBridge 判据同一手法）。 */
function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

function fixture(): string {
  return withIds(
    buildJson((append) => {
      const p1 = $createParagraphNode();
      p1.append($createTextNode("第一段正文"));
      const p2 = $createParagraphNode();
      p2.append($createTextNode("第二段正文"));
      append(p1);
      append(p2);
    }),
  );
}

const stateOf = (json: string) => contentJsonToYDoc(json).update;

/** 递归反转对象键插入顺序（数组保序）—— 用来造"键序不同、语义相同"的样本。 */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).reverse()) {
      out[k] = shuffleKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

describe("canonicalJson：键序无关、数组保序、坏输入 null", () => {
  it("对象键递归排序；数组顺序保持（顺序不同就不相等）", () => {
    expect(canonicalJson('{"b":1,"a":{"d":2,"c":3}}')).toBe(canonicalJson('{"a":{"c":3,"d":2},"b":1}'));
    expect(canonicalJson("[1,2,3]")).not.toBe(canonicalJson("[3,2,1]"));
    // 嵌套数组里的对象同样排序
    expect(canonicalJson('[{"y":1,"x":2}]')).toBe(canonicalJson('[{"x":2,"y":1}]'));
  });

  it("空串/纯空白/坏 JSON ⇒ null（⛔ 不抛，也⛔ 不当成空页）", () => {
    expect(canonicalJson("")).toBeNull();
    expect(canonicalJson("   ")).toBeNull();
    expect(canonicalJson("{ not json")).toBeNull();
    expect(canonicalJson("undefined")).toBeNull();
  });
});

describe("shadowCompareProjection：落盘 JSON vs CRDT 投影（只回结论/canonical）", () => {
  it("① 同一份内容 ⇒ equal（投影与原始 JSON canonical 相等）", () => {
    const json = fixture();
    const cmp = shadowCompareProjection(json, stateOf(json));
    expect(cmp.equal, JSON.stringify(cmp)).toBe(true);
    expect(cmp.reason).toBeUndefined();
    expect(cmp.storedCanonical).toBe(cmp.projectedCanonical);
  });

  it("② 键序不同但语义相同 ⇒ 仍 equal", () => {
    const json = fixture();
    const reordered = JSON.stringify(shuffleKeys(JSON.parse(json)));
    expect(reordered).not.toBe(json); // 前提：确实换了键序
    expect(shadowCompareProjection(reordered, stateOf(json)).equal).toBe(true);
  });

  it("③ 改一个块的正文 ⇒ differ（两边 canonical 都给出，供诊断）", () => {
    const json = fixture();
    const changed = json.replace("第二段正文", "第二段正文（改过）");
    expect(changed).not.toBe(json);
    const cmp = shadowCompareProjection(changed, stateOf(json));
    expect(cmp.equal).toBe(false);
    expect(cmp.reason).toBe("differ");
    expect(cmp.storedCanonical).toBeTruthy();
    expect(cmp.projectedCanonical).toBeTruthy();
    expect(cmp.storedCanonical).not.toBe(cmp.projectedCanonical);
  });

  it("④ 无状态/空字节 ⇒ 不可比（单独 reason，不算 differ）", () => {
    const json = fixture();
    expect(shadowCompareProjection(json, null).reason).toBe("no_state");
    expect(shadowCompareProjection(json, undefined).reason).toBe("no_state");
    expect(shadowCompareProjection(json, new Uint8Array()).reason).toBe("empty_state");
  });

  it("⑤ 坏落盘 JSON / 坏状态字节 ⇒ 不可比且**不抛**", () => {
    expect(shadowCompareProjection("{不是 json", stateOf(fixture())).reason).toBe("bad_stored_json");
    const badState = new Uint8Array([1, 2, 3, 4]);
    expect(() => shadowCompareProjection(fixture(), badState)).not.toThrow();
    expect(shadowCompareProjection(fixture(), badState).reason).toBe("projection_failed");
  });
});

describe("shadowCompareRows：只回计数与 page id（脱敏）", () => {
  it("混合行 ⇒ 计数正确、differPageIds 只含不一致的 id、不带正文", () => {
    const json = fixture();
    const changed = json.replace("第一段正文", "第一段正文（改过）");
    const state = stateOf(json);
    const rows = [
      { id: "p-equal", json },
      { id: "p-differ", json: changed },
      { id: "p-no-state", json },
      { id: "p-empty", json },
      { id: "p-bad-json", json: "{不是 json" },
      { id: "p-throws", json },
    ];
    const got = shadowCompareRows(rows, (id) => {
      if (id === "p-throws") throw new Error("读状态失败");
      if (id === "p-no-state") return null;
      if (id === "p-empty") return new Uint8Array();
      return state;
    });
    expect(got.total).toBe(6);
    expect(got.withState).toBe(3); // equal + differ + bad-json（有状态但落盘 JSON 坏 ⇒ 不可比）
    expect(got.equal).toBe(1);
    expect(got.differ).toBe(1);
    expect(got.uncomparable).toBe(4); // no-state/empty/bad-json/throws
    expect(got.differPageIds).toEqual(["p-differ"]);
    // 脱敏：结果里一个正文字都不许出现（只计数与 id）。
    const printed = JSON.stringify(got);
    expect(printed).not.toContain("第一段正文");
    expect(printed).not.toContain("第二段正文");
  });

  it("空行集 ⇒ 全 0（不抛）", () => {
    expect(shadowCompareRows([], () => null)).toEqual({
      total: 0,
      withState: 0,
      equal: 0,
      differ: 0,
      uncomparable: 0,
      differPageIds: [],
    });
  });
});

// ⭐ A1 修法 A（owner 2026-11-14 拍）：影子比对**忽略元数据键**（`blockRev`）。
// 来由：2026-11-14 根因定位 —— 落盘带 `blockRev`、投影不带 ⇒ canonical 必不同 ⇒ equal 永远 0。
describe("A1 修法 A：影子忽略元数据键（blockRev）", () => {
  const doc = (text: string, rev: number) =>
    JSON.stringify({
      root: {
        children: [
          { blockId: "b1", blockRev: rev, children: [{ type: "text", text, detail: 0, format: 0, mode: "normal", style: "", version: 1 }], direction: null, format: "", indent: 0, type: "paragraph", version: 1 },
        ],
      },
    });

  it("⑯ 只差 blockRev ⇒ 影子 canonical 相同（且名单里确实有 blockRev）", () => {
    expect(SHADOW_IGNORED_KEYS).toContain("blockRev");
    expect(shadowCanonicalJson(doc("同一段", 18))).toBe(shadowCanonicalJson(doc("同一段", 99)));
  });

  it("⑰ 内容不同 ⇒ 仍判不同（忽略的只是元数据，不是内容）", () => {
    expect(shadowCanonicalJson(doc("甲", 18))).not.toBe(shadowCanonicalJson(doc("乙", 18)));
  });

  it("⑱ 真往返（落盘带 rev、投影不带 rev）⇒ shadowCompareProjection 判 equal", () => {
    // ⚠️ 用**真编辑器 fixture**（文件头那条纪律：手写 schema 证明不了往返）
    const stored = (() => {
      const d = JSON.parse(withIds(fixture())) as { root: { children: Array<Record<string, unknown>> } };
      d.root.children = d.root.children.map((c) => ({ ...c, blockRev: 18 }));
      return JSON.stringify(d);
    })();
    const state = contentJsonToYDoc(stored).update;
    const r = shadowCompareProjection(stored, state);
    expect(r.equal, `reason=${r.reason ?? ""}`).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});
