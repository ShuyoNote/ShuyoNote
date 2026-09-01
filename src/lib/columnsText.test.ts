import { describe, expect, it } from "vitest";
import { collectColumnsText } from "./columnsText";

// A column's serialized value is the JSON string of its nested EditorState.
function columnsPage(cols: string[]): string {
  return JSON.stringify({
    root: {
      children: [{ type: "columnsBlock", cols }],
    },
  });
}

function colState(texts: string[]): string {
  return JSON.stringify({
    root: { children: texts.map((t) => ({ type: "paragraph", children: [{ type: "text", text: t }] })) },
  });
}

describe("collectColumnsText", () => {
  it("extracts text from every column, joined and newline-prefixed", () => {
    const page = columnsPage([colState(["列一"]), colState(["列二", "更多"])]);
    expect(collectColumnsText(page)).toBe("\n列一 列二 更多");
  });

  it("returns empty string when there is no columnsBlock", () => {
    expect(collectColumnsText(JSON.stringify({ root: { children: [{ type: "paragraph" }] } }))).toBe("");
  });

  it("returns empty string for invalid JSON", () => {
    expect(collectColumnsText("not json")).toBe("");
  });

  it("skips a malformed column JSON without failing", () => {
    const page = columnsPage(["not-json", colState(["好列"])]);
    expect(collectColumnsText(page)).toBe("\n好列");
  });

  it("handles a column whose state is a bare children array", () => {
    const bare = JSON.stringify({ children: [{ type: "text", text: "bare" }] });
    const page = columnsPage([bare]);
    expect(collectColumnsText(page)).toBe("\nbare");
  });
});
