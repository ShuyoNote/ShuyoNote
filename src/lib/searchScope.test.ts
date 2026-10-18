// 判据：「全空间搜索」在未输主口令时，**能搜的照搜**，且**说出来少搜了哪些空间**。
//
// 现场（owner 2026-10-18）：「桌面版，未输入主口令时，全空间搜索不可用」——
// 内核旧写法让一个加密空间没解锁就整次 Err，界面显示「无结果」⇒ 读起来就是搜索坏了。
// 本判据钉两件事：① 哪些空间算「现在搜不到」；② 那句提示**必须点名**，⛔ 不许只写「部分结果」 ✗。
import { describe, expect, it } from "vitest";

import { lockedHintText, lockedSpaceNames, type SpaceSecurityRow } from "./searchScope";

const SPACES = [
  { id: "s1", name: "运营" },
  { id: "s2", name: "财务" },
  { id: "s3", name: "团队" },
];

const row = (space_id: string, encrypted_on_disk: boolean, key_available: boolean): SpaceSecurityRow => ({
  space_id,
  encrypted_on_disk,
  key_available,
});

describe("lockedSpaceNames —— 哪些空间这次搜不到", () => {
  it("① 加密且没解锁 ⇒ 搜不到（未输主口令时就是这一档）", () => {
    expect(lockedSpaceNames(SPACES, [row("s1", true, false), row("s2", false, false), row("s3", true, true)])).toEqual([
      "运营",
    ]);
  });

  it("② 明文空间 / 已解锁的加密空间 ⇒ 不算（⛔ 不许把明文空间也报成「未解锁」 ✗）", () => {
    expect(
      lockedSpaceNames(SPACES, [row("s1", false, false), row("s2", false, true), row("s3", true, true)]),
      "全是明文或已解锁 ⇒ 一个都不报",
    ).toEqual([]);
  });

  it("③ 顺序跟侧栏一致（用户看到的名字顺序要和列表一样）", () => {
    expect(lockedSpaceNames(SPACES, [row("s3", true, false), row("s1", true, false)])).toEqual(["运营", "团队"]);
  });

  it("④ 读数里没有这个空间（拿不到）⇒ 不当成未解锁（宁可少说一句，⛔ 不许凭空说「未解锁」 ✗）", () => {
    expect(lockedSpaceNames(SPACES, [row("s1", true, false)])).toEqual(["运营"]);
    expect(lockedSpaceNames(SPACES, [])).toEqual([]);
  });
});

describe("lockedHintText —— 那句话必须点名", () => {
  it("① 有点名的空间名与数量", () => {
    const text = lockedHintText(["运营", "财务"]);
    expect(text).toContain("2 个空间未解锁");
    expect(text).toContain("运营、财务");
    expect(text, "要告诉用户怎么办").toContain("主口令");
  });

  it("② 没有 ⇒ 空串（调用方据此不渲染那一行，⛔ 不许留一个空壳）", () => {
    expect(lockedHintText([])).toBe("");
  });
});
