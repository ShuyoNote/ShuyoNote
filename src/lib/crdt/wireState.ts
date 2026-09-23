// 冲刺切片 **S4b-0**：wire 载荷里**CRDT 状态字段的形状与版本标记**（纯函数，唯一实现）。
//
// 为什么先只做这一层：同步路径（`recordChange` / `applyChange` / 服务端）是**别人也在用**的东西 ——
// 先把"载荷长什么样、缺字段怎么降级、版本不认识怎么办"钉成可判据的纯函数，再去接线，
// 接线那一轮就只剩"在哪里调它"，不用同时发明语义。
//
// 三条口径（写清楚，免得接线时各自理解）：
//   ① **没有状态就不发空壳**：`encode(undefined) === undefined`（老客户端/还没建血统的页面照旧）；
//   ② **缺字段 ≠ 空状态**：`decode` 对"没有这一项"回 `{kind:"none"}` —— 调用方走**今天那条路**，
//      这叫作**如实降级**，不是"用一个空状态顶替"（那会静默把内容抹掉）；
//   ③ **版本不认识就如实说**：回 `{kind:"unknown-version", v}`，**不许**当成 v1 猜着解
//      （猜错的后果是静默丢块）。
//
// ⚠️ 这一层不认识"落盘形态/投影"（那是 `yDocBridge` / `docContent` 的事），只管字节怎么放进载荷。
// ⚠️ 它**不是**"文档内容的那一层" ⇒ 不许出现那三个存储字面量（名字里也不行）。
import { CRDT_WIRE_VERSION } from "./wireConstants";

/** 载荷里的那一项。`v` 是**版本标记**：服务端/对端靠它决定"认不认识"。 */
export interface CrdtWireState {
  v: number;
  state: number[];
}

export type DecodedWireState =
  | { kind: "none" } // 载荷里没有这一项（老载荷）⇒ 调用方走今天那条路
  | { kind: "ok"; state: Uint8Array } // 解出来了
  | { kind: "unknown-version"; v: number }; // 版本不认识 ⇒ **不猜**

/** 状态 ⇒ 载荷字段。**没有状态 ⇒ `undefined`**（不发空壳）。 */
export function encodeCrdtWire(state: Uint8Array | null | undefined): CrdtWireState | undefined {
  if (!state || state.length === 0) return undefined;
  return { v: CRDT_WIRE_VERSION, state: Array.from(state) };
}

/** 载荷字段 ⇒ 状态。四种结果，**没有 `undefined`**（"没有"与"不认识"必须分得开）。 */
export function decodeCrdtWire(raw: unknown): DecodedWireState {
  if (raw === null || raw === undefined) return { kind: "none" };
  if (typeof raw !== "object") return { kind: "none" };
  const o = raw as { v?: unknown; state?: unknown };
  const v = typeof o.v === "number" ? o.v : NaN;
  if (v !== CRDT_WIRE_VERSION) return { kind: "unknown-version", v };
  if (!Array.isArray(o.state)) {
    throw new Error("decodeCrdtWire: 版本是已知的，但 `state` 不是数组 —— 载荷坏了，如实报错（不静默当成空）");
  }
  const out = new Uint8Array(o.state.length);
  for (let i = 0; i < o.state.length; i += 1) {
    const b = o.state[i];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new Error(`decodeCrdtWire: 载荷里第 ${i} 个字节不是 0..255 的整数 —— 如实报错（不静默截断）`);
    }
    out[i] = b;
  }
  return { kind: "ok", state: out };
}
