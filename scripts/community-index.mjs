// 把 `plugin-fragment.mjs` 产出的片段/预览索引，转成**可托管**的正式索引。
//
// ## 为什么需要这一步
//
// `plugin-fragment.mjs` 产出的是一份**片段**（给社区合并用）和一份**预览索引**，
// 后者的 owner 是占位的「本机验证（占位 owner）」——它的用途写得很清楚：
// "只用于本机验签与试装，别对外托管"。对外托管的那份得有真实的 `owner`
// （应用界面会把 `owner.name` + 域名显示成"来源"，用户要看出自己订阅了谁）。
//
// 而 `owner` 是**索引正文的一部分**，改了它就必须**重新签名** —— 这正是这一步在做的事。
//
// ## 用法
//
//   node scripts/community-index.mjs \
//     --fragment <out>/plugin-index.fragment.json \
//     --out <dir> \
//     --owner-id community --owner-name 数友社区 --owner-url https://community.shuyo.cn/ \
//     --minisign <minisign.exe> --key community.key
//
// 产出：`<dir>/plugin-index.json` 与 `<dir>/plugin-index.json.minisig`（同名同目录，
// 因为应用会去 `<index url>.minisig` 取签名）。
//
// ## 一条硬约束：签名必须覆盖**最终字节**
//
// 所以这里先写文件、再把**磁盘上的那份字节**交给 minisign 签，绝不"签一份我内存里的
// 序列化结果、再写出另一份"——两者一旦不一致（比如写出时改了缩进/换行），
// 用户端校验就会失败，而这种失败看起来像"索引坏了"。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

function die(msg) {
  console.error(`[community-index] ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`[community-index] ${msg}`);
}

const fragmentPath = flag("--fragment", null);
if (!fragmentPath || !existsSync(fragmentPath)) die(`找不到片段文件：${fragmentPath}（--fragment）`);
const outDir = resolve(flag("--out", dirname(resolve(fragmentPath))));
const minisignBin = flag("--minisign", null);
const keyPath = flag("--key", null);
if (!minisignBin) die("缺 --minisign <可执行文件>");
if (!keyPath || !existsSync(keyPath)) die(`找不到私钥：${keyPath}（--key）`);
if (!existsSync(minisignBin)) die(`找不到 minisign：${minisignBin}`);

// owner：**索引正文的一部分**，界面会把 name + 域名显示成"来源"。
// 所以 name 用能一眼看懂的中文短名，url 指向用户点得动的社区首页。
const owner = {
  id: flag("--owner-id", "community"),
  name: flag("--owner-name", "数友社区"),
  url: flag("--owner-url", "https://community.shuyo.cn/"),
};
for (const [k, v] of Object.entries(owner)) {
  if (!v || !String(v).trim()) die(`owner.${k} 不能为空（界面会显示它，用户要看出订阅了谁）`);
}
if (!/^https:\/\//.test(owner.url)) die(`owner.url 必须是 https（现在是 ${owner.url}）`);

const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
if (!Array.isArray(fragment.plugins) || fragment.plugins.length === 0) {
  die("片段里一个插件都没有——空索引会被应用拒绝（\"索引里一个插件都没有\"）");
}

const index = {
  indexVersion: 1,
  owner,
  generatedAt: fragment.generatedAt ?? new Date().toISOString(),
  plugins: fragment.plugins,
};

const indexPath = join(outDir, "plugin-index.json");
// 与片段/预览保持同一种序列化（2 空格 + 末尾换行），免得"同一份内容两种字节"。
writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

// 签**磁盘上那份字节**（minisign 直接读文件，天然满足这条）。
execFileSync(minisignBin, ["-Sm", indexPath, "-s", keyPath], { stdio: ["ignore", "pipe", "pipe"] });
const sigPath = `${indexPath}.minisig`;
if (!existsSync(sigPath)) die(`minisign 没有产出签名：${sigPath}`);

/**
 * 签名文件最前面**不能有 BOM**。
 *
 * 不是洁癖：Windows 上 `Set-Content` / `Out-File -Encoding utf8` 默认会写 BOM，
 * 而一旦 `.minisig` 首字节是 `EF BB BF`，应用那边 `Signature::decode()` 拿到的就是
 * 一个以 BOM 开头的 base64 —— 失败信息是"签名不合法"，**真因却是 BOM**，
 * 而"把公钥/签名文件从 Windows 拷到服务器"正是最容易带上 BOM 的路径。
 * minisign 本体写的是纯 UTF-8；这里只做兜底检查：发现了就明确失败，而不是悄悄改字节
 * （悄悄改会让"磁盘上的字节"与"被签的字节"这个不变式变得难追溯）。
 */
const sigBytes = readFileSync(sigPath);
if (sigBytes.length >= 3 && sigBytes[0] === 0xef && sigBytes[1] === 0xbb && sigBytes[2] === 0xbf) {
  die(`签名文件带 BOM（${sigPath}）—— 应用解析会失败，而真因是 BOM 不是内容`);
}
if (!sigBytes.toString("utf8").includes("untrusted comment:")) {
  die(`签名文件不像 minisign 签名（没有 untrusted comment 行）：${sigPath}`);
}
// 索引本身同理：带 BOM 的 JSON 有些解析器会直接报 "expected value at line 1 column 1"。
const idxBytes = readFileSync(indexPath);
if (idxBytes.length >= 3 && idxBytes[0] === 0xef && idxBytes[1] === 0xbb && idxBytes[2] === 0xbf) {
  die(`索引文件带 BOM（${indexPath}）—— 应用解析会失败`);
}

const urlBase = fragment.urlBase ?? "";
info(`owner：${owner.name}（${owner.url}）`);
info(`插件 ${index.plugins.length} 个；downloadUrl 前缀 ${urlBase || "（片段里没写）"}`);
info(`索引：${indexPath}`);
info(`签名：${sigPath}`);
info(
  [
    "托管时两条缓存规矩（否则「新插件永远看不到、检查更新永远说没变化」）：",
    "  plugin-index.json 与 .minisig → no-store（或 ≤60 秒）",
    "  *.zip → 长缓存 immutable（内容不变、名字带版本号）",
  ].join("\n"),
);
