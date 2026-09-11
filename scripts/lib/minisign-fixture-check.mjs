// 检查仓库里两个签名夹具的**公钥盒算法字节**是否为 minisign 规范的 `Ed`(0x45 0x64)。
//
// 为什么值得留一个脚本：这两个夹具是应用侧所有验签测试的输入，而它们的公钥字节
// 曾经是错的（写成了签名的 `ED`），却因为 `minisign-verify` 两种都收而**测试全绿**。
// 也就是说"测试通过"证明不了"公钥字节合规"。这个脚本把那一格单独钉住。
import { readFileSync } from "node:fs";
import { fingerprintOf } from "./minisign.mjs";

const FIXTURES = ["signed-plugin-zip.pub", "signed-plugin-alt-zip.pub"];
const dir = "src-tauri/tests/fixtures";
let bad = 0;

for (const f of FIXTURES) {
  const text = readFileSync(`${dir}/${f}`, "utf8");
  const body = text.split("\n").find((l) => l.trim() && !l.includes(":"));
  const box = Buffer.from(body ?? "", "base64");
  const ok = box.length === 42 && box[0] === 0x45 && box[1] === 0x64;
  console.log(
    `${ok ? "OK  " : "BAD "} ${f}  盒长=${box.length}  算法=0x${box[0]?.toString(16)} 0x${box[1]?.toString(16)}  指纹=${fingerprintOf(text)}`,
  );
  if (!ok) bad++;
}
if (bad) {
  console.error(`\n${bad} 个夹具的公钥盒不合规：minisign 公钥盒前两字节必须是 0x45 0x64（"Ed"）；\n` +
    '写成 0x45 0x44（"ED"）时真 minisign 会以 Unsupported signature algorithm 拒绝，\n' +
    "而应用侧的 minisign-verify 两种都收 —— 于是测试会全绿但夹具其实不合规。");
  process.exit(1);
}
console.log("\n两个夹具的公钥盒都合规（Ed）。");
