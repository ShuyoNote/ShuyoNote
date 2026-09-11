import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b512, generateEphemeralKeypair, signBytes } from "./minisign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 把 minisign 盒子解出来：base64 那行（跳过 `untrusted comment:` 那行）。 */
const boxBytes = (text) => {
  const line = text.split("\n").find((l) => l && !l.includes(":"));
  return Buffer.from(line, "base64");
};

// 为什么要有这些断言：这个算法字节写错时**什么都不会报**——应用侧的
// `minisign-verify` 同时接受 `Ed` 与 `ED`，于是本仓所有验签测试照过，
// 而用户手里的真 minisign 会拒绝那把公钥（`Unsupported signature algorithm`）。
// 2026-09-11 就是这么被社区侧用真 minisign 验出来的。所以这里盯住**字节本身**。
describe("minisign 盒子的算法字节（写错了不会报错，只会不合规）", () => {
  it("公钥盒是 `Ed`（0x45 0x64），不是 `ED`", () => {
    const key = generateEphemeralKeypair();
    const box = boxBytes(key.pubText);
    expect(box.length).toBe(42, "公钥盒固定 42 字节：alg(2) + key_id(8) + pubkey(32)");
    expect([...box.subarray(0, 2)]).toEqual([0x45, 0x64]); // "Ed"
  });

  it("签名盒是 `ED`（0x45 0x44，预哈希）", () => {
    const key = generateEphemeralKeypair();
    const sig = signBytes(Buffer.from("hello"), {
      privateKey: key.privateKey,
      keyId: key.keyId,
      fileName: "x.zip",
    });
    const box = boxBytes(sig);
    expect(box.length).toBe(74, "签名盒固定 74 字节：alg(2) + key_id(8) + sig(64)");
    expect([...box.subarray(0, 2)]).toEqual([0x45, 0x44]); // "ED"
    expect(sig).toContain("trusted comment: ");
  });

  it("BLAKE2b-512 有官方向量自检（签任何东西之前先过它）", () => {
    const ABC =
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
      "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923";
    expect(blake2b512(Buffer.from("abc")).toString("hex")).toBe(ABC);
  });

  it("仓库里的夹具公钥也已经是合规的 `Ed`（它曾经是 legacy 的 `ED`）", () => {
    // 2026-09-11 之前这份夹具的算法字节是 `ED`（不合规，但应用两种都收，所以测试全绿）；
    // 社区侧用真 minisign 验它时报 `Unsupported signature algorithm` 才被发现，
    // 随后夹具与 lib 一起重签/修正。这条断言盯住"夹具别再退回 legacy"。
    const pub = readFileSync(join(root, "src-tauri", "tests", "fixtures", "signed-plugin-zip.pub"), "utf8");
    expect([...boxBytes(pub).subarray(0, 2)]).toEqual([0x45, 0x64]); // "Ed"
  });

});
