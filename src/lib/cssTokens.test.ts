// L2：CSS token 判据（S3，2026-10-31）。
//
// 三件事：
//   ① `src/styles/tokens.css` / `tokens.d.ts` 必须与 `tokens.json` 的生成结果**逐字节一致**
//      （改 tokens 只能改 json + 跑生成器；手改生成物会红）。
//   ② 全仓 CSS 里 `var(--x)` 用到的变量必须**有定义**（或由 JS 运行时注入，白名单见下）。
//      来由：App.css 有 26 个"用了但没定义"的变量 —— 浏览器**静默丢弃**那行声明，
//      排查时看不出错（"为什么这个颜色没生效"）。S3 的硬目标是把它们清零；
//      在清零完成前用**冻结清单**只减不增，防新增。
//   ③ `font-size: Npx` 的字面量**只减不增**（S3 逐批换成 `var(--fs-N)`）。
//      S3 第一批已把 12/13px 换掉（585 处），剩余 577 处冻结；下一批继续降。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadTokens, renderCss, renderDts } from "../../scripts/gen-css-tokens.mjs";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** 由 JS 运行时注入的变量（`style.setProperty`），不算"未定义"。 */
const RUNTIME_VARS = new Set([
  "--ai-w", // AiAssistantPanel.tsx:74
  "--toc-w", // TableOfContents.tsx:65
  "--sidebar-w", // PageTree.tsx:1094
  "--sidebar-offset", // PageTree.tsx:1095
  "--titlebar-h", // TitleBar.tsx:113/116
  "--accent",
  "--accent-soft",
  "--accent-strong", // store/theme.ts:67-70（主题强调色）
  "--sat",
  "--sar",
  "--sab",
  "--sal",
  "--kb", // viewportInsets.ts:120（窗口 inset / 软键盘）
  "--fill", // FileManagerView.tsx:972（内联样式注入）
]);

/** 冻结清单：**已清零**（2026-10-31 批 7）。历史：S3 开始时 26 条，修正扫描口径后真 14，
 *  批 1–2 清掉 5 条（`--plugin-panel-w`、`--bg-2/--border-faint/--fill-soft/--text-muted` 只有兜底用点），
 *  批 7 按 owner「3」清掉最后 9 条：
 *    B 改名 7 → `--primary`→`--accent`、`--hover-soft`→`--hover`、`--block`→`--codeblock-bg`、
 *      `--text-2`→`--text-dim`、`--surface-2`→`--card-bg`、`--surface-light`→`--card-bg`、
 *      `--bg-1`→`--surface`（`sync-badge` 的文字一处改 `--on-accent`）
 *    C 定义 2 → `--radius: var(--radius-md)`、`--font-mono: 等宽栈`（都在 App.css 的 `:root`）
 *  ⇒ 现在「用了但没定义」必须是 **0** —— 新增一个就会红（浏览器会静默丢弃那行声明）。
 * 分档依据与视觉风险见 `_tmp/acceptance/css-undefined-vars-2026-10-31.md`。 */
const KNOWN_UNDEFINED = new Set<string>([]);

describe("CSS tokens（S3）", () => {
  it("① tokens.css / tokens.d.ts 与 tokens.json 的生成结果逐字节一致", () => {
    const tokens = loadTokens();
    expect(read("src/styles/tokens.css"), "tokens.css 是生成物：改 tokens.json 后跑 `node scripts/gen-css-tokens.mjs`").toBe(
      renderCss(tokens),
    );
    expect(read("src/styles/tokens.d.ts"), "tokens.d.ts 同上").toBe(renderDts(tokens));
  });

  it("② 全仓 CSS 的 var(--x) 都有定义（运行时注入白名单除外），且未定义集合不超过冻结清单", () => {
    // ⚠️ 必须先剥注释再扫：注释里的 `var(--x)` 不是使用（2026-10-31 修：--brand 曾因此假阳性）。
    const text = ["src/App.css", "src/styles/mcp-panel.css", "src/styles/tokens.css"]
      .map(read)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const used = [...new Set([...text.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
    // 定义匹配**不要**行首锚：App.css 有一行两个定义（`--cat-x: …; --cat-x-soft: …;`）和
    // 作用域内定义（`.pdf-reader.eye-* { --eye-*: … }`），带 `^` 会把它们判成未定义。
    const defined = new Set([...text.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)].map((m) => "--" + m[1]));
    const undefinedVars = used.filter((v) => !defined.has(v) && !RUNTIME_VARS.has(v));
    const unexpected = undefinedVars.filter((v) => !KNOWN_UNDEFINED.has(v));
    expect(unexpected, "新增了「用了但没定义」的变量 ⇒ 那行声明会被浏览器静默丢弃；要么定义它，要么改用已有 token").toEqual([]);
    expect(
      undefinedVars.length,
      `未定义变量 ${undefinedVars.length} 个 > 冻结值 ${KNOWN_UNDEFINED.size}（S3 只减不增）`,
    ).toBeLessThanOrEqual(KNOWN_UNDEFINED.size);
  });

  it("③ font-size 字面量只剩注释里的提及（整数＋半像素全部 token 化）", () => {
    const css = read("src/App.css");
    const literals = (css.match(/font-size:\s*[0-9.]+px/g) ?? []).length;
    // 2026-10-31：批次 1（12/13px 585）→ 批次 3（其余整数 445）→ 批次 6（半像素 128）之后，
    //   只剩注释里提及的 4 处（不是设置字号）。
    expect(literals, `font-size 字面量 ${literals} > 冻结值 4（只减不增；新样式请用 var(--fs-N)）`).toBeLessThanOrEqual(4);
    // 剥掉注释后**一个 px 字号都不许有**（整数/半像素一视同仁）。
    const noComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const left = [...noComment.matchAll(/font-size:\s*[0-9.]+px/g)].map((m) => m[0]);
    expect(left, `px 字号还在：${left.join(" / ")}`).toEqual([]);
  });

  it("④ 间距（padding/margin/gap 系列）里恰好等于 --space-1..8 的 px 已全换 token（负值/小数除外）", () => {
    const css = read("src/App.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const declRe =
      /(?:^|[;{])\s*((?:padding|margin)(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap)\s*:\s*([^;{}]+)(?=[;}])/g;
    const left: string[] = [];
    for (const m of css.matchAll(declRe)) {
      // 负值（-8px）与小数（0.5px）不要求 token：`-var(...)` 不是合法 CSS。
      if (/(?<![\d.\-])(?:4|8|12|16|24|32|40|64)px\b/.test(m[2])) left.push(`${m[1]}: ${m[2].trim()}`);
    }
    expect(left, "间距值等于 --space-1..8 却还在写字面量 px").toEqual([]);
    // 只增不减：批次 4 之后**剥注释**实测 1,399 处（原文 1,401，其中 2 处是注释里的提及）。
    const usages = (css.match(/var\(--space-/g) ?? []).length;
    expect(usages, `var(--space-*) 用量 ${usages} < 冻结值 1399`).toBeGreaterThanOrEqual(1399);
  });

  it("⑤ border-radius 里等于 --radius-xs/sm/md/lg/full 的 px 已全换 token", () => {
    const css = read("src/App.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const left: string[] = [];
    for (const m of css.matchAll(/border-radius\s*:\s*([^;{}]+)/g)) {
      // 4/6/8/12/999 分别对应 radius-xs/sm/md/lg/full；小数（0.5px）不要求 token。
      if (/(?<![\d.\-])(?:4|6|8|12|999)px\b/.test(m[1])) left.push(m[1].trim());
    }
    expect(left, "border-radius 值等于现成 radius token 却还在写字面量 px").toEqual([]);
    // 只增不减：2026-10-31 批次 5 之后实测 632 处。
    const usages = (css.match(/var\(--radius-/g) ?? []).length;
    expect(usages, `var(--radius-*) 用量 ${usages} < 冻结值 632`).toBeGreaterThanOrEqual(632);
  });
});

