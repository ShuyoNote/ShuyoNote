// 空间筛选（20+ 个空间时的"眼睛在长列表里找"）· 判据 —— owner 2026-10-10 问「如何用户的空间很多，
// 比如 20+，怎么办？」
//
// ⚠️ 这一条判据同时钉**三件事**（少一件都不算交付 ✓）：
//   ① **规则只有一处实现**：`src/lib/spaceFilter.ts`；⛔ 两处各自写一份匹配 ＝ 造第二条路 ✗
//   ② **两处都真接上了**（侧栏切换器 ＋ 设置-空间）：文本级断言（真 DOM 级那半在
//      `src/components/SettingsDialog.test.tsx` 里跑 ✓，侧栏那个切换器要真 DOM 得先喂全套 store）
//   ③ **跨语言 parity**：`tests/space-name-parity.json` 的每条 case 都要过 —— 那份夹具的 `out`
//      是**从规则手推**的（见每条 `name` 里的推导来源），⛔ 不是从实现生成的 ✓
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { filterSpaces, matchSpace, normalizeSpaceName } from "./spaceFilter";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

interface ParityCase {
  name: string;
  in: number[];
  out: number[];
}
const fixture: { note: string; cases: ParityCase[] } = JSON.parse(
  read("tests/space-name-parity.json"),
);
const toStr = (cps: number[]): string => cps.map((c) => String.fromCodePoint(c)).join("");

/** 25 个空间的夹具：名字里**只有 3 个**含「项目」（判据 e）✓ */
const many = Array.from({ length: 25 }, (_, i) => ({
  id: `sp${i + 1}`,
  name: i === 4 ? "项目·阿尔法" : i === 12 ? "项目·贝塔" : i === 23 ? "项目·伽马" : `空间${i + 1}`,
}));

describe("空间名归一 · 跨语言共用夹具（tests/space-name-parity.json）", () => {
  it("夹具非空 ＋ `note` 在（口径要自证）＋ **一正一反两族都在**（否则夹具会鼓励把规则放宽）", () => {
    expect(fixture.note.length, "夹具的 `note` 是空的 ⇒ 口径没自证").toBeGreaterThan(50);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(11);
    const positive = fixture.cases.filter((c) => c.name.includes("该归")).length;
    const negative = fixture.cases.filter((c) => c.name.includes("不该归")).length;
    expect(positive, "夹具里没有『该归』那一族").toBeGreaterThanOrEqual(6);
    expect(negative, "夹具里没有『不该归』那一族 ⇒ 会鼓励把规则越折越宽").toBeGreaterThanOrEqual(3);
  });

  it("每条 case 的 `out` 都对得上（`out` 是从规则手推的，⛔ 不是从实现生成的）", () => {
    const bad: string[] = [];
    for (const c of fixture.cases) {
      const got = normalizeSpaceName(toStr(c.in));
      if (got !== toStr(c.out)) {
        bad.push(`${c.name}：得到 [${[...got].map((ch) => ch.codePointAt(0)).join(", ")}]`);
      }
    }
    expect(bad, bad.join("；")).toEqual([]);
  });

  it("⭐ 简繁**不算同名**（owner 2026-10-10 拍定）：那一对的归一结果必须**不同**", () => {
    const simple = toStr(fixture.cases.find((c) => c.name.includes("简体"))!.in);
    const trad = toStr(fixture.cases.find((c) => c.name.includes("繁体"))!.in);
    expect(normalizeSpaceName(simple)).not.toBe(normalizeSpaceName(trad));
    // 而且两侧都**没有被折**（说明差异来自"不做简繁折叠"，不是来自某处意外改动）
    expect(normalizeSpaceName(simple)).toBe(simple);
    expect(normalizeSpaceName(trad)).toBe(trad);
  });

  it("幂等：折过的文本再折一次不变", () => {
    for (const c of fixture.cases) {
      const once = normalizeSpaceName(toStr(c.in));
      expect(normalizeSpaceName(once), c.name).toBe(once);
    }
  });

  it("⭐ 与 `normalizeForMatch` 的**那一格差别**：全角标点这里要折（`，`⇒`,`）", () => {
    // ⛔ 这条挡的是"下一个人看到两个归一函数、顺手合并成一个" ✗ ——
    //    `normalizeForMatch` 文件头逐字写着「不折叠全角标点」⇒ 合并就必然改坏一侧 ✓
    expect(normalizeSpaceName("，")).toBe(",");
  });
});

describe("空间筛选 · 匹配与过滤（纯函数，一份实现）", () => {
  it("e) 20+ 夹具：输「项目」⇒ **恰好那 3 个**（⛔ 不是 25 个、也不是 1 个）", () => {
    const hit = filterSpaces(many, "项目");
    expect(hit.map((s) => s.id)).toEqual(["sp5", "sp13", "sp24"]);
  });

  it("b) **反向**：清空筛选 ⇒ 全部一个不少地回来**且顺序不变**", () => {
    expect(filterSpaces(many, "").map((s) => s.id)).toEqual(many.map((s) => s.id));
    expect(filterSpaces(many, "   ").map((s) => s.id)).toEqual(many.map((s) => s.id));
    // ⛔ 不许把不匹配的丢掉：输入数组本身不许被动（长度/顺序都不变）
    expect(many.length).toBe(25);
  });

  it("归一是**同一套**：大小写／全角／零宽／多空格的查询都能命中同一条", () => {
    const one = [{ id: "x", name: "Work Space" }];
    for (const q of ["work", "WORK", "ＷＯＲＫ", "work space", " work   space ", "wo\u200Brk"]) {
      expect(matchSpace(one[0].name, q), `查询 ${JSON.stringify(q)} 应当命中`).toBe(true);
    }
    expect(matchSpace(one[0].name, "读书")).toBe(false);
  });

  it("零命中 ⇒ 空数组（界面那半负责说人话 ＋ 给「清空」的出路 —— 见 SettingsDialog.test.tsx）", () => {
    expect(filterSpaces(many, "zzz")).toEqual([]);
  });

  it("c) **反向**：这一层**没有**「当前空间」这个维度（筛选改不动 active ⇒ 它压根碰不到）", () => {
    // 结构挡法：签名只有 `(spaces, query)`，⛔ 不接 store/activeId ✗
    const src = read("src/lib/spaceFilter.ts");
    for (const forbidden of ["activeId", "switchTo", "useSpaceStore", "setActiveWorkspaceId"]) {
      expect(src, `筛选这一层不该出现 ${forbidden}（那是切空间的事）`).not.toContain(forbidden);
    }
  });
});

describe("空间筛选 · 两处都真接上了（⛔ 别只改一处 ✗）", () => {
  const pageTree = read("src/components/PageTree.tsx");
  const settings = read("src/components/SettingsDialog.tsx");
  // 判据只判**代码**，不判注释（注释里会**引用**这些模式去解释规则 ✓）
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const pageTreeCode = code(pageTree);
  const settingsCode = code(settings);

  it("d) 两处**共用同一份匹配**（都 import 这一个模块，⛔ 各自写一份 ✗）", () => {
    for (const [who, src] of [
      ["PageTree", pageTreeCode],
      ["SettingsDialog", settingsCode],
    ] as const) {
      expect(src, `${who} 没 import 共用匹配`).toContain('from "../lib/spaceFilter"');
      expect(src, `${who} 没调用 filterSpaces`).toContain("filterSpaces(");
      // ⛔ 第二份匹配的典型形状：自己按名字做包含（大小写/全角/零宽都不可能一致）
      expect(src, `${who} 自己写了一份按名字包含的匹配`).not.toMatch(/\.name[^\n]{0,40}\.includes\(/);
    }
  });

  it("a) 两处都有**筛选输入**，且零命中时**说人话 ＋ 给清空的出路**", () => {
    expect(pageTreeCode, "侧栏切换器没有筛选框").toContain("space-switcher-filter");
    expect(settingsCode, "设置-空间没有筛选框").toContain("set-space-filter");
    for (const [who, src] of [
      ["PageTree", pageTreeCode],
      ["SettingsDialog", settingsCode],
    ] as const) {
      expect(src, `${who} 零命中时没说人话`).toContain("没有匹配的空间");
      expect(src, `${who} 零命中时没给"清空筛选"的出路`).toContain("清空筛选");
    }
  });

  it("f) 侧栏那个筛选框在**两种形态共用**的位置（⛔ 不在 `is-sheet` 的某一支里 ✗）", () => {
    // 结构挡法：筛选框必须出现在**列表之前**（＝切换器头与列表之间那一段，两形态共用 ✓）
    const atFilter = pageTreeCode.indexOf("space-switcher-filter");
    const atList = pageTreeCode.indexOf("space-switcher-list");
    expect(atFilter, "找不到筛选框").toBeGreaterThan(-1);
    expect(atList, "找不到列表").toBeGreaterThan(-1);
    expect(atFilter, "筛选框在列表之后 ⇒ 多半被塞进某个分支里了").toBeLessThan(atList);
  });

  it("⛔ 不做「最近使用排序」（那是另一笔）：这一层与两处都**不排序**", () => {
    const src = read("src/lib/spaceFilter.ts");
    expect(src).not.toMatch(/\.sort\(/);
    expect(pageTreeCode).not.toMatch(/lastUsed|recentSpace|最近使用/);
    expect(settingsCode).not.toMatch(/lastUsed|recentSpace|最近使用/);
  });
});
