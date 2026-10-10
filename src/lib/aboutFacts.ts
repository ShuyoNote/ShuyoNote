import pkg from "../../package.json";

/**
 * **「关于」屏的机器事实**（效果图 `10-about.svg`，规格 §4.10）。
 *
 * 为什么单独一个模块：这三条都是"**别写字面量**"的数据 ✓ ——
 * 效果图上写的版本号已经过期过一次（图上 `1.92.5`、当时实际 `1.92.6` ✗，见规格 §4.10 的订正行）
 * ⇒ 凡是能从 `package.json` 现取的就现取 ✓，取不到的（`LICENSE` 行数）**由测试对着真文件核** ✓
 * （`src/lib/aboutFacts.test.ts` ✓）。
 */

/**
 * 12 项开源组件（效果图那张「开源组件致谢（取自 package.json）」卡 ✓）
 * —— 左边是**图上的显示名**，右边是它在 `package.json.dependencies` 里的键 ✓。
 *
 * ⚠️ 顺序**照图**（图是两列；这里保持"先左列 6 项、再右列 6 项"的取出顺序 ✓）。
 */
const COMPONENT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Tauri", "@tauri-apps/api"],
  ["Lexical", "lexical"],
  ["React", "react"],
  ["Mermaid", "mermaid"],
  ["Excalidraw", "@excalidraw/excalidraw"],
  ["Yjs", "yjs"],
  ["KaTeX", "katex"],
  ["PDF.js", "pdfjs-dist"],
  ["Zustand", "zustand"],
  ["Tesseract.js", "tesseract.js"],
  ["DOMPurify", "dompurify"],
  ["i18next", "i18next"],
];

const deps: Record<string, string> = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};

/**
 * 版本区间 → 图上那种 `major.minor` ✓（`^2.11.1` ⇒ `2.11`；`0.18.1` ⇒ `0.18`）。
 * ⚠️ 取不到就返回 `—`，⛔ **不编造** ✓。
 */
function majorMinor(range: string | undefined): string {
  const m = String(range ?? "").match(/(\d+)(?:\.(\d+))?/);
  if (!m) return "—";
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/** 图上那 12 项 ＋ 各自从 `package.json` **现取**的 `major.minor` ✓。 */
export const ABOUT_COMPONENTS = COMPONENT_KEYS.map(([label, key]) => ({
  key,
  label,
  version: majorMinor(deps[key]),
}));

/** `dependencies` 的总项数（图上页脚写 `共 34 项` ✓ —— 由测试核它跟 `package.json` 一致 ✓）。 */
export const ABOUT_DEPS_TOTAL = Object.keys(deps).length;

/**
 * `LICENSE` 的**行数**（图上写 `全文见仓库根 LICENSE（661 行）` ✓）。
 *
 * ⚠️ 为什么是常量而不是现算：`LICENSE` 在**仓根**，`?raw` 导入本仓**一处都没用过** ✗
 *    （且 `tsconfig` 里没有 `vite/client` 的类型 ⇒ 走它要动构建配置，超出本屏范围 ✗）。
 *    ⇒ 取值改成**由测试钉住**：`src/lib/aboutFacts.test.ts` 用 `node:fs` 数真文件的字节/行数，
 *    对不上就红 ✓（这比"运行时现算"更符合本仓"判据要能拦人"的口径 ✓）。
 */
export const ABOUT_LICENSE_LINES = 661;
