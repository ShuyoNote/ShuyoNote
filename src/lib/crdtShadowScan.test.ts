// ⭐ P3-3a 第二小步（task-52）判据：影子扫描（真实空间形状，mock api）。
import { describe, expect, it } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../editor/config";
import { toLegacyDoc } from "./blockIdentity";
import { contentJsonToYDoc } from "./crdt/yDocBridge";
import { shadowScanSpace, type ShadowScanApi } from "./crdtShadowScan";

function buildJson(): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-shadow-scan-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      const p1 = $createParagraphNode();
      p1.append($createTextNode("扫描第一段"));
      const p2 = $createParagraphNode();
      p2.append($createTextNode("扫描第二段"));
      $getRoot().append(p1, p2);
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

function apiOf(rows: Record<string, { json: string | Error; state: Uint8Array | null | Error }>): ShadowScanApi {
  return {
    listWorkspacePages: async (spaceId) => {
      if (spaceId === "boom-list") throw new Error("列表读不到");
      return Object.keys(rows).map((id) => ({ id }));
    },
    getPage: async (id) => {
      const r = rows[id];
      if (!r || r.json instanceof Error) throw r?.json ?? new Error("没有这一页");
      return { id, content_json: r.json } as unknown;
    },
    readPageState: async (id) => {
      const r = rows[id];
      if (!r || r.state instanceof Error) throw r?.state ?? new Error("没有状态");
      return r.state;
    },
  };
}

describe("shadowScanSpace：真实空间形状的只读扫描", () => {
  it("0 页 ⇒ 全 0；列表读不到 ⇒ 全 0（不抛）", async () => {
    const zeros = {
      total: 0,
      withState: 0,
      equal: 0,
      differ: 0,
      uncomparable: 0,
      differPageIds: [],
      differPending: 0,
      differUnexplained: 0,
    };
    await expect(shadowScanSpace("", { ...apiOf({}), listWorkspacePages: async () => [] })).resolves.toEqual(zeros);
    await expect(shadowScanSpace("boom-list", apiOf({}))).resolves.toEqual(zeros);
    // 空间 id 空白 ⇒ 直接空（不该去拉列表）
    await expect(shadowScanSpace("   ", apiOf({}))).resolves.toEqual(zeros);
  });

  it("多页：相等/不等/无状态/坏 JSON/单页抛错都只计数，不中断", async () => {
    const json = withIds(buildJson());
    const state = contentJsonToYDoc(json).update;
    const changed = json.replace("扫描第二段", "扫描第二段（改过）");
    const rows = {
      "p-equal": { json, state },
      "p-differ": { json: changed, state },
      "p-no-state": { json, state: null },
      "p-bad-json": { json: "{不是 json", state },
      "p-get-throws": { json: new Error("getPage 炸了"), state },
      "p-state-throws": { json, state: new Error("readPageState 炸了") },
    };
    const got = await shadowScanSpace("sp", apiOf(rows));
    expect(got.total).toBe(6);
    // withState 只数"真的拿到了非空状态"的：equal/differ/bad-json（state-throws 在读取阶段就失败）。
    expect(got.withState).toBe(3);
    expect(got.equal).toBe(1);
    expect(got.differ).toBe(1);
    expect(got.differPageIds).toEqual(["p-differ"]);
    expect(got.uncomparable).toBe(4);
    // 脱敏：扫描结果不带正文。
    expect(JSON.stringify(got)).not.toContain("扫描第一段");
  });

  it("页 id 缺失也算不可比（继续扫后面的页）", async () => {
    const json = withIds(buildJson());
    const state = contentJsonToYDoc(json).update;
    const api: ShadowScanApi = {
      listWorkspacePages: async () => [{ id: "" }, { id: "p-ok" }],
      getPage: async () => ({ content_json: json }),
      readPageState: async () => state,
    };
    const got = await shadowScanSpace("sp", api);
    expect(got.total).toBe(2);
    expect(got.uncomparable).toBe(1);
    expect(got.equal).toBe(1);
  });

  it("差异分类：有待合并远端状态 ⇒ differPending；没有 ⇒ differUnexplained", async () => {
    const json = withIds(buildJson());
    const state = contentJsonToYDoc(json).update;
    const changed = json.replace("扫描第二段", "扫描第二段（改过）");
    const api: ShadowScanApi = {
      listWorkspacePages: async () => [{ id: "p-pending" }, { id: "p-other" }],
      getPage: async () => ({ content_json: changed }),
      readPageState: async () => state,
      readPendingStates: async (id) =>
        id === "p-pending" ? [{ seq: 1, state: new Uint8Array([1]) }] : [],
    };
    const got = await shadowScanSpace("sp", api);
    expect(got.differ).toBe(2);
    expect(got.differPending).toBe(1);
    expect(got.differUnexplained).toBe(1);
  });
});
