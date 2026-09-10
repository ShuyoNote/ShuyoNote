import type { PluginCommandParam } from "../types";

/**
 * 把参数表单的值整理成命令参数（JSON 字符串）。
 *
 * 为什么单独一层：这是**作者声明的 schema** 与**用户填的值**之间唯一的转换点。
 * 放在组件里就只能靠手点验证；抽成纯函数后规则可被测住。
 *
 * 三条规则值得记牢：
 *   - **必填留空 → 报错**，而不是悄悄传空串（空串常常是有效值，传下去等于替用户做主）；
 *   - **非必填留空 → 不传这个键**（让插件自己按"没给"处理，例如用它的默认值）；
 *   - **boolean 永远传布尔值**（复选框没勾就是 `false`，不是"未填"）。
 */
export function buildCommandArgs(
  params: PluginCommandParam[],
  values: Record<string, unknown>,
): { ok: true; json: string } | { ok: false; error: string } {
  const args: Record<string, unknown> = {};
  for (const p of params) {
    const label = p.label || p.name;
    const raw = values[p.name];

    if (p.type === "boolean") {
      args[p.name] = raw === true || raw === "true";
      continue;
    }

    const text = raw === undefined || raw === null ? "" : String(raw);
    if (text === "") {
      if (p.required) return { ok: false, error: `「${label}」是必填项` };
      continue;
    }

    if (p.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `「${label}」需要一个数字` };
      args[p.name] = n;
    } else {
      args[p.name] = text;
    }
  }
  return { ok: true, json: JSON.stringify(args) };
}

/** 表单初始值：有默认值就预填，布尔默认 false，其余留空。 */
export function initialParamValues(params: PluginCommandParam[]): Record<string, string | boolean> {
  const init: Record<string, string | boolean> = {};
  for (const p of params) {
    if (p.type === "boolean") {
      init[p.name] = p.default === true || p.default === "true";
    } else if (p.default === undefined || p.default === null) {
      init[p.name] = "";
    } else {
      init[p.name] = String(p.default);
    }
  }
  return init;
}
