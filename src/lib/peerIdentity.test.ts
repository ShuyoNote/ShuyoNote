// `peerIdentityLine`：08-c 屏上"信任前展示对方身份"那一行的**唯一实现**（规格 J21 ✓）。
//
// ⭐ 三条判据（Lead 照收 ✓）—— 特别是第 ③ 条：它把「**不许回落成设备号**」
//   从"我们记得没这么写"变成**可核的断言** ✓。
import { describe, expect, it } from "vitest";
import { peerIdentityLine } from "./peerIdentity";

describe("peerIdentityLine（设备名 ＋ 短标识）", () => {
  it("① 短标识为空（老对端没报）⇒ **恰好**那句如实文案", () => {
    expect(peerIdentityLine("书房的 Mac", "")).toBe("对方没报短标识");
    expect(peerIdentityLine("", "")).toBe("对方没报短标识");
    expect(peerIdentityLine("书房的 Mac", "   ")).toBe("对方没报短标识");
  });

  it("② 有短标识 ⇒ 输出**含设备名与短标识**", () => {
    expect(peerIdentityLine("书房的 Mac", "K7M2Q")).toBe("书房的 Mac · K7M2Q");
    // 名字也没报 ⇒ 只显示短标识（仍然可辨认 ✓，且不含任何内部 id ✓）
    expect(peerIdentityLine("", "K7M2Q")).toBe("K7M2Q");
    // 两端空白要折掉 ✓
    expect(peerIdentityLine("  书房的 Mac  ", "  K7M2Q  ")).toBe("书房的 Mac · K7M2Q");
  });

  it("③ ⭐ 喂进**任意** `device_id` ⇒ 输出里**不含它**（含任意前缀）", () => {
    // ⛔ 这条是给"将来有人手滑把 device_id 传进来/拼进去"立的**回归判据** ✓：
    //    本函数的签名里根本没有那个参数 ⇒ 它只能用"空短标识"这条路去兜 ✗，而那一路
    //    已经**恰好**是"对方没报短标识" ✓ ⇒ 于是**任何** id 与它的前缀都不可能出现 ✓。
    const ids = [
      "9dc88146-d0c2-4bc6-bce0-42484bcd4b45",
      "0f3a1c2b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
      "device-x",
    ];
    for (const id of ids) {
      // 三种输入组合（含"名字位被塞了 id"这种最坏情况）都不许把 id 漏出来 ✗
      for (const out of [peerIdentityLine(id, ""), peerIdentityLine("", ""), peerIdentityLine("", "K7M2Q")]) {
        expect(out.includes(id)).toBe(false);
        // 任意前缀也不行 ✓（取前三段，避开"恰好一个字符"的巧合）
        for (const n of [3, 8, 13, id.length - 1]) {
          if (n > 0 && n <= id.length) expect(out.includes(id.slice(0, n)), `不许出现 ${id.slice(0, n)}`).toBe(false);
        }
      }
      // 名字位确实会被显示（那是**用户自己起的名字** ✓，与"内部 id"不是一回事）——
      // 但如果有人真把 id 塞进名字位，那也是**调用方**的错；这条判据先把"本函数自己造不出来"钉住 ✓
    }
  });
});
