#!/usr/bin/env node
// 验一个 **APK 产物**：壳适配层真的进包了吗？ABI 是不是只有一个？
//
// 为什么要有这条命令（不是"防患于未然"，是已经出过事故）：
//   v1.91.0 的发版 APK 里没有 `ShuyoFsPlugin` 类（release.yml 漏了注入步骤），
//   用户从 1.90.2 应用内更新过去之后**装上就闪退**：
//       Caused by: java.lang.ClassNotFoundException: cn.shuyo.shuyonote.ShuyoFsPlugin
//   而当时所有"看版本号"的自检全绿 —— 只有**翻产物字节**才看得出来。
//
// 同一个判据在三个地方都要能跑，所以抽成这一条命令（单一事实来源）：
//   ① CI 的发版流水线（release.yml 打完包就验，见那里的调用）；
//   ② 发布后拿线上那份再验一次（`pnpm check:apk <文件>`）；
//   ③ 本机拿到 CI artifact 后先验再装真机（自检包 vs 发版件两回事，见 RELEASING.md §9.1）。
//
// 零依赖：自己读 ZIP 的中央目录（Node 自带 zlib 解 inflate），
// 这样 Windows / Linux / CI 上行为一致，不用指望 `unzip` 或 `strings` 在不在。
// 读取实现抽在 `scripts/lib/zip.mjs`，与"取 CI 产物"那个脚本共用同一份。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { listZipEntries, readZipEntry } from "./lib/zip.mjs";

/** 必须能在 dex 里找到的字符串 —— 每一条都对应一个真实能力，缺了都会"真机上静默少功能"。 */
const REQUIRED = [
  ["ShuyoFsPlugin", "启动时注册 Android 壳插件（缺了 = ClassNotFoundException，**装上就闪退**）"],
  ["__SHUYONOTE_INSETS__", "状态栏/手势条 inset 桥（缺了 = 顶部 41 CSS px 回到触摸死区）"],
  ["__SHUYONOTE_BACK__", "返回键先关浮层（缺了 = 返回键直接退出应用）"],
  ["installApk", "应用内更新把 APK 交给系统安装器（缺了 = 点了没反应）"],
];

const apkPath = process.argv[2];
if (!apkPath) {
  console.error("用法: node scripts/check-apk-contents.mjs <apk 路径>");
  process.exit(2);
}
const buf = readFileSync(apkPath);
const sha = createHash("sha256").update(buf).digest("hex");
console.log(`[apk] ${apkPath}`);
console.log(`[apk] 大小 ${buf.length} 字节 · sha256 ${sha}`);

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

let entries;
try {
  entries = listZipEntries(buf);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

// ---- 1. dex：四个能力字符串 ----
const dex = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
ok(dex.length > 0, `含 dex（${dex.map((d) => d.name).join(", ") || "一个都没有"}）`);
const dexText = dex.map((d) => readZipEntry(buf, d).toString("latin1")).join("\n");
for (const [needle, why] of REQUIRED) {
  ok(dexText.includes(needle), `dex 含 \`${needle}\` —— ${why}`);
}

// ---- 2. ABI：必须恰好 arm64-v8a（`--target aarch64` 只是要求，不是证明） ----
const abis = [...new Set(entries.filter((e) => e.name.startsWith("lib/")).map((e) => e.name.split("/")[1]))]
  .filter(Boolean)
  .sort();
ok(
  abis.length === 1 && abis[0] === "arm64-v8a",
  `lib/ 下的 ABI 恰好是 arm64-v8a（实测 ${abis.join(", ") || "没有 lib/"}）`,
);

// ---- 3. 签名（apksigner 打的，包内 META-INF） ----
const sig = entries.filter((e) => /^META-INF\/.*\.(RSA|DSA|EC|SF)$/i.test(e.name));
ok(sig.length > 0, `含 apksigner 签名块（${sig.map((s) => s.name).join(", ") || "没有"}）`);

console.log(`[结果] apk 内容检查 ${failed === 0 ? "通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
