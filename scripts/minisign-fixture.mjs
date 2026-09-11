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

import { writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fingerprintOf, generateEphemeralKeypair, signBytes } from "./lib/minisign.mjs";

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

// **护栏**：这个脚本会**就地覆盖** `<文件>.minisig`，而仓库里的夹具签名与一把一次性公钥
// 是配对的（`plugin_index.rs` 里还写死了它的指纹）。我曾经顺手跑了一次，就把提交过的
// 夹具签名换掉了——测试立刻变红，而且看起来像"校验器坏了"。
// 所以覆盖夹具目录下的签名必须显式写 `--in-place`，否则直接拒绝。
const isFixture = file.includes(`${join("src-tauri", "tests", "fixtures")}`);
if (isFixture && !args.includes("--in-place")) {
  console.error(
    [
      "拒绝执行：这会把仓库里的夹具签名就地换掉，而它与一把一次性公钥是配对的",
      "（`plugin_index.rs` 里还写死了那个指纹）。",
      "",
      "  要真的重签夹具：加 --in-place，并同步改掉指纹断言与 tests/fixtures/README.md。",
      "  只是想试一下：把文件复制到临时目录再签。",
    ].join("\n"),
  );
  process.exit(4);
}

const bytes = readFileSync(file);

// 一次性密钥：只活在这条命令里，私钥不落盘（要复现就重新生成一份并重签）。
const key = generateEphemeralKeypair();

const sigPath = `${file}.minisig`;
writeFileSync(
  sigPath,
  signBytes(bytes, { privateKey: key.privateKey, keyId: key.keyId, fileName: basename(file) }),
  "utf8",
);

const pubPath = join(outDir, `${basename(file).replace(/\W+/g, "-")}.pub`);
writeFileSync(pubPath, key.pubText, "utf8");

const fp = fingerprintOf(key.pubText);
console.log(`已签：${file}`);
console.log(`签名：${sigPath}`);
console.log(`公钥：${key.pubBox.toString("base64")}`);
console.log(`公钥文件：${pubPath}`);
console.log(`指纹：${fp}`);
