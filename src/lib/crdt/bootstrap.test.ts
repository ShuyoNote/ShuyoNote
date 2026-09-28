// 冲刺 S9（客户端半边）的判据：打开一页时"要不要建血统"的四条分支。
//
// 这四条分支把"服务端首写者裁定"这件事**在客户端这一侧**钉死：服务端端点一就位，
// 客户端不需要再发明语义，只要把 `PageClaimPort` 的真实现传进来。
// ⚠️ 今天没有端点 ⇒ `claimVerdict(undefined, …)` 回 `unavailable` ⇒ 走"离线临时建"那一支，
//    与**接线前**的行为**逐字相同**（这点由 ④ 与 ⑤ 一起保证）。
import { describe, expect, it } from "vitest";
import { claimVerdict, decideBootstrap, type ClaimVerdict, type PageClaimPort } from "./bootstrap";

describe("冲刺 S9 · 客户端半边：打开一页时的四种动作", () => {
  it("① 本地已有状态 ⇒ `load-existing`，且**不看 claim**（已有血统的页不许再建）", () => {
    const verdicts: ClaimVerdict[] = ["granted", "denied", "unavailable"];
    for (const claim of verdicts) {
      expect(decideBootstrap({ hasLocalState: true, claim })).toEqual({ action: "load-existing" });
    }
  });

  it("② 没有状态 ＋ claim 成功 ⇒ `mint`（＝今天那次「首开建一次」）", () => {
    expect(decideBootstrap({ hasLocalState: false, claim: "granted" })).toEqual({ action: "mint" });
  });

  it("③ ★ 没有状态 ＋ 别人先 claim 过 ⇒ `wait-for-remote`：**不建**（这是关窗口的那一支）", () => {
    expect(decideBootstrap({ hasLocalState: false, claim: "denied" })).toEqual({ action: "wait-for-remote" });
  });

  it("④ ★ 没有状态 ＋ 拿不到 claim（离线/没有端点）⇒ **照旧能写**：`mint-provisional-offline`", () => {
    expect(decideBootstrap({ hasLocalState: false, claim: "unavailable" })).toEqual({
      action: "mint-provisional-offline",
    });
  });

  it("⑤ `claimVerdict`：没有端口 / 端口抛错 ⇒ 都归一成 `unavailable`（**离线不是错误**）", async () => {
    expect(await claimVerdict(undefined, "p1", "dev-1")).toBe("unavailable");

    const boom: PageClaimPort = {
      claim: async () => {
        throw new Error("网络断了");
      },
    };
    expect(await claimVerdict(boom, "p1", "dev-1")).toBe("unavailable");

    const granted: PageClaimPort = { claim: async () => true };
    expect(await claimVerdict(granted, "p1", "dev-1")).toBe("granted");

    const denied: PageClaimPort = { claim: async () => false };
    expect(await claimVerdict(denied, "p1", "dev-1")).toBe("denied");
  });
});
