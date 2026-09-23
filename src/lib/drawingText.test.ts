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

// ── P3-①（2026-09-23）：**进正文的全文** ＝ 标签 ＋ 结构（合成层） ────────────────────────
//
// ⚠️ 结构那一半的判据在 `drawingStructureText.test.ts`（AMD 的文件、22 条里的一半）——
// 这里**只**测合成层：两半都在、顺序与分隔符、没有结构时不加空行、总长封顶。
// 之所以不在这里重复测结构：两份判据测同一个实现，只会让"改哪一份"变成一场拉扯。
import { DRAWING_TEXT_TRUNCATED, MAX_DRAWING_TEXT_CHARS, excalidrawSearchText } from "./drawingText";

describe("excalidrawSearchText：进正文的全文（标签 ＋ 结构）", () => {
  const scene = [
    { id: "a", type: "rectangle", x: 0, y: 0 },
    { id: "a-t", type: "text", containerId: "a", text: "审批", x: 0, y: 0 },
    { id: "b", type: "rectangle", x: 200, y: 0 },
    { id: "b-t", type: "text", containerId: "b", text: "发布", x: 200, y: 0 },
    {
      id: "e",
      type: "arrow",
      x: 100,
      y: 0,
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    },
  ];

  it("★ 两半都在：标签那一半（既有）＋ 结构那一半（新）—— 这正是这一格要消灭的缺口", () => {
    const text = excalidrawSearchText(scene);
    expect(text).toContain("审批"); // 标签（既有行为）
    expect(text).toContain("审批 → 发布"); // 关系（新；方言由 drawingStructureText 定）
    expect(text.split("\n")[0]).toBe("审批 发布"); // 标签在前、结构在后
  });

  it("★ 没有结构时**不额外加空行**（否则每条正文尾巴都多一行空白）", () => {
    const onlyLabels = [{ type: "text", text: "标签一" }, { type: "rectangle" }];
    expect(excalidrawSearchText(onlyLabels)).toBe("标签一");
  });

  it("★ 总长封顶：超 `MAX_DRAWING_TEXT_CHARS` ⇒ 截断并**明说**（不许安静写一个巨型正文）", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      type: "text",
      text: `标签${i}-${"字".repeat(500)}`,
      x: i,
      y: 0,
    }));
    const text = excalidrawSearchText(many as never);
    expect(text.length).toBeLessThanOrEqual(MAX_DRAWING_TEXT_CHARS + DRAWING_TEXT_TRUNCATED.length);
    expect(text.endsWith(DRAWING_TEXT_TRUNCATED)).toBe(true);
  });

  it("回归守护：`excalidrawSceneText` 的行为不受这次改动影响", () => {
    const small = [{ type: "text", text: "标签一" }, { type: "rectangle" }, { type: "text", text: " " }];
    expect(excalidrawSceneText(small)).toBe("标签一");
    expect(excalidrawSearchText(small)).toBe("标签一");
  });
});
