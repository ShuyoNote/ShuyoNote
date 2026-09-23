// SSE 变更流（近实时推送）的**接线判据**（文本级）。
//
// ⚠️ 与 `webClaimScope.wiring.test.ts` 同一手法、同一已知弱点（**文本级，会被骗**）。
// 它抓的不是"逻辑对不对"（解析逻辑由 `crdt/claimScope.test.ts` 的纯函数判据负责），
// 而是"**接线有没有退回旧形状**"—— 第 45 轮那个 bug 就在接线上：
// 挑"第一个绑定过的档案"会**订到别的空间**上去。
//
// 为什么值得为它写一条会骗人的判据：这段接线**没有别的判据**（它要 `fetch` 的 SSE 流、
// 要 ReadableStream、要平台判断；`test:sync-collab` 验的是服务端/命令面，不验这条订阅选谁）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 去掉注释后再断言 —— 与 `scripts/check-capabilities.mjs` 同一手法。
 *  为什么必须去：注释里**引用旧写法**是为了讲清楚它错在哪，而文本级断言分不清"代码"与"注释"。
 *  （这条不是假想：第一版就栽在"我在注释里抄了一遍旧写法"上，断言当场红。） */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const src = stripComments(readFileSync(join(process.cwd(), "src/hooks/useSyncStream.ts"), "utf8"));

describe("近实时 · SSE 订阅的目标（文本级，防退回旧形状）", () => {
  it("① 按**当前工作空间**解析绑定，并用解析结果拼 URL（不是「第一个绑定过的档案」）", () => {
    expect(src).toContain("api.getActiveWorkspaceId()");
    expect(src).toContain("resolveWorkspaceSyncScope(");
    // ★ 承重：URL 与令牌都必须来自解析结果
    expect(src).toContain("scope.server");
    expect(src).toContain("scope.spaceId");
    expect(src).toContain("scope.token");
  });

  it("② 旧形状**必须消失**：自己挑第一个档案、自己去掉结尾斜杠", () => {
    expect(src, "又出现了「挑第一个绑定过的档案」的旧形状").not.toContain("profiles.find(");
    expect(src, "又出现了「在 hook 里自己归一地址」的旧形状").not.toContain('replace(/\\/+$/, "")');
  });

  it("③ 推送到达时同步的是**那个工作空间**（不是档案行里的某个字段）", () => {
    expect(src).toContain("syncWorkspace(wsId)");
    expect(src).not.toContain("bound.ws_id");
  });
});
