// U4 片 2 判据（owner 2026-11-13 拍 D1=B / D4=A）—— 纯函数，不起宿主。
//
// 钉四件事：
//   ① 从块 JSON 里只取**纯文本**（读不出来 ⇒ 空串，⛔ 不编）；
//   ② 形状里**不夹带正文**（只留 ≤40 字片段；用"长正文反例"断言）；
//   ③ 只有「一侧是另一侧前缀（纯追加、含全部内容）」才给推荐；
//   ④ 其余（互相覆盖/读不出来）⇒ **ask**（真两难，C5），⛔ 不替人猜。
import { describe, expect, it } from "vitest";

import { SNIPPET_MAX } from "./conflictAdvice";
import {
  blockTextFromJson,
  blockTypeFromJson,
  conflictRowAdvice,
  conflictShapeFromRow,
  type ConflictRowLike,
} from "./conflictShape";

const para = (text: string, type = "paragraph") =>
  JSON.stringify({ type, blockId: "b1", content: [{ type: "text", text }] });

const row = (local: string, remote: string, over: Partial<ConflictRowLike> = {}): ConflictRowLike => ({
  block_id: "b1",
  reason: "same-rev-different-content",
  local_json: para(local),
  remote_json: para(remote),
  ...over,
});

describe("U4 · blockTextFromJson / blockTypeFromJson", () => {
  it("① 递归取纯文本；读不出来 ⇒ 空串（不编）", () => {
    expect(blockTextFromJson(para("你好"))).toBe("你好");
    const nested = JSON.stringify({
      type: "paragraph",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    });
    expect(blockTextFromJson(nested)).toBe("ab");
    expect(blockTextFromJson("不是 JSON")).toBe("");
    expect(blockTextFromJson("{}")).toBe("");
  });

  it("② 块类型：paragraph/heading/list/code/其它", () => {
    expect(blockTypeFromJson(para("x"))).toBe("paragraph");
    expect(blockTypeFromJson(para("x", "heading"))).toBe("heading");
    expect(blockTypeFromJson(para("x", "bulletList"))).toBe("list");
    expect(blockTypeFromJson(para("x", "codeBlock"))).toBe("code");
    expect(blockTypeFromJson(para("x", "table"))).toBe("other");
    expect(blockTypeFromJson("坏 JSON")).toBe("other");
  });
});

describe("U4 · conflictShapeFromRow（只带片段，不带正文）", () => {
  it("③ 量级/片段/追加判定：一侧前缀 ⇒ appendOnly=true、overlap=false", () => {
    const s = conflictShapeFromRow(row("甲", "甲加了一点"));
    expect(s.local.changed).toBe(true); // 表只在真冲突时落行 ⇒ 两侧都算改过
    expect(s.remote.changed).toBe(true);
    expect(s.local.chars).toBe(1);
    expect(s.remote.chars).toBe(5);
    expect(s.appendOnly).toBe(true);
    expect(s.overlap).toBe(false);
    expect(s.localSnippet).toBe("甲");

    const notPrefix = conflictShapeFromRow(row("我改的", "他改的"));
    expect(notPrefix.appendOnly).toBe(false);
    expect(notPrefix.overlap).toBe(true);
  });

  it("④ ⛔ 形状里不放整段正文：长正文只留 ≤40 字片段", () => {
    const body = "甲".repeat(SNIPPET_MAX + 60);
    const s = conflictShapeFromRow(row(body, body + "尾"));
    expect(s.localSnippet.length).toBeLessThanOrEqual(SNIPPET_MAX + 1);
    expect(JSON.stringify(s)).not.toContain(body); // 整段不许进来
    expect(JSON.stringify(s)).not.toContain("尾");
  });
});

describe("U4 · conflictRowAdvice（安全情形才推荐）", () => {
  it("⑤ 两版文字相同 ⇒ 保留本地（不会丢信息）", () => {
    const a = conflictRowAdvice(row("同一段", "同一段"));
    expect(a.choice).toBe("local");
    expect(a.reason).toContain("文字相同");
  });

  it("⑥ 本地是远端前缀 ⇒ 用本地（本地更全，含远端全部内容）", () => {
    const a = conflictRowAdvice(row("远端 + 本地追加", "远端"));
    expect(a.choice).toBe("local");
    expect(a.fuller).toBe("local");
    expect(a.reason).toContain("纯追加");
  });

  it("⑦ 远端是本地前缀 ⇒ 用远端（远端更全）", () => {
    const a = conflictRowAdvice(row("本地", "本地 + 远端追加"));
    expect(a.choice).toBe("remote");
    expect(a.fuller).toBe("remote");
  });

  it("⑧ 互相覆盖 ⇒ ask（真两难，⛔ 不替人猜）", () => {
    const a = conflictRowAdvice(row("我改的", "他改的"));
    expect(a.choice).toBe("ask");
    expect(a.fuller).toBeNull();
    expect(a.reason).toContain("两难");
  });
});
