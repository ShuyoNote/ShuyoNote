// 融合历史 ＋ 撤销：**组件级判据**（R203 ✓ —— 这才是有对象的判据 ✓）。
//
// ⚠️ 为什么这一层能验、而"账本真读数"不能验：
//   账本**已经进构建**（`src-tauri/src/lib.rs:129` ✓），但它**没有命令、也没有生产调用者** ✗
//   ⇒ 前端**读不到真数据** ✗。所以本轮的判据全部落在**组件吃什么、就渲染什么** ✓
//   （`MergeRecord` 的形状 ✓ ＋ 「无记录不渲染撤销」✓）—— 那正是"给 win 的形状"那一半 ✓。
//
// ⛔ 本文件**不**假装验过"真账本能读出来" ✗（那要 win 先落命令 ✓）。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileMergeHistory, type MergeHistoryRow } from "./MobileMergeHistory";

/** 一条"还没撤"的记录（形状与 Rust `MergeRecord` 对齐 ✓）。 */
function row(over: Partial<MergeHistoryRow> = {}): MergeHistoryRow {
  return {
    id: 1,
    at_ms: Date.now() - 60_000,
    peer_device: "9dc88146-d0c2-4bc6-bce0-42484bcd4b45",
    peer_name: "书房的 Mac",
    peer_short_id: "K7M2Q",
    moved_count: 12,
    kept_before: 3,
    undone_at_ms: null,
    ...over,
  };
}

const html = (props: Parameters<typeof MobileMergeHistory>[0]) =>
  renderToStaticMarkup(<MobileMergeHistory {...props} />);

describe("MobileMergeHistory：形状 ＋ 「无记录不许有假按钮」", () => {
  it("① ⭐ 空列表 ⇒ **一颗「撤销」都不许有**（＝不许渲染假按钮 ✓）", () => {
    const out = html({ rows: [] });
    // ⚠️ 量的是**那颗按钮**（`mmerge-undo` ✓），⛔ 不是"撤销"这个词 ✗ ——
    //    空态那句说明里**本来就有**「撤销」两个字 ✓（第一版就是这么假红的 ✓）。
    expect(out).not.toContain("<button class=\"mmerge-undo\"");
    expect(out).toContain("还没有融合记录");
  });

  it("② 一条 `undone_at_ms: null` ⇒ 渲染「撤销」✓（仍可撤 ✓）", () => {
    const out = html({ rows: [row()] });
    expect(out).toContain("<button class=\"mmerge-undo\"");   // 那颗按钮在 ✓
    // ⚠️ 断言**整段按钮标记** ✓ —— ⛔ 只断言 `mmerge-undo` 会被 `mmerge-undone` 误命中 ✗（实测假红一次 ✓）
    expect(out).toContain("合入 12 条");
    expect(out).toContain("原有 3 条");
  });

  it("③ ⭐ 一条**已撤**的 ⇒ **不渲染**「撤销」✗（改成「已撤销」✓）", () => {
    const out = html({ rows: [row({ undone_at_ms: Date.now() })] });
    expect(out).not.toContain("<button class=\"mmerge-undo\"");   // ⛔ 已撤的行**没有**那颗按钮 ✓
    expect(out).toContain("已撤销");
  });

  it("④ ⭐ 拿不到设备名／短标识 ⇒ 如实说「对方没报短标识」✓，且**输出里不出现 `peer_device` 及其前缀** ✗", () => {
    const id = "9dc88146-d0c2-4bc6-bce0-42484bcd4b45";
    const out = html({ rows: [row({ peer_device: id, peer_name: "", peer_short_id: "" })] });
    expect(out).toContain("对方没报短标识");
    expect(out).not.toContain(id);
    for (const n of [3, 8, 13, id.length - 1]) expect(out).not.toContain(id.slice(0, n));
  });

  it("⑤ 数据层**明标未接** ✓（横幅点到 `lib.rs:129` ＋ 说明没有命令／生产调用者 ✓）", () => {
    const out = html({ rows: [] });
    expect(out).toContain("lib.rs:129");
    expect(out).toContain("没有命令、也没有生产调用者");
  });

  it("⑥ 「这次并对了，别再问」那一档在 ✓（`PairMark` 同形 ✓）", () => {
    const out = html({
      rows: [],
      marks: [{ name_display: "工作", peer_name: "书房的 Mac", peer_short_id: "K7M2Q", marked_at_ms: Date.now() }],
    });
    expect(out).toContain("这次并对了，别再问");
    expect(out).toContain("书房的 Mac · K7M2Q");
  });

  it("⑦ ⭐ 渲染出来的文本里**不含 markdown 星号** ✗（这条踩过一次：JSX 不渲染 markdown ✓）", () => {
    const out = html({ rows: [row()], marks: [{ name_display: "工作", marked_at_ms: Date.now() }] });
    expect(out).not.toContain("**");
  });
});
