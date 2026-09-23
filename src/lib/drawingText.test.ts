import { describe, expect, it } from "vitest";
import { excalidrawSceneHasContent, excalidrawSceneText } from "./drawingText";

describe("excalidrawSceneText", () => {
  it("collects only text-element labels", () => {
    const scene = [
      { type: "text", text: "标签一" },
      { type: "rectangle" },               // no text
      { type: "text", text: "标签二" },
      { type: "text", text: "   " },       // blank → skipped
      { type: "text", text: "" },          // empty → skipped
    ];
    expect(excalidrawSceneText(scene)).toBe("标签一 标签二");
  });

  it("handles undefined / null input", () => {
    expect(excalidrawSceneText(undefined as never)).toBe("");
    expect(excalidrawSceneText([])).toBe("");
  });
});

describe("excalidrawSceneHasContent", () => {
  it("true when any element is not deleted", () => {
    expect(excalidrawSceneHasContent([{ type: "rectangle", isDeleted: true }, { type: "text", text: "x" }])).toBe(true);
  });

  it("false for empty or all-deleted scenes", () => {
    expect(excalidrawSceneHasContent([])).toBe(false);
    expect(excalidrawSceneHasContent([{ isDeleted: true }])).toBe(false);
    expect(excalidrawSceneHasContent(undefined as never)).toBe(false);
  });
});

// ── P3-①（2026-09-23）：**结构文本**（节点/连线）与它进正文的全文 ──────────────────────────
//
// 这一格要证的**不是"能拼出字符串"**，而是四件容易悄悄坏掉的事：
//   ① 确定性（同 scene ⇒ 同文本）；② **纯装饰不许写成噪声**；③ 端点找不到时不编名字；
//   ④ 上限（正文列不能无限长）。另加一条**回归守护**：`excalidrawSceneText` 的既有期望不许被这次改动影响。
import {
  MAX_STRUCTURE_LINKS,
  excalidrawSearchText,
  excalidrawStructureText,
} from "./drawingText";

/** 造一个"带标签的形状"（Excalidraw 里标签是 bound 的 text 元素）。 */
const shape = (id: string, x = 0) => ({ id, type: "rectangle", x });
const label = (id: string, containerId: string, text: string) => ({
  id,
  type: "text",
  containerId,
  text,
});
const arrow = (id: string, from?: string, to?: string) => ({
  id,
  type: "arrow",
  startBinding: from ? { elementId: from } : null,
  endBinding: to ? { elementId: to } : null,
});

describe("excalidrawStructureText：连线（P3-①）", () => {
  it("★ 带标签的两个形状 ⇒ 一行 `矩形\"审批\" →箭头→ 矩形\"发布\"`（方案 P3 的方言）", () => {
    const scene = [
      shape("a"),
      label("a-t", "a", "审批"),
      shape("b"),
      label("b-t", "b", "发布"),
      arrow("e", "a", "b"),
    ];
    expect(excalidrawStructureText(scene)).toBe('矩形"审批" →箭头→ 矩形"发布"');
  });

  it("★ 确定性：同 scene 跑两次一样；多连线按**元素顺序**", () => {
    const scene = [
      shape("a"),
      label("a-t", "a", "甲"),
      shape("b"),
      label("b-t", "b", "乙"),
      shape("c"),
      label("c-t", "c", "丙"),
      arrow("e2", "b", "c"),
      arrow("e1", "a", "b"),
    ];
    const first = excalidrawStructureText(scene);
    expect(excalidrawStructureText(scene)).toBe(first);
    expect(first.split("\n")).toEqual([
      '矩形"乙" →箭头→ 矩形"丙"',
      '矩形"甲" →箭头→ 矩形"乙"',
    ]);
  });

  it("★ 纯装饰不许写成噪声：自由画笔 / 无绑定的背景矩形 / 没有端点的散箭头 ⇒ 空", () => {
    const scene = [
      { id: "f", type: "freedraw" },
      { id: "bg", type: "rectangle", backgroundColor: "#eee" },
      arrow("stray"),
      { id: "img", type: "image" },
    ];
    expect(excalidrawStructureText(scene)).toBe("");
  });

  it("★ 端点找不到 ⇒ `(找不到)`（如实说，不编一个名字）；无标签 ⇒ `(未命名矩形)`", () => {
    const scene = [shape("a"), label("a-t", "a", "有名字"), shape("b"), arrow("e", "a", "b")];
    const out = excalidrawStructureText(scene);
    expect(out).toContain('矩形"有名字" →箭头→ (未命名矩形)');

    const dangling = [shape("a"), label("a-t", "a", "甲"), arrow("e", "a", "nope")];
    expect(excalidrawStructureText(dangling)).toBe('矩形"甲" →箭头→ (找不到)');
  });

  it("删除的元素不参与（含被删的箭头与被删的标签）", () => {
    const scene = [
      shape("a"),
      label("a-t", "a", "甲"),
      { ...shape("b"), isDeleted: true },
      arrow("e", "a", "b"),
    ];
    expect(excalidrawStructureText(scene)).toBe('矩形"甲" →箭头→ (找不到)');
  });

  it("★ 上限：超过 MAX_STRUCTURE_LINKS 条要**截断并明说**（正文列不能无限长）", () => {
    const scene: unknown[] = [shape("a"), label("a-t", "a", "甲")];
    for (let i = 0; i < MAX_STRUCTURE_LINKS + 2; i++) {
      scene.push(shape(`s${i}`), label(`s${i}-t`, `s${i}`, `节点${i}`), arrow(`e${i}`, "a", `s${i}`));
    }
    const out = excalidrawStructureText(scene as never);
    expect(out.split("\n")).toHaveLength(MAX_STRUCTURE_LINKS + 1); // 200 行 + 截断说明
    expect(out).toContain("还有 2 条连线未展开");
  });

  it("空 / undefined 输入 ⇒ 空串（不抛）", () => {
    expect(excalidrawStructureText([])).toBe("");
    expect(excalidrawStructureText(undefined as never)).toBe("");
  });
});

describe("excalidrawSearchText：进正文的全文（标签 ＋ 结构）", () => {
  it("★ 标签与结构**都在**（这正是这一格要消灭的缺口：关系此前不在正文里）", () => {
    const scene = [
      shape("a"),
      label("a-t", "a", "审批"),
      shape("b"),
      label("b-t", "b", "发布"),
      arrow("e", "a", "b"),
    ];
    const text = excalidrawSearchText(scene);
    expect(text).toContain("审批"); // 标签那一半（既有行为）
    expect(text).toContain('矩形"审批" →箭头→ 矩形"发布"'); // 结构那一半（新）
    expect(text.split("\n")[0]).toBe("审批 发布"); // 标签在前、结构在后
  });

  it("★ 回归守护：`excalidrawSceneText` 的行为**不许**被这次改动影响", () => {
    const scene = [{ type: "text", text: "标签一" }, { type: "rectangle" }, { type: "text", text: " " }];
    expect(excalidrawSceneText(scene)).toBe("标签一");
    expect(excalidrawSearchText(scene)).toBe("标签一"); // 没有连线 ⇒ 不额外加空行
  });
});
