// L2：`@layer` 层序判据（S2，2026-10-31）。
//
// 为什么要有它：S2 把 App.css 的**全部既有规则**包进 `@layer legacy`，新代码写进
// `@layer utilities` —— 这是"新样式天然压过旧样式、不许再加 `!important`"的前提。
// 但没有门禁时，下一个人只要：
//   ① 在文件顶部以外再写一条 `@layer legacy, utilities;`（层序会被第一条定死）；
//   ② 把新规则写回文件末尾（层外）—— 层外 > 分层 ⇒ 会把 legacy/utilities 全压掉；
//   ③ 把 excalidraw / KaTeX 的覆盖挪进 legacy —— 那两条第三方 CSS 是**懒加载的未分层样式**，
//      覆盖一进层就失效（计划 §9.3 S2 的唯一例外，2026-10-31 逐条搬到层外为的就是它）；
// 视觉就可能悄悄坏掉，而现有门禁（tsc / vitest 组件测试 / cssHygiene）**都看不见**。
//
// 口径：只读 `src/App.css` 的**文本结构**；层叠语义由浏览器保证，这里钉的是"文件形状不会被下一次改动破坏"。
// 真视觉验收仍走 `node scripts/css-visual-baseline.mjs --compare <基线>`（S0 工具）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/App.css", "utf8");

type TopNode = { kind: "rule" | "atrule" | "stmt"; header: string; start: number; end: number };

/** 顶层节点扫描（与 cssHygiene 同一套文本口径；不引第三方解析器）。 */
function topLevelNodes(text: string): TopNode[] {
  const nodes: TopNode[] = [];
  const n = text.length;
  let i = 0;
  let stmtStart = 0;
  const skipWs = (p: number) => {
    while (p < n && /\s/.test(text[p])) p++;
    return p;
  };
  const skipComment = (p: number) => {
    const e = text.indexOf("*/", p + 2);
    return e < 0 ? n : e + 2;
  };
  const skipString = (p: number) => {
    const q = text[p];
    p++;
    while (p < n && text[p] !== q) {
      if (text[p] === "\\") p++;
      p++;
    }
    return p + 1;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") { i = skipComment(i); continue; }
    if (ch === '"' || ch === "'") { i = skipString(i); continue; }
    if (ch === "{") {
      const start = skipWs(stmtStart);
      const header = text.slice(start, i).trim();
      let d = 1;
      let j = i + 1;
      while (j < n && d > 0) {
        const c = text[j];
        if (c === "/" && text[j + 1] === "*") { j = skipComment(j); continue; }
        if (c === '"' || c === "'") { j = skipString(j); continue; }
        if (c === "{") d++;
        else if (c === "}") d--;
        j++;
      }
      nodes.push({ kind: header.startsWith("@") ? "atrule" : "rule", header, start, end: j });
      i = j;
      stmtStart = j;
      continue;
    }
    if (ch === ";") {
      const start = skipWs(stmtStart);
      const header = text.slice(start, i).trim();
      if (header) nodes.push({ kind: "stmt", header, start, end: i + 1 });
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  return nodes;
}

/** 去掉前导注释，只留选择器（规则头里可能挂着“上一段的注释”）。 */
const selectorOf = (header: string) => header.replace(/\/\*[\s\S]*?\*\//g, "").trim();
/** 取一个 at-rule 块的内部文本（`{` 与最后一个 `}` 之间）。 */
function innerOf(node: TopNode, text: string): string {
  const open = text.indexOf("{", node.start);
  return text.slice(open + 1, node.end - 1);
}

const nodes = topLevelNodes(css);
const layerStatements = nodes.filter((x) => x.kind === "stmt" && selectorOf(x.header).startsWith("@layer"));
const legacy = nodes.filter((x) => x.kind === "atrule" && selectorOf(x.header).replace(/\s+/g, " ").trim() === "@layer legacy");
const utilities = nodes.filter((x) => x.kind === "atrule" && selectorOf(x.header).replace(/\s+/g, " ").trim() === "@layer utilities");
const topLevelRules = nodes.filter((x) => x.kind === "rule");
/** 层外的第三方覆盖（S2 的唯一例外）：选择器里出现 excalidraw / .katex 的顶层规则。 */
const vendorOutside = topLevelRules.filter((x) => /excalidraw|\.katex/.test(selectorOf(x.header)));
const unexpectedTopLevel = topLevelRules.filter((x) => !vendorOutside.includes(x));

describe("App.css 级联层序（S2）", () => {
  it("① 顶部先声明层序 `@layer legacy, utilities;`，legacy 在前、utilities 在后", () => {
    expect(layerStatements.length, "层序声明应恰好一条（多一条＝层序可能被提前定死）").toBe(1);
    // 扫描器把结尾的 `;` 留在节点外 ⇒ header 里没有分号
    expect(selectorOf(layerStatements[0].header).replace(/\s+/g, " ").trim()).toBe("@layer legacy, utilities");
    expect(layerStatements[0].start).toBeLessThan(legacy[0].start);
    expect(layerStatements[0].start).toBeLessThan(utilities[0].start);
  });

  it("② 恰好一个 legacy 块 / 一个 utilities 块；层外顶层规则只能是 vendor 例外", () => {
    expect(legacy.length, "legacy 层块应恰好一个").toBe(1);
    expect(utilities.length, "utilities 层块应恰好一个").toBe(1);
    expect(legacy[0].start).toBeLessThan(utilities[0].start);
    expect(
      unexpectedTopLevel.map((x) => selectorOf(x.header).slice(0, 60)),
      "有规则落在层外（层外 > 分层 ⇒ 会把 legacy/utilities 全压掉）。写进 @layer utilities，或（第三方覆盖）放进文件末尾的 unlayered 段。",
    ).toEqual([]);
  });

  it("③ excalidraw / KaTeX 的覆盖必须在 legacy 层外（懒加载的未分层第三方 CSS 比分层强）", () => {
    const legacyEnd = legacy[0].end;
    for (const rule of vendorOutside) {
      expect(rule.start, `第三方覆盖在 legacy 层内：${selectorOf(rule.header).slice(0, 80)}`).toBeGreaterThan(legacyEnd);
    }
    // excalidraw 2 条 + KaTeX 5 条 = 7 条；少于 7 条说明整段被误删/误搬
    expect(vendorOutside.length, "第三方覆盖段不完整（应 ≥7 条）").toBeGreaterThanOrEqual(7);
  });

  it("④ utilities 层只放白名单里的状态规则（试点批 + 2026-10-31 的绿点；扩批要同步改白名单 + 补视觉基线）", () => {
    const inner = innerOf(utilities[0], css);
    const utilRules = topLevelNodes(inner).filter((x) => x.kind === "rule");
    const allowed =
      /^\.is-(dragging-block|sidebar-resizing|ai-resizing)\b|^\.mcp-access-dot\.is-live$/;
    const bad = utilRules.map((x) => selectorOf(x.header)).filter((s) => !allowed.test(s));
    expect(bad, "utilities 层出现试点外的选择器").toEqual([]);
    expect(utilRules.length, "试点批应 ≥5 条规则").toBeGreaterThanOrEqual(5);
  });
});

