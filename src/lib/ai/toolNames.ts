// 能力 id ⇄ **发给模型的 function name**（两套名字之间的那一层转换 ✓）。
//
// ⚠️ 为什么必须有这一层（2026-10-06，owner 截图里的**真原因** ✓）：
//   能力 id 用的是「命名空间.动作」形态（`pages.get` / `blocks.append` …）✓ ——
//   MCP 工具面、草稿、审计、能力注册表全用它，改 id 等于动整条链 ✗；
//   而 OpenAI 兼容接口对 `function.name` 的要求是 **`^[a-zA-Z0-9_-]+$`** ✓ —— **点号不合法** ✗✗。
//   DeepSeek 会直接回 400，逐字：
//     `Invalid 'tools[0].function.name': string does not match pattern.`
//     `Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`
//   ⇒ 于是**只要这次请求带工具，就一定 400** ✗（编辑器的「用 AI 写作」就是这样 ✗）。
//   ⇒ 出网前把 `.` 换成 `_` ✓；收到模型回来的调用时**查表换回内部 id** ✓（⛔ 猜不得：`_` 有歧义 ✗）。
//
// ⚠️ 反向转换**只查表、不做字符串猜测** ✓：万一将来某个内部 id 自带下划线 ✗，
//   `_ ⇒ .` 那种"猜回来"会把两个 id 搞混 ✗ ⇒ 一律用 `buildToolNameMap()` 得到的表 ✓。

/** 接口对 function name 的要求（照上游报错里给的正则 ✓）。 */
export const WIRE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 单个 id ⇒ 出网名（`.` 换成 `_` ✓）。不需要映射表的场合用它 ✓。 */
export function toWireToolName(id: string): string {
  return id.replace(/\./g, "_");
}

export interface ToolNameMap {
  /** 内部 id ⇒ 出网名 ✓ */
  toWire: Map<string, string>;
  /** 出网名 ⇒ 内部 id ✓ */
  toId: Map<string, string>;
  /** 出网名**不合规**的 id（理论上不该有 ⇒ 有就是判据该红 ✓） */
  bad: string[];
  /** 两个 id 撞到同一个出网名 ✗（例如同时存在 `a.b` 与 `a_b`） */
  collisions: string[];
}

/** 由内部 id 清单建双向表 ✓（`host.ts` 建一次、反复用 ✓）。 */
export function buildToolNameMap(ids: readonly string[]): ToolNameMap {
  const toWire = new Map<string, string>();
  const toId = new Map<string, string>();
  const bad: string[] = [];
  const collisions: string[] = [];
  for (const id of ids) {
    const wire = toWireToolName(id);
    if (!WIRE_NAME_RE.test(wire)) bad.push(id);
    const prev = toId.get(wire);
    if (prev !== undefined && prev !== id) collisions.push(wire);
    toWire.set(id, wire);
    toId.set(wire, id);
  }
  return { toWire, toId, bad, collisions };
}

/**
 * 模型回来的名字 ⇒ 内部 id ✓。
 * 先查表（出网名 ✓）；查不到就**原样返回** —— 因为文本形态的工具调用里模型可能直接写了
 * 内部 id（系统提示里教的就是那个名字 ✓），也可能写了个不存在的名字（上层会用白名单挡掉 ✓）。
 */
export function toInternalToolId(name: string, map: ToolNameMap): string {
  const n = String(name ?? "").trim();
  return map.toId.get(n) ?? n;
}
