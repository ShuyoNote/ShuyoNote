import { describe, expect, it } from "vitest";
import { blake2b512, Blake2b512 } from "./blake2b512.mjs";

// RFC 7693 向量 + 与 Python hashlib.blake2b(digest_size=64) 交叉校验的边界长度向量。
// 这些是「实现是否真的是 BLAKE2b」的唯一硬证据：写错了不可能全过。
const VECTORS = [
  ["", "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"],
  ["abc", "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"],
  [
    "The quick brown fox jumps over the lazy dog",
    "a8add4bdddfd93e4877d2746e62817b116364a1fa7bc148d95090bc7333b3673f82401cf7aa2e4cb1ecd90296e3f14cb5413f8ed77be73045b13914cdcd6a918",
  ],
  ["a".repeat(128), "fc6c71f688f43ea7d60817478808f3cac753e61571865c95adbc2d9122c943a76b92c2cb1047ef3fe7bf6e436ec1d0a99a9e5b216780bf7fed9d7ca91d3a8f3b"],
  ["a".repeat(129), "55e6e0eb418149a8af92fd9ddc99254781b2f522a131b4f4d984404b71a00e1167b8124d5dcddd4c6977b299392335d6edd303da6d344d74bbef2d38101b232b"],
  [
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)), // 0x00..0xff 原始字节
    "1ecc896f34d3f9cac484c73f75f6a5fb58ee6784be41b35f46067b9c65c63a6794d3d744112c653f73dd7deb6666204c5a9bfa5b46081fc10fdbe7884fa5cbf8",
  ],
];

const asBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8"));

describe("blake2b512", () => {
  it("符合 RFC 7693 与边界长度向量", () => {
    for (const [input, want] of VECTORS) {
      expect(blake2b512(asBuf(input)).toString("hex"), String(input).slice(0, 24)).toBe(want);
    }
  });

  it("分块 update 与一次性结果一致（含 128 字节整块边界）", () => {
    for (const len of [0, 1, 127, 128, 129, 256, 1000]) {
      const data = Buffer.alloc(len, 7);
      const h = new Blake2b512();
      for (let i = 0; i < len; i++) h.update(data.subarray(i, i + 1));
      expect(h.digest().toString("hex"), `len=${len}`).toBe(blake2b512(data).toString("hex"));
    }
  });

  it("空输入与空 update 等价", () => {
    expect(new Blake2b512().digest().toString("hex")).toBe(VECTORS[0][1]);
  });
});
