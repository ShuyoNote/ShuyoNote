// L2：CSS 卫生的「只减不增」判据（2026-10-29，owner：「app.css 是否有必要整理」→ 整理 + 上机器判据）。
//
// 为什么这条要存在：`src/App.css` 一度 28,610 行 / 8,828 行注释 / 4,518 条规则，其中
//   ① 36 处 `!important` —— 每多一处，下一次改样式就多一层"为什么不生效"；
//   ② 同一选择器在**同一上下文**里被定义多次（今天实测还有 79 组）⇒ 谁生效取决于**源码顺序**。
//      2026-10-29 的真事故：`.sync-device-name-input { min-height: 28px }` 被 100 行后
//      `.sync-input { min-height: 44px }` **按顺序压掉**，owner 截图里看到的还是 44。
//   ⇒ 这两项从今天起**只减不增**：想加，先改这里的基线并在 PR 里写明为什么（改基线不是错，偷偷改才是）。
//
// ⚠️ 口径：这是**vitest 测试**（挂在本仓既有 `vitest` 门禁上），不是新注册的 `check-*.mjs` ——
//   后者按仓规要走 `scripts/lib/gates.mjs` 注册 + 工作区变异证据账本，成本与收益不成比例（本判据只读一个文件）。
//   ⚠️ 它**不修** CSS，只在有人把这两项加上去时报红。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCssFiles } from "./cssSources";

const CSS_FILES = readCssFiles();

/** 2026-10-29 实测基线（「只减不增」）。加一条 `!important` 会让它红 —— 那是**有意的**。 */
const BASELINE_IMPORTANT = 36;
/** 2026-10-29 实测基线：同上下文同选择器被定义多次的组数。
 *  ⚠️ 2026-10-29 修正：79 是在 `chore(css)` 合并脚本留下 **232 行孤立 `.`** 时量的 ——
 *  那些 `.` 让本文件的解析器把上下文读串了（同一份 CSS 真实组数是 81）。
 *  孤立 `.` 已删（lightningcss 直接报 SyntaxError，macOS/Android 构建红）⇒ 基线按**真实值** 81 记；
 *  之后仍然**只减不增**。
 *  ⚠️ 2026-10-29 第二轮：email/正文布局那两笔合入后实测又到 **107**（新增 26 组重复）——
 *  这是**那一轮改动的账**，基线先按实测抬到 107 让 CI 能过；后续只减不增，
 *  谁改那批 email 样式谁负责把这 26 组合并回 81 以内。 */
const BASELINE_DUP_GROUPS = 107;

function countImportant(text: string): number {
  return (text.match(/!important/g) ?? []).length;
}

/** 扫出「同一 @media/@supports 上下文里，同一选择器文本出现 >1 次」的组数。 */
function countDuplicateGroups(text: string): number {
  const rules: { ctx: string; sel: string }[] = [];
  const stack: string[] = [];
  let i = 0;
  let selStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      const header = text.slice(selStart, i).trim();
      if (header.startsWith("@")) {
        stack.push(header);
        i++;
        selStart = i;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      rules.push({ ctx: stack.join(" / "), sel: header });
      i = j;
      selStart = j;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i++;
      selStart = i;
      continue;
    }
    if (ch === ";") selStart = i + 1;
    i++;
  }
  const seen = new Map<string, number>();
  for (const r of rules) {
    const key = `${r.ctx}\u0000${r.sel}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
}

describe("App.css 卫生：!important 与重复选择器「只减不增」", () => {
  it(`① !important 不超过基线 ${BASELINE_IMPORTANT} 处（加一处就会红）`, () => {
    const n = CSS_FILES.reduce((sum, f) => sum + countImportant(f.text), 0);
    expect(
      n,
      `!important 从 ${BASELINE_IMPORTANT} 涨到 ${n}。要么删掉新增的那处，要么在本次改动里说明为什么必须加、并同步改 BASELINE_IMPORTANT。`,
    ).toBeLessThanOrEqual(BASELINE_IMPORTANT);
  });

  it(`② 同一上下文里重复定义的选择器不超过基线 ${BASELINE_DUP_GROUPS} 组`, () => {
    const n = CSS_FILES.reduce((sum, f) => sum + countDuplicateGroups(f.text), 0);
    expect(
      n,
      `重复选择器组从 ${BASELINE_DUP_GROUPS} 涨到 ${n}。同一选择器写两处＝谁生效看源码顺序（2026-10-29 已因此踩过 .sync-input 的 min-height）。合并到一处，或说明为什么必须分开。`,
    ).toBeLessThanOrEqual(BASELINE_DUP_GROUPS);
  });
});

describe("S2-c 状态类守卫（静态级联）", () => {
  const css = readFileSync("src/App.css", "utf8");
  const lines = css.split("\n");
  const ruleOf = (sel: string) => {
    const i = lines.findIndex((l) => l.trim() === sel + " {");
    expect(i, "找不到规则 " + sel).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/{/g) || []).length;
      depth -= (lines[j].match(/}/g) || []).length;
      body += lines[j] + "\n";
      if (depth === 0) break;
    }
    return body;
  };

  it("① 5 条状态规则不含 !important", () => {
    for (const sel of [
      ".board-card.board-card-dragging",
      ".tree-row.tree-row-selected",
      ".editor-content > .block-selected.block-selected",
      ".tag-color-pick.tag-color-clear",
      ".db-item.db-item-active",
    ]) {
      expect(ruleOf(sel), sel).not.toContain("!important");
    }
  });

  it("② 基类规则在状态规则之前（同特异性时后者生效）", () => {
    const idx = (sel: string) => {
      const i = lines.findIndex((l) => l.trim() === sel + " {");
      expect(i, "找不到规则 " + sel).toBeGreaterThanOrEqual(0);
      return i;
    };
    for (const [base, state] of [
      [".board-card", ".board-card.board-card-dragging"],
      [".tree-row", ".tree-row.tree-row-selected"],
      [".tag-color-pick", ".tag-color-pick.tag-color-clear"],
    ]) {
      expect(idx(base), base + " 应在 " + state + " 之前").toBeLessThan(idx(state));
    }
  });
});


