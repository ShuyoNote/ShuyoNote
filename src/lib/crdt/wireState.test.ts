// 冲刺 S4b-0 的判据：wire 载荷里 CRDT 状态字段的形状与版本标记。
//
// 这一层的价值全在**边界**上：没有状态 / 老载荷 / 版本不认识 / 载荷坏了 —— 四种情况必须**分得开**，
// 因为它们的处置完全不同（照旧发 / 走今天那条路 / 如实说 / 如实报错）。混成一种的下场是静默丢块。
import { describe, expect, it } from "vitest";
import { CRDT_WIRE_VERSION } from "./wireConstants";
import { decodeCrdtWire, encodeCrdtWire } from "./wireState";

describe("冲刺 S4b-0：wire 载荷里的 CRDT 状态字段", () => {
  it("① 往返：`encode` → `decode` 逐字节相同（含非 UTF-8 字节）", () => {
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x01]);
    const enc = encodeCrdtWire(raw);
    expect(enc).toEqual({ v: CRDT_WIRE_VERSION, state: Array.from(raw) });

    const dec = decodeCrdtWire(enc);
    expect(dec.kind).toBe("ok");
    if (dec.kind === "ok") expect(Array.from(dec.state)).toEqual(Array.from(raw));
  });

  it("② 没有状态 ⇒ `undefined`（**不发空壳**）；空字节也算没有", () => {
    expect(encodeCrdtWire(null)).toBeUndefined();
    expect(encodeCrdtWire(undefined)).toBeUndefined();
    expect(encodeCrdtWire(new Uint8Array(0))).toBeUndefined();
  });

  it("③ 老载荷（缺字段 / null / 不是对象）⇒ `{kind:'none'}` —— 如实降级，**不是**空状态", () => {
    expect(decodeCrdtWire(undefined)).toEqual({ kind: "none" });
    expect(decodeCrdtWire(null)).toEqual({ kind: "none" });
    expect(decodeCrdtWire("whatever")).toEqual({ kind: "none" });
    expect(decodeCrdtWire(42)).toEqual({ kind: "none" });
  });

  it("④ ★ 版本不认识 ⇒ `{kind:'unknown-version'}`（**不猜**、不当成 v1 解）", () => {
    const future = { v: CRDT_WIRE_VERSION + 1, state: [1, 2, 3] };
    expect(decodeCrdtWire(future)).toEqual({ kind: "unknown-version", v: CRDT_WIRE_VERSION + 1 });
    expect(decodeCrdtWire({ state: [1, 2, 3] })).toEqual({ kind: "unknown-version", v: NaN });
  });

  it("⑤ 载荷坏了（版本已知但 `state` 不是数组 / 字节越界）⇒ **如实抛**，不静默截断", () => {
    expect(() => decodeCrdtWire({ v: CRDT_WIRE_VERSION, state: "abc" })).toThrow(/不是数组/);
    expect(() => decodeCrdtWire({ v: CRDT_WIRE_VERSION, state: [1, 256] })).toThrow(/0\.\.255/);
    expect(() => decodeCrdtWire({ v: CRDT_WIRE_VERSION, state: [1, -1] })).toThrow(/0\.\.255/);
    expect(() => decodeCrdtWire({ v: CRDT_WIRE_VERSION, state: [1, 1.5] })).toThrow(/0\.\.255/);
  });
});
