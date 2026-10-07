// 第 2 招「左侧 11 项 → 4 组」的判据（owner 2026-10-08 看过效果图后拍板 ✓）。
//
// 守的是**分组这件事本身**最容易出的三种错（都是"看着没事、实际很坏"✓）：
//   ① **弄丢项** —— 分组是用 `TABS.filter(group === g.id)` 渲染的 ⇒ 某项的 group 写错/漏写，
//      它就从导航里**消失**了 ✗（不报错、不炸、测试全绿 ✓）；
//   ② **重复项** —— 同一 id 出现在两组 ⇒ 导航里出现两次 ✗；
//   ③ **空分组** —— 声明了组却没有项 ⇒ 渲染时空标题（组件里已 `return null` ✓，这里再钉一道 ✓）。
// 外加一条**翻译**判据：四个组标题的 i18n key 必须在 zh/en 两份里都存在 ✓
//   （少一个 ⇒ 界面上直接显示 key 原文，是**用户可见的坏文案** ✗ —— 本仓踩过同形的坑 ✓）。
//
// ⚠️ 顺序不写死、条数不写死 ✓：断言的是"**导航里出现的是 TABS 的一个排列**"✓
//    ⇒ 将来谁加分区、调顺序，这条判据**不会误红** ✓，但丢项/重复一定红 ✓。

import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, TABS } from "./SettingsDialog";
import zh from "../i18n/locales/zh";
import en from "../i18n/locales/en";

describe("设置面板左侧分组（第 2 招）", () => {
  it("★ 每个分区都属于一个**已声明**的组（⛔ 写错组名 ⇒ 那一项会当场从导航里消失 ✗）", () => {
    const known = new Set(SETTINGS_GROUPS.map((g) => g.id));
    const orphans = TABS.filter((t) => !known.has(t.group as never)).map((t) => t.id);
    expect(orphans, "这些分区的 group 不在 SETTINGS_GROUPS 里 ✗（它们会从导航里消失）").toEqual([]);
  });

  it("★ 导航里出现的项 = TABS 的一个排列（既**不丢**也不**重复** ✓）", () => {
    const rendered = SETTINGS_GROUPS.flatMap((g) => TABS.filter((t) => t.group === g.id).map((t) => t.id));
    expect(rendered.length, "渲染出来的项数与 TABS 不一致 ⇒ 有项被漏掉或被重复渲染 ✗").toBe(TABS.length);
    expect(new Set(rendered).size, "有分区在导航里出现了两次 ✗").toBe(TABS.length);
    expect(new Set(rendered)).toEqual(new Set(TABS.map((t) => t.id)));
  });

  it("★ 没有空分组（声明了却一项都没有 ⇒ 会画出空标题 ✗）", () => {
    for (const g of SETTINGS_GROUPS) {
      expect(TABS.filter((t) => t.group === g.id).length, "分组「" + g.id + "」一项都没有 ✗").toBeGreaterThan(0);
    }
  });

  it("★ 组 id 唯一、顺序与声明一致（顺序是「人读的顺序」，不该被渲染打乱 ✓）", () => {
    const ids = SETTINGS_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["basic", "collab", "ai", "system"]);
  });

  it("★★ 四个组标题在 **zh 与 en 两份 locale 里都存在**（少一个 ⇒ 界面显示 key 原文 ✗）", () => {
    const pick = (loc: unknown, key: string): unknown =>
      key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), loc);
    for (const g of SETTINGS_GROUPS) {
      for (const [name, loc] of [["zh", zh], ["en", en]] as const) {
        const v = pick(loc, g.labelKey);
        expect(typeof v, name + " 里缺 " + g.labelKey + " ✗").toBe("string");
        expect(String(v).length).toBeGreaterThan(0);
      }
    }
  });
});
