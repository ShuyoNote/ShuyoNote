// ⭐ 2026-10-11（任务 B）：**"信任走到哪一步"那条读数**的判据 ✗。
//
// 守的是**一条口径**（与那一屏另外四条读数同一把尺 ✓）：
//   ⭐ **读不到 ⇒ 如实说读不到** ✗ —— ⛔ 绝不退化成 `idle`（"还没开始"）✗
//   （「还没开始」是**一个结论** ✓，「读不到」是**没有结论** ✓ ⇒ 界面上长得必须不一样 ✓）。
//
// ⚠️ 测法是**注入一个假的 `invoke`** ✓（本模块**不拉起平台层** ✓ —— 见它头注 ✓）：
//   于是"命令抛错／回了个怪形状"这两档**不用起桌面宿主**就能判 ✓。
import { describe, expect, it } from "vitest";

import {
  MESH_TRUST_STATE_COMMAND,
  readTrustState,
  unavailableTrustDeviceReadings,
} from "./trustDevicePanelReadings";

describe("trustDevicePanelReadings · 读「信任走到哪一步」", () => {
  it("① 正常读数 ⇒ `ok`，五个字段逐个搬过来（⛔ 不丢、⛔ 不自己编）", async () => {
    const asked: string[] = [];
    const r = await readTrustState(async (cmd) => {
      asked.push(cmd);
      return { state: "trusted", message: "已经建立信任", active: true, pending: 2 };
    });
    expect(asked).toEqual([MESH_TRUST_STATE_COMMAND]);
    expect(r).toEqual({
      kind: "ok",
      value: { state: "trusted", message: "已经建立信任", active: true, pending: 2 },
    });
  });

  it("② ⭐⭐ 命门：命令抛错 ⇒ ⭐ 如实 `unavailable` ＋ 原因，⛔ 绝不许退化成 `idle`", async () => {
    const r = await readTrustState(async () => {
      throw new Error("command mesh_trust_state not found");
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.reason).toContain("没读到");
      // ⛔ 反例钉在这里：那格**不许**出现 `idle`／"还没开始"这类**结论** ✗
      expect(r.reason).not.toContain("idle");
      expect(r.reason).not.toContain("还没开始");
    }
    // ⭐ 而且返回值里**根本没有** `value` 这一格（拿不到就是拿不到 ✓）
    expect("value" in r).toBe(false);
  });

  it("③ 后端回了个怪形状（没有 `state`）⇒ 也算「读不到」，⛔ 不拿它凑一个 `idle`", async () => {
    for (const weird of [null, {}, { state: "" }, { state: "   " }, { message: "只有一句话" }]) {
      const r = await readTrustState(async () => weird);
      expect(r.kind, `怪形状 ${JSON.stringify(weird)} 不许被读成有值`).toBe("unavailable");
    }
  });

  it("④ 缺字段的那几格**有默认**，但 `state` 永远来自读数（⛔ 不是本地兜底）", async () => {
    const r = await readTrustState(async () => ({ state: "trusted" }));
    expect(r).toEqual({
      kind: "ok",
      value: { state: "trusted", message: "", active: false, pending: 0 },
    });
    // ⚠️ `pending` 形状不对 ⇒ 归 0 ✓（它**不是**结论面：界面上"有条数"才显示那行 ✓）
    const bad = await readTrustState(async () => ({ state: "idle", pending: "2" }));
    expect(bad).toEqual({ kind: "ok", value: { state: "idle", message: "", active: false, pending: 0 } });
  });

  it("⑤ 兜底那一份：**五格全 unavailable**（⛔ 包括新那一格 —— 不给它编 `idle`）", () => {
    const r = unavailableTrustDeviceReadings();
    expect(Object.keys(r).sort()).toEqual([
      "attachOffer",
      "deviceCode",
      "localSpaces",
      "mergeOverlap",
      "trustState",
    ]);
    for (const [key, value] of Object.entries(r)) {
      expect(value.kind, `${key} 不是"读不到"`).toBe("unavailable");
    }
  });
});
