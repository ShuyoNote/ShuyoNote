// 判据：A3（2026-11-21）「批量勾选 ＋ 同 uid 传播」的前端那一半 —— **选择 ⇒ 要送的键**。
//
// 三条判据名与 Rust 侧同名（`mesh_uid_confirm::plan_batch_confirm` 有对应单测）：
// ① `batch-selected-only`：请求体逐个都在勾选里；未勾的行一个都不送；
// ② `propagate-same-uid-only`：预览条数只数 uid 相同的；uid 不同 ⇒ 0；
// ③ `empty-selection-writes-nothing`：空选／空表 ⇒ 空数组（调用方据此不发请求）。
import { describe, expect, it } from "vitest";

import { sameUidExtra, selectedPairs, uidPairKey } from "./meshUidSelection";

/** 四行覆盖三种"看起来像"的关系（全部同名 —— 名字不参与判据）。 */
const rows = [
  { peerDevice: "dev-a", peerUid: "uid-1", localName: "山焦招标" },
  // 另一台设备、**同一个 uid** ⇒ 同一空间身份（会传播）
  { peerDevice: "dev-b", peerUid: "uid-1", localName: "山焦招标" },
  // 同一台设备、**uid 不同** ⇒ ⛔ 绝不传播
  { peerDevice: "dev-a", peerUid: "uid-2", localName: "山焦招标" },
  // 另一台、另一个 uid ⇒ ⛔ 不带
  { peerDevice: "dev-c", peerUid: "uid-9", localName: "山焦招标" },
];

const check = (...pairs: Array<[string, string]>) =>
  new Set(pairs.map(([peerDevice, peerUid]) => uidPairKey({ peerDevice, peerUid })));

describe("meshUidSelection", () => {
  it("① batch-selected-only：只送勾选的那些，未勾选的一行都不送", () => {
    expect(selectedPairs(rows, check(["dev-a", "uid-2"]))).toEqual([
      { peerDevice: "dev-a", peerUid: "uid-2" },
    ]);
    expect(selectedPairs(rows, check(["dev-b", "uid-1"], ["dev-c", "uid-9"]))).toEqual([
      { peerDevice: "dev-b", peerUid: "uid-1" },
      { peerDevice: "dev-c", peerUid: "uid-9" },
    ]);
    // 勾选状态里残留的旧键（列表里已经没有这一行了）⛔ 不进请求体
    expect(selectedPairs(rows, check(["dev-z", "uid-404"]))).toEqual([]);
  });

  it("② propagate-same-uid-only：只数 uid 相同的候选；uid 不同 ⇒ 0", () => {
    // 勾 dev-a/uid-1 ⇒ 只有 dev-b/uid-1 会被一并确认（dev-a/uid-2 是同一台但 uid 不同）
    expect(sameUidExtra(rows, [{ peerDevice: "dev-a", peerUid: "uid-1" }])).toBe(1);
    // 勾 dev-a/uid-2 ⇒ 没有任何别的候选同 uid
    expect(sameUidExtra(rows, [{ peerDevice: "dev-a", peerUid: "uid-2" }])).toBe(0);
    // 勾全部 ⇒ 没有"额外"（每一行都在勾选里）
    expect(sameUidExtra(rows, selectedPairs(rows, check(
      ["dev-a", "uid-1"],
      ["dev-b", "uid-1"],
      ["dev-a", "uid-2"],
      ["dev-c", "uid-9"],
    )))).toBe(0);
    // ⛔ 名字相同不是传播理由：只认 uid
    expect(sameUidExtra(rows, [{ peerDevice: "dev-c", peerUid: "uid-9" }])).toBe(0);
  });

  it("③ empty-selection-writes-nothing：空选／空表 ⇒ 不发请求", () => {
    expect(selectedPairs(rows, new Set())).toEqual([]);
    expect(selectedPairs([], check(["dev-a", "uid-1"]))).toEqual([]);
    expect(sameUidExtra(rows, [])).toBe(0);
    expect(sameUidExtra([], [{ peerDevice: "dev-a", peerUid: "uid-1" }])).toBe(0);
  });

  it("行键把设备与 uid 都算进去（同一台设备的不同 uid 不是同一行）", () => {
    expect(uidPairKey({ peerDevice: "dev-a", peerUid: "uid-1" })).not.toBe(
      uidPairKey({ peerDevice: "dev-a", peerUid: "uid-2" }),
    );
  });
});
