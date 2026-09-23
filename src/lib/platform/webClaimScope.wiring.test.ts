// S9 · claim 在**平台层**的接线判据（文本级）。
//
// ⚠️ **这条判据是文本级的，已知会被骗**（与 `webSyncStash.test.ts` / `databaseTextForPage.test.ts`
// 同一手法、同一已知弱点）。它抓的不是"逻辑对不对"（那由 `crdt/claimScope.test.ts` 的纯函数判据
// 负责），而是"**接线有没有退回旧形状**"—— 第 42 轮那个真 bug 就发生在接线上（把本地工作空间 id
// 当远端 `space_id` 发出去），而它是纯函数判据**看不见**的一段：纯函数对了，接线照样能传错。
//
// 为什么值得为它写一条会骗人的判据：这段接线**没有别的判据**（`makeInvoke` 里的命令要 sql.js 的
// store ＋ `syncFetch`，端到端只有浏览器门禁碰得到，而浏览器门禁**不配同步**、走的是"没配置"那一支）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/lib/platform/web.ts"), "utf8");

/** 取 `claim_page_lineage` 那个命令分支的源文本（到下一个 `if (cmd === ` 为止）。 */
function claimBranch(): string {
  const start = src.indexOf('if (cmd === "claim_page_lineage")');
  expect(start, "web.ts 里找不到 claim_page_lineage 分支").toBeGreaterThan(-1);
  const next = src.indexOf("if (cmd === ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("S9 · 平台层 claim 接线（文本级，防退回旧形状）", () => {
  it("① 用**本地工作空间 id** 解析档案，并把请求体里的 space_id 绑到**解析结果**上", () => {
    const branch = claimBranch();
    // 入参是工作空间 id（页所属那一个）
    expect(branch).toContain("args.workspace_id");
    // 走唯一的解析处（不是"随便挑第一个档案"）
    expect(branch).toContain("resolveWorkspaceSyncScope(");
    // ★ 承重：请求体里的 space_id 必须是解析出来的**远端** id
    expect(branch).toContain("space_id: scope.spaceId");
    // 服务器/token 也必须来自解析结果（否则会问到别的服务器上）
    expect(branch).toContain("scope.server");
    expect(branch).toContain("scope.token");
  });

  it("② 旧形状**必须消失**：把入参直接当 space_id 发、或自己挑第一个档案", () => {
    const branch = claimBranch();
    expect(branch, "又出现了「入参直接当 space_id」的旧形状").not.toContain("space_id: String(args.");
    expect(branch, "又出现了「第一个有 server_url 的档案」的旧挑法").not.toContain("ORDER BY ws_id");
  });

  it("③ `unavailable` 仍用**结果标记**回，不许抛（第 38 轮浏览器门禁的教训）", () => {
    const branch = claimBranch();
    expect(branch).toContain("unavailable: true");
    // 分支里不许出现 `throw`（抛会被平台 invoke 层记成 error ⇒ 浏览器门禁判红）
    expect(branch).not.toContain("throw ");
  });
});
