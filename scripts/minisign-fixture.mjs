// 测试向量生成器：造一对**一次性** minisign 密钥并给一个文件签名。
//
// ⚠️ 这不是发布工具：正式发布请用 minisign 本体（`minisign -Sm 包.zip`）。这里存在的唯一
// 理由是——CI 与开发机上没有 minisign 可执行文件，而「我们自己签的包，我们自己的校验器
// 认不认」这件事必须被验证过。用一个**独立实现**（Node 的 Ed25519 + 本文件里的 BLAKE2b）
// 签出来的向量去喂我们的校验器，顺带也证明我们对 minisign 格式的理解没跑偏。
//
// 用法：
//   node scripts/minisign-fixture.mjs <要签的文件> [--out <目录>]
// 输出：
//   <文件>.minisig    签名盒（untrusted comment / 签名 / trusted comment / 全局签名 四行）
//   <目录>/<名字>.pub 公钥盒（内容可以直接当索引里的 publisherKey 用）
//
// 格式（minisign 的公开格式，与 Tauri updater 用的是同一套）：
//   公钥盒   = base64( alg(2) || key_id(8) || pubkey(32) )                      = 42 字节
//   签名盒   = base64( alg(2) || key_id(8) || sig(64) )                         = 74 字节
//   全局签名 = Ed25519( **64 字节的签名** || trusted comment 的 UTF-8 字节 )
//              （注意不是 74 字节的整个盒子：盒子前面还有 alg 与 key_id。
//                我第一版就写成盒子了，结果是"自己签的自己验不过"——夹具测试当场把它抓了出来。）
//   alg：`Ed`(0x45 0x64) = 直接签原文（legacy）；`ED`(0x45 0x44) = 先 blake2b-512 再签
// 我们只产出与应用同口径的**预哈希**（`ED`）签名。

import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// BLAKE2b-512（自己实现一份：这个 Node 构建的 crypto 不带 blake2 家族）
//
// 为什么敢自己写：它有官方向量可对（下面的自检），而且它的用途只有一个——生成测试向量。
// ---------------------------------------------------------------------------
const MASK64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK64;

function blake2b512(data) {
  const h = IV.slice();
  h[0] ^= 0x01010040n; // 无密钥、64 字节输出
  const compress = (m, t, last) => {
    const v = [...h, ...IV];
    v[12] ^= t & MASK64;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= MASK64;
    const G = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) & MASK64;
      v[d] = rotr(v[d] ^ v[a], 32);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr(v[b] ^ v[c], 24);
      v[a] = (v[a] + v[b] + y) & MASK64;
      v[d] = rotr(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr(v[b] ^ v[c], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r];
      const M = (i) => m[s[i]];
      G(0, 4, 8, 12, M(0), M(1));
      G(1, 5, 9, 13, M(2), M(3));
      G(2, 6, 10, 14, M(4), M(5));
      G(3, 7, 11, 15, M(6), M(7));
      G(0, 5, 10, 15, M(8), M(9));
      G(1, 6, 11, 12, M(10), M(11));
      G(2, 7, 8, 13, M(12), M(13));
      G(3, 4, 9, 14, M(14), M(15));
    }
    for (let i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8];
  };

  let t = 0n;
  let offset = 0;
  while (data.length - offset > 128) {
    const m = [];
    for (let i = 0; i < 16; i++) m.push(data.readBigUInt64LE(offset + i * 8));
    t += 128n;
    compress(m, t, false);
    offset += 128;
  }
  // 最后一块：补零到 128 字节并置 last 标志（计数器只加**实际**字节数）
  const rest = Buffer.alloc(128);
  const tail = data.subarray(offset);
  tail.copy(rest);
  const m = [];
  for (let i = 0; i < 16; i++) m.push(rest.readBigUInt64LE(i * 8));
  t += BigInt(tail.length);
  compress(m, t, true);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out;
}

// 官方向量自检：BLAKE2b-512("abc")。实现错了就在这里响，而不是悄悄签出一份假向量。
const ABC =
  "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
  "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923";
if (blake2b512(Buffer.from("abc")).toString("hex") !== ABC) {
  console.error("BLAKE2b-512 自检失败：实现与官方向量不符，拒绝用它签任何东西");
  process.exit(3);
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out");
if (!target) {
  console.error("用法：node scripts/minisign-fixture.mjs <要签的文件> [--out <目录>]");
  process.exit(2);
}
const file = resolve(target);
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(dirname(file));
const bytes = readFileSync(file);

// 一次性密钥：只活在这条命令里，私钥不落盘（要复现就重新生成一份并重签）。
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const keyId = randomBytes(8);

const ALG_PREHASHED = Buffer.from([0x45, 0x44]); // "ED"
const pubBox = Buffer.concat([ALG_PREHASHED, keyId, rawPub]);
const signature = edSign(null, blake2b512(bytes), privateKey);
const sigBox = Buffer.concat([ALG_PREHASHED, keyId, signature]);

const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(file)}`;
const globalSignature = edSign(
  null,
  Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
  privateKey,
);

const sigPath = `${file}.minisig`;
writeFileSync(
  sigPath,
  [
    "untrusted comment: signature from minisign secret key",
    sigBox.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n"),
  "utf8",
);

const pubB64 = pubBox.toString("base64");
const pubPath = join(outDir, `${basename(file).replace(/\W+/g, "-")}.pub`);
writeFileSync(pubPath, `untrusted comment: minisign public key\n${pubB64}\n`, "utf8");

// 指纹口径与后端 `publisher_key_fingerprint` 一致：公钥盒 42 字节的 sha256 前 16 位。
const fp = createHash("sha256").update(pubBox).digest("hex").slice(0, 16).match(/.{4}/g).join("-");
console.log(`已签：${file}`);
console.log(`签名：${sigPath}`);
console.log(`公钥：${pubB64}`);
console.log(`公钥文件：${pubPath}`);
console.log(`指纹：${fp}`);
