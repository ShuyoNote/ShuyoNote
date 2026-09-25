// Windows 脚本门禁：`.ps1` 必须是**纯 ASCII**，或者带 UTF-8 BOM。
//
// 为什么需要它（2026-09-11 在 Windows 侧实际踩到）：PowerShell 5.1 读**无 BOM 的 UTF-8**
// 时按 ANSI（本机代码页）解码——文件里的中文变成乱码，而且**不是显示乱码那么简单**：
// 乱码字节会让整个脚本解析失败（那次是一个脚本报了 9 处语法错误，看起来像"脚本写坏了"，
// 实际只是编码）。跨机器协作时这种失败最难查，因为它只在一台机器上出现。
//
// 规矩与 `docs/RELEASING.md` 里 `.gitattributes` 那条同源：**文本编码这类"环境差异"要在
// 仓库层面钉死**，不要靠"记得别写中文"。
//
// ⚠️ **扫描范围必须排除"本机生成物"**（2026-09-25 加）：本门禁原先只跳
// `node_modules/target/dist/dist-web/.git/vendor`，**漏了 `.gm-build/`** —— 那是国密构建的隔离目录
// （`scripts/sm-library-build.mjs --prepare` 建出来的**私有 CARGO_HOME**，`.gitignore:112` 忽略、
// 一个文件都不入库，`git ls-files .gm-build` = 0）。里面是 cargo 解出来的**第三方 crate 源码**，
// 其中 `jni-0.21.1/.github/workflows/run_windows_invocation_tests.ps1` 就**不是**纯 ASCII
// ⇒ 任何在本机跑过一次国密构建的人，`--group contract` 都会红，而那不是他的代码有问题。
// 这类"红得没道理"正是把门禁训练成"可以忽略"的东西 ⇒ 生成物目录必须显式跳掉。
//
// 用法：node scripts/check-ps1-ascii.mjs    （有违规则即非零退出）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 跳过的目录名。判据直接钉它（`check-ps1-ascii.test.mjs`），免得哪天又被改回"全仓扫"。
 *
 * `.gm-build`：国密隔离目录（私有 CARGO_HOME，含第三方 crate 源码），**本机生成物、不入库**。
 */
export const SKIP_DIRS = new Set(["node_modules", "target", "dist", "dist-web", ".git", "vendor", ".gm-build"]);

/** 递归收集 `<rootDir>` 下的 `.ps1`（跳过 `skipDirs` 里的目录名）。纯文件系统遍历，判据用夹具钉它。 */
export function collectPs1Files(rootDir, skipDirs = SKIP_DIRS, out = []) {
  for (const name of readdirSync(rootDir)) {
    if (skipDirs.has(name)) continue;
    const p = join(rootDir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectPs1Files(p, skipDirs, out);
    else if (name.toLowerCase().endsWith(".ps1")) out.push(p);
  }
  return out;
}

/**
 * 纯函数：这份字节算不算"违规"（非 ASCII 且没有 UTF-8 BOM）。
 *
 * 返回 `{ hasBom, offenders: [{ byte, line }] }`；BOM 文件**直接算合规**（那是允许的写法）。
 */
export function scanPs1Buffer(buf) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) return { hasBom: true, offenders: [] };
  const offenders = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) {
      offenders.push({ byte: b, line: buf.subarray(0, i).toString("latin1").split("\n").length });
    }
  }
  return { hasBom: false, offenders };
}

/** 扫全仓，返回违规清单（`relative` 路径 ＋ 字节数 ＋ 前几行）。 */
export function check(rootDir = root) {
  const files = collectPs1Files(rootDir);
  const bad = [];
  for (const f of files) {
    const { offenders } = scanPs1Buffer(readFileSync(f));
    if (!offenders.length) continue;
    const lines = [...new Set(offenders.map((o) => o.line))].slice(0, 5);
    bad.push({ file: relative(rootDir, f), count: offenders.length, lines });
  }
  return { files, bad };
}

if (isMain(import.meta.url)) {
  const { files, bad } = check();
  if (bad.length) {
    console.error("`.ps1` 必须是纯 ASCII（或带 UTF-8 BOM）——PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读：");
    for (const b of bad) {
      console.error(`  - ${b.file}：${b.count} 个非 ASCII 字节，行 ${b.lines.join(", ")}…`);
    }
    console.error("  修法：脚本里的提示文字改成英文/ASCII，或把文件存成带 BOM 的 UTF-8。");
    process.exit(1);
  }
  console.log(`PowerShell 脚本编码一致：${files.length} 个 .ps1，全部纯 ASCII（或带 BOM）`);
}
