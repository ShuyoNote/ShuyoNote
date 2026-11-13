// U4 片 1 判据（owner 2026-11-13 拍 D1=B / D2=A / D4=A）—— 纯函数，不起宿主。
//
// 钉三件事（都能被一次"顺手改"打红）：
//   ① 推荐只对**安全情形**出（一边没改／纯追加不重叠）；两边都改且重叠 ⇒ **ask**（⛔ 不替人猜）
//   ② 每条推荐必须带**规则推出的理由**（⛔ 空话/编造）
//   ③ ⛔ **摘要里不许出现正文整段**：只允许 ≤40 字片段（用"夹具正文反例"做机器断言）
import { describe, expect, it } from "vitest";

import {
  clipSnippet,
  conflictAdvice,
  conflictSummary,
  SNIPPET_MAX,
  type ConflictShape,
  type ConflictSide,
} from "./conflictAdvice";

const side = (changed: boolean, chars = 0, lines = 0): ConflictSide => ({ changed, chars, lines });

const shape = (over: Partial<ConflictShape> = {}): ConflictShape => ({
  blockType: "paragraph",
  local: side(false),
  remote: side(false),
  appendOnly: false,
  overlap: false,
  localSnippet: "",
  remoteSnippet: "",
  ...over,
});

describe("U4 · conflictAdvice（安全情形才给推荐）", () => {
  it("① 两边都没改 ⇒ 保留本地（理由说清）", () => {
    const a = conflictAdvice(shape());
    expect(a.choice).toBe("local");
    expect(a.reason).toContain("都没有实际改动");
    expect(a.twoWayTie).toBe(false);
  });

  it("② 只有远端改 ⇒ 用远端；只有本地改 ⇒ 用本地", () => {
    expect(conflictAdvice(shape({ remote: side(true, 12, 2) })).choice).toBe("remote");
    expect(conflictAdvice(shape({ remote: side(true, 12, 2) })).reason).toContain("只有远端改过");
    expect(conflictAdvice(shape({ local: side(true, 9, 1) })).choice).toBe("local");
    expect(conflictAdvice(shape({ local: side(true, 9, 1) })).reason).toContain("只有本地改过");
  });

  it("③ 两边都改 + 纯追加且不重叠 ⇒ 合并（两边都保留）", () => {
    const a = conflictAdvice(shape({ local: side(true, 5, 1), remote: side(true, 6, 1), appendOnly: true }));
    expect(a.choice).toBe("merge");
    expect(a.reason).toContain("纯追加");
    expect(a.reason).toContain("合并");
    expect(a.twoWayTie).toBe(false);
  });

  it("④ 两边都改且互相覆盖 ⇒ 两难，必须问人（⛔ 不自动裁）", () => {
    const a = conflictAdvice(shape({ local: side(true, 5, 1), remote: side(true, 6, 1), overlap: true }));
    expect(a.choice).toBe("ask");
    expect(a.twoWayTie).toBe(true);
    expect(a.reason).toContain("两难");
  });

  it("⑤ 纯追加但重叠 ⇒ 仍算两难（安全优先，⛔ 不冒进合并）", () => {
    const a = conflictAdvice(
      shape({ local: side(true, 5, 1), remote: side(true, 6, 1), appendOnly: true, overlap: true }),
    );
    expect(a.choice).toBe("ask");
  });
});

describe("U4 · 摘要与片段（⛔ 不回正文整段）", () => {
  it("⑥ 片段上限：短的原样，长的裁到 ≤40 并加省略号", () => {
    expect(clipSnippet("短片段")).toBe("短片段");
    const long = "ä".repeat(SNIPPET_MAX + 30);
    const clipped = clipSnippet(long);
    expect(clipped.length).toBe(SNIPPET_MAX + 1);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.startsWith("ä".repeat(SNIPPET_MAX))).toBe(true);
  });

  it("⑦ 摘要含块类型/哪边改/量级/追加或覆盖/两侧片段", () => {
    const s = conflictSummary(
      shape({
        blockType: "heading",
        local: side(true, 12, 1),
        remote: side(false),
        appendOnly: true,
        localSnippet: "改过的标题",
        remoteSnippet: "",
      }),
    );
    expect(s).toContain("标题");
    expect(s).toContain("本地改");
    expect(s).toContain("远端未改");
    expect(s).toContain("12 字");
    expect(s).toContain("纯追加");
    expect(s).toContain("改过的标题");
  });

  it("⑧ ⛔ 正文反例：夹具正文第 41 字之后的内容**不许**出现在摘要里", () => {
    // 夹具：80 字正文，把"整段正文"当片段传进去（最坏调用方）——摘要只能出现前 40 字
    const body = "甲".repeat(40) + "乙乙乙乙乙乙乙乙乙乙";
    const summary = conflictSummary(
      shape({
        local: side(true, body.length, 1),
        remote: side(false),
        localSnippet: body, // 故意传整段：模块必须自己裁
        remoteSnippet: body,
      }),
    );
    expect(summary).toContain("甲".repeat(40));
    expect(
      summary.includes("乙"),
      `⛔ 摘要里出现了夹具正文第 41 字之后的内容（红线）：${summary}`,
    ).toBe(false);
    // 摘要里也不许出现整段（否则上面那条会先红；这条防"整段拼进去但恰好被截断"）
    expect(summary.length).toBeLessThan(200);
  });
});
