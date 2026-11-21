// 判据：A3（2026-11-21，owner 拍「只批量、不传播」）的前端那一半 —— **选择 ⇒ 要送的键**。
//
// 三条判据名与 Rust 侧同名（`mesh_uid_confirm::plan_batch_confirm` 有对应单测）：
// ① `batch-selected-only`：请求体逐个都在勾选里；未勾的行一个都不送；
// ② `no-propagation-on-batch`：**不做传播** —— 勾一行只送一行，同 uid 的兄弟候选不送；
// ③ `empty-selection-writes-nothing`：空选／空表 ⇒ 空数组（调用方据此不发请求）。
import { describe, expect, it } from "vitest";

import { selectedPairs, uidPairKey } from "./meshUidSelection";

/** 四行覆盖三种"看起来像"的关系（全部同名 —— 名字不参与判据）。 */
const rows = [
  { peerDevice: "dev-a", peerUid: "uid-1", localName: "山焦招标" },
  // 另一台设备、**同一个 uid**（旧口径会传播；新口径 ⛔ 不传播）
  { peerDevice: "dev-b", peerUid: "uid-1", localName: "山焦招标" },
  // 同一台设备、**uid 不同**
  { peerDevice: "dev-a", peerUid: "uid-2", localName: "山焦招标" },
  // 另一台、另一个 uid
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

  it("② no-propagation-on-batch：勾一行只送一行 —— 同 uid 的兄弟候选**不**送", () => {
    const one = selectedPairs(rows, check(["dev-a", "uid-1"]));
    expect(one).toEqual([{ peerDevice: "dev-a", peerUid: "uid-1" }]);
    // 断言"没有第二个"（dev-b/uid-1 与它 uid 完全相同，但没勾就不送）
    expect(one).toHaveLength(1);
    expect(one[0].peerDevice).toBe("dev-a");
    // 全部勾上时才是四行（顺序跟 rows）
    expect(selectedPairs(rows, check(
      ["dev-a", "uid-1"],
      ["dev-b", "uid-1"],
      ["dev-a", "uid-2"],
      ["dev-c", "uid-9"],
    ))).toHaveLength(4);
  });

  it("③ empty-selection-writes-nothing：空选／空表 ⇒ 不发请求", () => {
    expect(selectedPairs(rows, new Set())).toEqual([]);
    expect(selectedPairs([], check(["dev-a", "uid-1"]))).toEqual([]);
  });

  it("行键把设备与 uid 都算进去（同一台设备的不同 uid 不是同一行）", () => {
    expect(uidPairKey({ peerDevice: "dev-a", peerUid: "uid-1" })).not.toBe(
      uidPairKey({ peerDevice: "dev-a", peerUid: "uid-2" }),
    );
  });
});
