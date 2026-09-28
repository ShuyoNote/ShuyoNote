// 冲刺 S4b-0 的判据：wire 载荷里 CRDT 状态字段的形状与版本标记。
//
// 这一层的价值全在**边界**上：没有状态 / 老载荷 / 版本不认识 / 载荷坏了 —— 四种情况必须**分得开**，
// 因为它们的处置完全不同（照旧发 / 走今天那条路 / 如实说 / 如实报错）。混成一种的下场是静默丢块。
import { describe, expect, it } from "vitest";
import { CRDT_WIRE_VERSION } from "./wireConstants";
import { decodeCrdtWire, encodeCrdtWire, withCrdtWire, CRDT_WIRE_FIELD } from "./wireState";

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

  // ---------------------------------------------------------------------------------------
  // S4b-1：把状态挂到载荷上（outbox 那一处调用的就是它）
  // ---------------------------------------------------------------------------------------

  it("⑥ ★ 没有状态 ⇒ 返回**同一个引用**（序列化字节与接线前逐字相同 ⇒ 老路径零感知）", () => {
    const payload = { id: "p1", title: "页" };
    expect(withCrdtWire(payload, null)).toBe(payload);
    expect(withCrdtWire(payload, undefined)).toBe(payload);
    expect(withCrdtWire(payload, new Uint8Array(0))).toBe(payload);
    expect(JSON.stringify(withCrdtWire(payload, null))).toBe(JSON.stringify(payload));
  });

  it("⑦ 有状态 ⇒ 加上 `crdt_state`（带版本标记），原字段**一个不改**", () => {
    const payload = { id: "p1", title: "页", content_json: "{}" };
    const state = new Uint8Array([1, 2, 255]);
    const out = withCrdtWire(payload, state) as Record<string, unknown>;
    expect(out).not.toBe(payload); // 是**拷贝**，不动调用方那份
    expect(out[CRDT_WIRE_FIELD]).toEqual({ v: CRDT_WIRE_VERSION, state: [1, 2, 255] });
    expect(out.id).toBe("p1");
    expect(out.title).toBe("页");
    expect(out.content_json).toBe("{}");
    expect(payload).toEqual({ id: "p1", title: "页", content_json: "{}" }); // 原对象没被改
  });

  it("⑧ 载荷不是普通对象（字符串/null/数组）⇒ **原样返回**（不包一层：那会静默改写老载荷的形态）", () => {
    expect(withCrdtWire("已经序列化好的", new Uint8Array([9]))).toBe("已经序列化好的");
    expect(withCrdtWire(null, new Uint8Array([9]))).toBeNull();
    expect(withCrdtWire(undefined, new Uint8Array([9]))).toBeUndefined();
    const arr = [1, 2, 3];
    expect(withCrdtWire(arr, new Uint8Array([9]))).toBe(arr);
  });
});
