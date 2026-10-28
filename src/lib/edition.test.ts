// ⭐ **2026-10-29（owner 拍）：团队功能冻结** 的唯一开关 —— 判据。
//
// 这一层判**常量与语义**（`TEAM_EDITION_ARCHIVED`）；"每个隐藏点都读它"由
// `src/components/teamEditionFrozen.wiring.test.tsx` 钉着 ✓（两层合起来才叫"可逆的冻结"）。
import { describe, expect, it } from "vitest";

import {
  TEAM_EDITION_ARCHIVED,
  TEAM_EDITION_ARCHIVED_NOTE,
  teamConfigEntryVisible,
} from "./edition";

describe("团队功能冻结（2026-10-29 owner 拍：sync-server 已归档）", () => {
  it("① 唯一开关现在是「冻结」状态（改回 false 就是解冻 —— 只有一个地方要改）", () => {
    expect(TEAM_EDITION_ARCHIVED, "冻结开关必须是 true（owner 2026-10-29 拍：sync-server 已归档）").toBe(true);
    expect(
      teamConfigEntryVisible(),
      "冻结期间**团队新建/配置入口**一律不显示（⛔ 不许只藏一半 ✗）",
    ).toBe(false);
  });

  it("② 解冻路径可测：传 archived=false ⇒ 入口回来（⛔ 不是把代码删了 ✗）", () => {
    expect(teamConfigEntryVisible(false), "传 false 必须恢复显示（可逆 ✓）").toBe(true);
    expect(teamConfigEntryVisible(true)).toBe(false);
  });

  it("③ 冻结注记说清三件事：已冻结 / sync-server 已归档 / 旧配置仍可用", () => {
    expect(TEAM_EDITION_ARCHIVED_NOTE).toContain("冻结");
    expect(TEAM_EDITION_ARCHIVED_NOTE).toContain("sync-server 已归档");
    expect(TEAM_EDITION_ARCHIVED_NOTE).toContain("旧配置仍可同步");
    // ⛔ 自己写的文案不许带 Markdown 星号（会被原样显示）
    expect(TEAM_EDITION_ARCHIVED_NOTE).not.toMatch(/\*\*[^*\n]{1,40}\*\*/);
    // ⛔ 不出现"在售 / 可购买"这类与事实相反的词；并明说"不再支持新建"
    expect(TEAM_EDITION_ARCHIVED_NOTE, "必须明说不再接受新配置").toContain("不再支持新建");
    for (const bad of ["在售", "可购买"]) {
      expect(TEAM_EDITION_ARCHIVED_NOTE, `⛔ 冻结注记里出现了「${bad}」（与 owner 2026-10-29 的事实相反）`).not.toContain(
        bad,
      );
    }
  });
});
