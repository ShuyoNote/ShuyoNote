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
