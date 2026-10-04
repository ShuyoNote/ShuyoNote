// L4a/L4b 的**纯函数判据**（客户端半边）：帧 `seq` 的解析 ＋ 跳号判定。
//
// 为什么这些判据在 TS 这一侧也要有（Rust 那边 `sync_stream::tests` 已经有同形的）：
// 客户端有**两条订阅路**（桌面 Rust ／ Web TS）⇒ 判定只有一处实现（`lib/streamSeq.ts`），
// 而这一处**必须自己能被判**，否则"两个客户端口径一致"就只是注释里的一句话。
import { describe, expect, it } from "vitest";
import { frameSeq, isSeqGap, trackFrame } from "./streamSeq";

/** 服务端 `push_frame` 发出来的那一帧（SSE 原文形状 —— Web 侧看到的就是它）。 */
const push = (seq: number) =>
  `data: ${JSON.stringify({ type: "push", space_id: "sp", accepted: 1, seq })}`;

/**
 * 与 **Web 分支同形**地跑一批帧，返回两个读数：
 * - `gaps`：**跳号**那一次的信号（`gap !== null`）——判据 ②③ 就靠它成对；
 * - `pulls`：真的调用拉取的次数（Web 无去抖 ⇒ **每帧一条**，与接线前逐字相同）。
 */
function runWebFrames(seqs: number[]) {
  let last = 0;
  const gaps: number[] = [];
  let pulls = 0;
  for (const s of seqs) {
    const v = trackFrame(last, push(s));
    last = v.last;
    if (v.gap !== null) gaps.push(v.gap);
    pulls += 1; // ← 生产里这一句是 `void pullOnce(wsId)`（唯一出口）
  }
  return { gaps, pulls };
}

describe("L4a/L4b · 帧 seq 的解析与跳号判定（Web 与桌面共用一处口径）", () => {
  it("① `seq` 读得出来；老服务端 / `ping` / 非 JSON ⇒ `null`（不猜、不拿 0 冒充）", () => {
    expect(frameSeq(push(42))).toBe(42);
    // 纯 JSON（桌面形状）也认
    expect(frameSeq(JSON.stringify({ type: "push", seq: 7 }))).toBe(7);
    // 老服务端：没有这个字段
    expect(frameSeq('data: {"type":"push","space_id":"sp","accepted":1}')).toBeNull();
    // ping / 认不出 / 非 JSON
    expect(frameSeq('data: {"type":"ping"}')).toBeNull();
    expect(frameSeq("data: 不是 JSON")).toBeNull();
    expect(frameSeq("")).toBeNull();
  });

  it("② **跳号 ⇒ 有那一次「立刻拉」**（1,2,4 ⇒ 恰好一个 `gap=4`）", () => {
    expect(runWebFrames([1, 2, 4])).toEqual({ gaps: [4], pulls: 3 });
    // 一次跳更多也一样只记**那一个** seq（不是"补几个"）
    expect(runWebFrames([1, 9]).gaps).toEqual([9]);
  });

  it("③ **不跳号 ⇒ 没有那一次**（1,2,3 ⇒ `gaps` 空）", () => {
    expect(runWebFrames([1, 2, 3])).toEqual({ gaps: [], pulls: 3 });
    // ⚠️ `pulls` 仍是 3：Web 这一档**本来就每帧拉一次**（没有去抖）⇒ ③ 说的是
    //    "不产生**跳号**那一次"，**不是**"一帧都不拉"（后者会让远端改动永远看不到）。
    //    ⇒ ②③ 是**成对**的：`gaps` 有／无一次，而不是"拉／不拉整个人"。
  });

  it("④ 水位**只许前进**：重复与乱序都不当跳号", () => {
    expect(isSeqGap(5, 5)).toBe(false);
    expect(isSeqGap(5, 4)).toBe(false);
    // 5 ⇒ 4 之后仍是 5（水位没倒退），再来的 6 是连续的
    let last = 0;
    for (const s of [5, 4, 6]) last = trackFrame(last, push(s)).last;
    expect(last).toBe(6);
    expect(trackFrame(5, push(4)).gap).toBeNull();
  });

  it("⑤ **第一帧没有可比对象**（哪怕它 seq 很大）", () => {
    expect(trackFrame(0, push(1)).gap).toBeNull();
    expect(trackFrame(0, push(99)).gap).toBeNull();
  });

  it("⑥ 读不到 `seq` 的帧**不许**动水位、也不许判跳号", () => {
    const v = trackFrame(3, 'data: {"type":"ping"}');
    expect(v).toEqual({ seq: null, gap: null, last: 3 });
    // 紧接着来一个"看起来跳了"的 seq：它要**相对真实水位 3** 判（4 是连续的）
    expect(trackFrame(3, push(4)).gap).toBeNull();
  });
});
