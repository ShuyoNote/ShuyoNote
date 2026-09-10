import { THEME_TOKENS } from "./capabilities/theme.meta";
import type { PluginMeta } from "../types";

/**
 * 主题插件的宿主侧解析与应用（M11.9）。
 *
 * 主题就是一组 CSS 变量，但它有两个必须由宿主负责的性质：
 *   1. **值是安全边界**——它们会被写进页面样式，一个 `url(` 就能让主题插件对外发请求
 *      （本项目「绝不跟踪」的口子）。所以这里再筛一遍，不假设后端已经筛过。
 *   2. **同一变量只能有一个赢家**——多个主题插件同时启用时，靠"谁最后加载"决定结果
 *      是不确定的；这里按插件 id 排序取第一个，并把冲突**报出来**让用户知道。
 */

export interface PluginThemeDecl {
  name?: string;
  tokens: Record<string, string>;
}

export interface ResolvedTheme {
  /** 将要应用的变量（单一赢家）。 */
  tokens: Record<string, string>;
  /** 提供了该变量的插件 id（用于排查"谁改了我的颜色"）。 */
  winners: Record<string, string>;
  /** 被其它插件抢先的变量（宿主不会静默丢掉这个事实）。 */
  conflicts: { token: string; winner: string; loser: string }[];
  /** 声明了主题的插件名（界面提示用）。 */
  sources: { id: string; name: string; tokens: number }[];
}

const KIND_OF = new Map(THEME_TOKENS.map((t) => [t.name, t.kind]));

/** 与 Rust `validate_theme_value` 同一套规则（值会被写进样式，所以两边都要挡）。 */
export function isValidThemeValue(name: string, raw: string): boolean {
  const kind = KIND_OF.get(name);
  if (!kind) return false; // 白名单外
  const v = (raw ?? "").trim();
  if (!v || v.length > 64) return false;
  const lower = v.toLowerCase();
  for (const bad of ["url(", "@", ";", "{", "}", "<", ">", "\\", "\n", "/*"]) {
    if (lower.includes(bad)) return false;
  }
  if (kind === "color") {
    if (/^#[0-9a-f]{3,8}$/.test(lower)) return true;
    if (/^(rgb|rgba|hsl|hsla)\(/.test(lower)) return true;
    if (["transparent", "currentcolor", "inherit"].includes(lower)) return true;
    return /^[a-z]+$/.test(lower);
  }
  if (kind === "length") {
    if (lower === "0") return true;
    return /^[0-9.]+(px|em|rem|%)$/.test(lower);
  }
  return true;
}

/**
 * 把启用插件声明的主题合并成一份可应用的变量表。
 *
 * @param plugins 插件清单（顺序无所谓：赢家按**插件 id 排序**决定，与加载顺序无关）
 */
export function resolveTheme(plugins: PluginMeta[]): ResolvedTheme {
  const tokens: Record<string, string> = {};
  const winners: Record<string, string> = {};
  const conflicts: ResolvedTheme["conflicts"] = [];
  const sources: ResolvedTheme["sources"] = [];

  const themed = plugins
    .filter((p) => p.enabled && p.theme && Object.keys(p.theme.tokens ?? {}).length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const p of themed) {
    let accepted = 0;
    for (const [name, value] of Object.entries(p.theme!.tokens)) {
      if (!isValidThemeValue(name, value)) continue; // 防御性再筛一遍
      if (winners[name]) {
        conflicts.push({ token: name, winner: winners[name], loser: p.id });
        continue;
      }
      winners[name] = p.id;
      tokens[name] = value.trim();
      accepted += 1;
    }
    if (accepted > 0) sources.push({ id: p.id, name: p.name, tokens: accepted });
  }
  return { tokens, winners, conflicts, sources };
}

/**
 * 把解析结果写进页面样式。`prev` 是上一次应用的变量——**不在新集合里的必须移除**，
 * 否则停用插件后颜色会留在界面上（用户会以为主题坏了）。
 */
export function applyThemeTokens(next: Record<string, string>, prev: Record<string, string>): void {
  const root = document.documentElement;
  for (const name of Object.keys(prev)) {
    if (!(name in next)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(next)) {
    root.style.setProperty(name, value);
  }
}
