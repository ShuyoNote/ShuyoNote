// U4 片 2/3 接线判据（owner 2026-11-13 拍 D1=B / D3=A / D4=A）—— 源码级。
//
// 钉四件事（都能被一次"顺手改"打红）：
//   ① 差异显示走**唯一的摘要实现**（`conflictSummary`）＋ 形状来自 `conflictShapeFromRow`；
//   ② 推荐与理由来自 `conflictRowAdvice`，且推荐按钮带主按钮样式（D4=A）；
//   ③ 批量**仅一页内**、走二次确认（`confirmDialog`）＋ 逐块调既有 `resolvePageConflict`（⛔ 新命令）；
//   ④ ⛔ 不再把两侧正文整段铺出来（`fragmentText` 那条老路已删）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const panel = readFileSync(resolve(__dirname, "ConflictBanner.tsx"), "utf8");

describe("U4 · ConflictBanner 接线（摘要/推荐/批量）", () => {
  it("① 摘要与形状走唯一实现", () => {
    expect(panel).toContain('from "../lib/conflictAdvice"');
    expect(panel).toContain("conflictSummary(");
    expect(panel).toContain('from "../lib/conflictShape"');
    expect(panel).toContain("conflictShapeFromRow(");
    expect(panel).toContain('data-testid="conflict-summary"');
  });

  it("② 推荐＋理由上屏，推荐按钮有主按钮样式", () => {
    expect(panel).toContain("conflictRowAdvice(");
    expect(panel).toContain('data-testid="conflict-advice"');
    expect(panel).toMatch(/advice\.fuller === "local"[\s\S]{0,120}conflict-btn-primary/);
    expect(panel).toMatch(/advice\.fuller === "remote"[\s\S]{0,120}conflict-btn-primary/);
  });

  it("③ 批量：仅一页内 + 二次确认 + 逐块调既有命令", () => {
    expect(panel).toContain('data-testid="conflict-batch"');
    expect(panel).toContain("confirmDialog(");
    expect(panel).toContain("batchMessage");
    // 逐块调既有命令（⛔ 不新造命令）
    expect(panel).toMatch(/for \(const row of rows\)[\s\S]{0,160}api\.resolvePageConflict\(row\.id, choice\)/);
  });

  it("④ ⛔ 不再把两侧正文整段铺出来（老 fragmentText 已删）", () => {
    expect(panel).not.toContain("fragmentText(");
    expect(panel).not.toContain("conflict-item-texts");
  });
});
