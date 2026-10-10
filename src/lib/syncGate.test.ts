// ⭐ task-12 判据 b：「闸门挡下时留下**可读原因**」＋「跑完了留一行」——
//    ⚠️ 两件以前都是**完全静默**的 ✗ ⇒ 「没触发／被挡／跑了」在日志里同形 ✓（真机上正是判不出来那一格 ✓）。
//
// ⚠️ 这里**不**测 `shouldAutoSyncNow()` 本身（它要 api/网络 ⇒ 打桩面太大 ✓）——
//    测的是它**拼出来那一行**（纯函数 ✓），与 `lan::announce_*_line` 同一形状 ✓。
import { describe, expect, it } from "vitest";
import { autoSyncGateLine } from "./syncGate";
import { autoSyncRoundLine } from "./syncBackoff";

describe("task-12：自动同步那三件必须分得开", () => {
  it("① 被闸门挡下 ⇒ ⭐ 必须说出**为什么**（⛔ 不许静默 ✗）", () => {
    const line = autoSyncGateLine("unknown", true, false);
    expect(line).toContain("被闸门挡下");
    expect(line).toContain("unknown"); // ⭐ 网络类型要打出来（不然不知道挡在哪一档 ✓）
    expect(line.length).toBeGreaterThan(20);
  });

  it("② 放行 ⇒ 也要留一行（否则'没触发'与'放行了但没跑'分不开 ✗）", () => {
    expect(autoSyncGateLine("wifi", true, true)).toContain("放行");
    // 关掉 wifi_only ⇒ 放行，且原因写清是"用户允许非 Wi-Fi"
    expect(autoSyncGateLine("cellular", false, true)).toContain("用户允许非 Wi-Fi");
  });

  it("③ 跑完了 ⇒ 空间数/对端数/收下几条都在（⭐ 触发了并跑完这一格 ✓）", () => {
    const line = autoSyncRoundLine([{ pulled: 2 }], [{ peers: [{ fetched: 3, applied: 3 }] }]);
    expect(line).toContain("跑完了");
    expect(line).toContain("服务端 1 个空间");
    expect(line).toContain("网格 1 个空间、1 台对端");
    expect(line).toContain("收下 3");
  });

  it("④ 空轮也留一行 ⇒ ⭐ 「跑了但什么都没换到」看得出来 ✓", () => {
    const line = autoSyncRoundLine([], []);
    expect(line).toContain("跑完了");
    expect(line).toContain("服务端 0 个空间");
  });
});
