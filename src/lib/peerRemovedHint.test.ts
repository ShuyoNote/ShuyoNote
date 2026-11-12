// U2 C4 判据：**被移出 / 没配对**必须分开说（owner 2026-11-12 ③A）。
//
// 为什么要有：两者都表现为"拉不动"，但处置完全不同 ——
//   · 没配对 ⇒ 去「接入」/邀请；
//   · 被移出 ⇒ 要**重新邀请/配对**，而且本机数据不会动（不能让人以为数据丢了）。
// 判据形状（都能被一次"顺手改"打红）：
//   ① 对端 401 原文（Rust 逐字那句）＋ 本机名单有它 ⇒ 「被移出」提示，且给"重新邀请/配对"；
//   ② 同样 401 但本机名单没有它 ⇒ 「还没配对过」提示；
//   ③ 网络超时/其他错误 ⇒ `null`（⛔ 不许把一切错误都说成被移出）；
//   ④ 一轮里多台 ⇒ 只要有一台命中就出提示；没有 ⇒ `null`。
import { describe, expect, it } from "vitest";

import { findPeerRemovedHint, peerRemovedHint, PEER_NOT_PAIRED_HINT, PEER_REMOVED_HINT } from "./peerRemovedHint";

/** Rust 侧 401 响应体原文（逐字节摘自媒体日志，别改它）。 */
const PEER_401 =
  '{"error":"没通过，而且口令那一档也没出示：这个空间里**没有登记过这台设备的公钥**（没被信任过，或已被移出）"}';

describe("peerRemovedHint · 被移出 / 没配对要分开说", () => {
  it("① 曾配对过 + 对端 401 ⇒ 「被移出」，且给重新邀请/配对的下一步", () => {
    const h = peerRemovedHint(PEER_401, true);
    expect(h).toBe(PEER_REMOVED_HINT);
    expect(h).toContain("重新邀请");
    // ⛔ 不许让人以为数据被删了
    expect(h).toContain("本机数据不会动");
  });

  it("② 没配对过 + 对端 401 ⇒ 「还没配对」，⛔ 不说是被移出", () => {
    const h = peerRemovedHint("没被信任过", false);
    expect(h).toBe(PEER_NOT_PAIRED_HINT);
    expect(h).not.toContain("移出");
  });

  it("③ 网络超时 / 其它错误 ⇒ null（不许把一切失败都说成被移出）", () => {
    expect(peerRemovedHint("error sending request: timeout", true)).toBeNull();
    expect(peerRemovedHint("dial tcp: connection refused", false)).toBeNull();
    expect(peerRemovedHint(null, true)).toBeNull();
    expect(peerRemovedHint("", true)).toBeNull();
  });

  it("④ 一轮多台：有一台命中就出提示；全都不命中 ⇒ null", () => {
    const round = {
      peers: [
        { peer: "p1", error: null },
        { peer: "p2", error: PEER_401 },
      ],
    };
    expect(findPeerRemovedHint(round, (p) => p === "p2")).toBe(PEER_REMOVED_HINT);
    expect(findPeerRemovedHint({ peers: [{ peer: "p3", error: "timeout" }] }, () => false)).toBeNull();
    expect(findPeerRemovedHint(null, () => false)).toBeNull();
  });
});
