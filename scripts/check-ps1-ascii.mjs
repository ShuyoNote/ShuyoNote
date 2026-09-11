// Windows 侧脚本门禁：`.ps1` 必须是**纯 ASCII**，或者带 UTF-8 BOM。
//
// 为什么需要它（2026-09-11 在 Windows 侧实际踩到）：PowerShell 5.1 读**无 BOM 的 UTF-8**
// 时按 ANSI（本机代码页）解码——文件里的中文变成乱码，而且**不是显示乱码那么简单**：
// 乱码字节会让整个脚本解析失败（那次是一个脚本报了 9 处语法错误，看起来像"脚本写坏了"，
// 实际只是编码）。跨机器协作时这种失败最难查，因为它只在一台机器上出现。
//
// 规矩与 `docs/RELEASING.md` 里 `.gitattributes` 那条同源：**文本编码这类"环境差异"要在
// 仓库层面钉死**，不要靠"记得别写中文"。
//
// 用法：node scripts/check-ps1-ascii.mjs   （有违规即非零退出）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "dist-web", ".git", "vendor"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith(".ps1")) out.push(p);
  }
  return out;
}

const files = walk(root);
const bad = [];
for (const f of files) {
  const buf = readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) continue; // 带 BOM 的 UTF-8 是允许的写法
  const offenders = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) {
      offenders.push({ byte: b, line: buf.subarray(0, i).toString("latin1").split("\n").length });
    }
  }
  if (offenders.length) {
    const lines = [...new Set(offenders.map((o) => o.line))].slice(0, 5);
    bad.push({ file: relative(root, f), count: offenders.length, lines });
  }
}

if (bad.length) {
  console.error("`.ps1` 必须是纯 ASCII（或带 UTF-8 BOM）——PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读：");
  for (const b of bad) {
    console.error(`  - ${b.file}：${b.count} 个非 ASCII 字节，行 ${b.lines.join(", ")}…`);
  }
  console.error("  修法：脚本里的提示文字改成英文/ASCII，或把文件存成带 BOM 的 UTF-8。");
  process.exit(1);
}
console.log(`PowerShell 脚本编码一致：${files.length} 个 .ps1，全部纯 ASCII（或带 BOM）`);
