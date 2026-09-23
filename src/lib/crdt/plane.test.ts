// Slice B 的最承重那条判据（施工单 §3 ①）：**开关关闭 ⇒ 逐字节等价**。
//
// 为什么先钉它：迁移最容易的坏法不是"新路不对"，而是"顺手改了没开开关那批人的字节"。
// 所以这里断言的是**同一引用**（`toBe`）而不是"内容相等" —— 内容相等太弱，能放过
// "重新序列化一遍、键序变了"这种看起来无害、实则让每个用户下次保存都全量上行一次的改动。
import { describe, expect, it, beforeEach } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { toLegacyDoc } from "../blockIdentity";
import { isCrdtPlaneEnabled, setCrdtPlaneEnabled, setCrdtPlaneImpl, throughCrdtPlane } from "./plane";
import { roundTripContentJson } from "./yDocBridge";

// 实现由**界面侧**注册（生产在 `src/main.tsx`）—— 判据里就注册真的那一份（与 Slice A 的壳同源）。
setCrdtPlaneImpl(roundTripContentJson);

/** 一批落盘形态的 fixture（够杂，才配叫「逐字节等价」）。 */
function fixtures(): string[] {
  const build = (f: () => void) => {
    const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-plane-fixture" });
    editor.update(() => {
      $getRoot().clear();
      f();
    }, { discrete: true });
    const legacy = JSON.parse(toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()))) as {
      root: { children: Array<Record<string, unknown>> };
    };
    legacy.root.children = legacy.root.children.map((c, i) => ({ ...c, blockId: `b${i + 1}` }));
    return JSON.stringify(legacy);
  };
  return [
    "{}",
    '{"root":{"type":"root","version":1,"direction":"ltr","format":"","indent":0,"children":[]}}',
    build(() => {
      const p = $createParagraphNode();
      p.append($createTextNode("第一段"));
      $getRoot().append(p);
    }),
    build(() => {
      const p = $createParagraphNode();
      p.append($createTextNode("a"), $createTextNode("b"));
      $getRoot().append(p);
    }),
  ];
}

describe("CRDT 平面开关", () => {
  beforeEach(() => setCrdtPlaneEnabled(false));

  it("① ★ 关闭时**逐字节等价**：返回的是同一个字符串（同一引用），一个字都没动", () => {
    expect(isCrdtPlaneEnabled()).toBe(false);
    for (const json of fixtures()) {
      expect(throughCrdtPlane(json)).toBe(json);
    }
  });

  it("② 打开时才真的往返（与 Slice A 的壳同源），并可以再关回去", () => {
    const json = fixtures()[2];
    setCrdtPlaneEnabled(true);
    expect(throughCrdtPlane(json)).toBe(roundTripContentJson(json));
    setCrdtPlaneEnabled(false);
    expect(throughCrdtPlane(json)).toBe(json);
  });

  it("③ 默认值就是关闭（判据自己盯着「默认不许悄悄打开」）", () => {
    // 防的是"某天有人把默认值改成 true，整仓行为随之改变却没人发现"
    expect(String(import.meta.env?.VITE_CRDT_PLANE ?? "")).not.toBe("1");
  });
});
