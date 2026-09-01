import { describe, expect, it } from "vitest";
import { lexicalStateValid } from "./lexicalValidate";

function doc(children: unknown[]): string {
  return JSON.stringify({ root: { type: "root", version: 1, children } });
}

function parsed(s: string | null): { root: { children: any[]; [k: string]: unknown } } | null {
  return s ? (JSON.parse(s) as { root: { children: any[]; [k: string]: unknown } }) : null;
}

describe("lexicalStateValid", () => {
  it("keeps a valid doc's children intact", () => {
    const input = doc([
      { type: "paragraph", version: 1, children: [{ type: "text", text: "hi", version: 1 }] },
    ]);
    const out = parsed(lexicalStateValid(input));
    expect(out?.root.children).toHaveLength(1);
    expect(out?.root.children[0].type).toBe("paragraph");
  });

  it("returns null for invalid JSON", () => {
    expect(lexicalStateValid("not json")).toBeNull();
    expect(lexicalStateValid("")).toBeNull();
  });

  it("returns null when the doc has no root", () => {
    expect(lexicalStateValid(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(lexicalStateValid(JSON.stringify(null))).toBeNull();
  });

  it("normalizes a missing root type to 'root'", () => {
    const out = parsed(
      lexicalStateValid(JSON.stringify({ root: { children: [{ type: "paragraph", version: 1, children: [] }] } })),
    );
    expect(out?.root.type).toBe("root");
  });

  it("drops children without a valid node type", () => {
    const input = doc([
      { type: "paragraph", version: 1, children: [] }, // valid
      { version: 1, children: [] },                    // missing type
      { type: "undefined", children: [] },             // literal "undefined"
      { type: "null", children: [] },                  // literal "null"
      "not-a-node",                                    // non-object
      null,                                            // null
    ]);
    const out = parsed(lexicalStateValid(input));
    expect(out?.root.children).toHaveLength(1);
    expect(out?.root.children[0].type).toBe("paragraph");
  });

  it("returns null when nothing survives sanitization", () => {
    expect(lexicalStateValid(doc([{ version: 1 }, { type: "undefined" }]))).toBeNull();
  });

  it("drops types outside the allowed set (unregistered nodes)", () => {
    const input = doc([
      { type: "paragraph", version: 1, children: [] },
      { type: "callout", version: 1, children: [] },
    ]);
    const out = parsed(lexicalStateValid(input, new Set(["paragraph"])));
    expect(out?.root.children).toHaveLength(1);
    expect(out?.root.children[0].type).toBe("paragraph");
  });

  it("sanitizes $slots entries (shadow-root slot frames)", () => {
    const input = doc([
      {
        type: "columns",
        version: 1,
        children: [],
        $slots: {
          col1: { type: "column", version: 1, children: [] },
          bad: { noType: true },
        },
      },
    ]);
    const out = parsed(lexicalStateValid(input));
    const slots = out?.root.children[0].$slots as Record<string, unknown>;
    expect(slots.col1).toBeDefined();
    expect(slots.bad).toBeUndefined();
  });
});
