// 「血统拒绝合并」措辞的判据（唯一措辞来源，冲刺 §13.3 第 2 条）。
//
// 这一层为什么值得判据：它是"**不静默**"这条纪律在**两条路**上的公共出口 ——
//   ① pull 落盘那条（`mergeRemotePageState.lineageConflict`，`main.tsx` 报出去）；
//   ② 打开页面那条（`bindPageToEditorViaPort.pendingSkipped`，`Editor.tsx` 报出去）。
// 第 43 轮的缺口正是②：条数**算出来了、没人读**（只留在 `console.warn` 里）⇒ 用户永远不知道
// "这一页有对端改动没合进来"。所以这里既判"有事要说"，也判"没事别吵"。
import { describe, expect, it } from "vitest";
import { lineageRefusalNotice } from "./lineageNotice";

describe("血统拒绝合并：措辞（唯一来源）", () => {
  it("★ 没事发生 ⇒ `null`（不许留噪声日志、不许打扰用户）", () => {
    expect(lineageRefusalNotice({ pageId: "p1" }), "既没有冲突也没有跳过的条数").toBeNull();
    expect(lineageRefusalNotice({ pageId: "p1", skipped: 0 }), "skipped=0 是常态（不是事故）").toBeNull();
    // 只有一条空指纹不算冲突（调用方没给 mine/remote ⇒ 不该凭空报）
    expect(lineageRefusalNotice({ pageId: "p1", mine: [1], remote: undefined })).toBeNull();
  });

  it("★ `pendingSkipped > 0`（打开页面那条路）⇒ 有悔痕 ＋ 用户看得懂的一句话，且**带条数**", () => {
    const r = lineageRefusalNotice({ pageId: "page-abc", skipped: 3 });
    expect(r, "有跳过就必须报出去（这一条就是第 43 轮缺的那半）").not.toBeNull();
    expect(r!.log).toContain("page-abc");
    expect(r!.log, "日志要有条数（排错时能区分「1 条」和「几十条」）").toContain("3");
    // 用户看得懂：哪一页不用重复（他正开着），但"没合进来"和"本机版本保留"必须说清
    expect(r!.message).toContain("3 条");
    expect(r!.message).toContain("没有合进来");
    expect(r!.message).toContain("本机版本保留");
  });

  it("血统冲突（pull 那条路）⇒ 说明是两条**互不相关**的编辑历史、本机保留；日志带两条指纹", () => {
    const r = lineageRefusalNotice({ pageId: "p9", mine: [7, 11], remote: [42] });
    expect(r).not.toBeNull();
    expect(r!.message).toContain("两条互不相关的编辑历史");
    expect(r!.message).toContain("未合并");
    expect(r!.log).toContain("p9");
    expect(r!.log, "两条血统的指纹都要进日志（这是判定「谁跟谁撞了」的唯一线索）").toContain("7,11");
    expect(r!.log).toContain("42");
  });

  it("两条都命中时以**条数**为准（那是「这次实际丢下了几条」，比指纹更贴近现象）", () => {
    const r = lineageRefusalNotice({ pageId: "p1", mine: [1], remote: [2], skipped: 2 });
    expect(r!.message).toContain("2 条");
    expect(r!.message).not.toContain("两条互不相关的编辑历史");
  });

  it("两条路的日志前缀一致（读日志的人不必记两种开头）", () => {
    const a = lineageRefusalNotice({ pageId: "p1", skipped: 1 })!;
    const b = lineageRefusalNotice({ pageId: "p1", mine: [1], remote: [2] })!;
    expect(a.log.startsWith("[crdt] 血统冲突：拒绝合并（本机版本保留）")).toBe(true);
    expect(b.log.startsWith("[crdt] 血统冲突：拒绝合并（本机版本保留）")).toBe(true);
  });
});
