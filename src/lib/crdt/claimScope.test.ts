// S9 · claim 目标的判据（**与 Rust 侧 `sync::tests` 成对**：一套语义、两侧各一份判据）。
//
// 承重的一条是 ① —— 它钉的就是那个真 bug：**发出去的必须是远端 space id，不是本地工作空间 id**。
import { describe, expect, it } from "vitest";
import { resolveClaimScope, type ClaimScopeRow } from "./claimScope";

const row = (over: Partial<ClaimScopeRow> = {}): ClaimScopeRow => ({
  ws_id: "ws-1",
  server_url: "https://shuyo.cn/sync/",
  space_id: "8f3a…32位hex", // 服务端生成的远端空间 id（形状示意）
  token: "tk",
  ...over,
});

describe("S9 · claim 发给谁（页所属工作空间 ⇒ 远端空间 id）", () => {
  it("① ★ 承重：页属于 W ⇒ 发给 **W 绑定的服务器与远端 space_id**（**不是** W 自己）", () => {
    const scope = resolveClaimScope([row({ ws_id: "ws-1", space_id: "REMOTE-SPACE" })], "ws-1");
    expect(scope).not.toBeNull();
    expect(scope!.spaceId).toBe("REMOTE-SPACE"); // 本地 id 是 "ws-1" —— 第一版就是把 "ws-1" 发出去的
    expect(scope!.spaceId).not.toBe("ws-1");
    expect(scope!.server).toBe("https://shuyo.cn/sync"); // 结尾斜杠已归一
    expect(scope!.token).toBe("tk");
  });

  it("② 没有档案／只填了服务器／只填了空间 ⇒ 一律 `null`（**不发请求**：发出去只会换 403）", () => {
    expect(resolveClaimScope([], "ws-1")).toBeNull();
    expect(resolveClaimScope([row({ ws_id: "ws-other" })], "ws-1")).toBeNull();
    // 登录了但还没选空间（保存地址与选空间是两步）—— 正常中间态，不是错误
    expect(resolveClaimScope([row({ space_id: "" })], "ws-1")).toBeNull();
    expect(resolveClaimScope([row({ space_id: "   " })], "ws-1")).toBeNull();
    // 解绑后只留地址：同理不发
    expect(resolveClaimScope([row({ server_url: "" })], "ws-1")).toBeNull();
  });

  it("③ 多个工作空间各绑各的 ⇒ 必须选**这一页那一个**（不是「排序第一个」）", () => {
    const rows = [
      row({ ws_id: "aaa", server_url: "https://a.example", space_id: "SP-A" }),
      row({ ws_id: "ws-1", server_url: "https://b.example", space_id: "SP-B" }),
    ];
    const scope = resolveClaimScope(rows, "ws-1");
    expect(scope!.server).toBe("https://b.example");
    expect(scope!.spaceId).toBe("SP-B");
  });
});
