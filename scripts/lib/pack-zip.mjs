// 插件包（zip）的**跨平台**打包：给 `plugin-fragment.mjs` 与 `plugin-index-demo.mjs` 共用。
//
// ## 为什么要有这个文件（而不是各自写一遍）
//
// 原来两处都 shell out 到命令行 `zip`：
//
//   plugin-fragment.mjs    : execFileSync("zip", ["-r","-X","-q", ...])
//   plugin-index-demo.mjs  : execFileSync("zip", ["-qr", ...])
//
// 这在 macOS / Linux 上没问题，但 **Windows 上系统没有 `zip`**，于是两个工具都跑不起来。
// 实测后果（2026-09-11，这台 Windows）：`pnpm test` 三条用例红（`spawnSync zip ENOENT`）
// ——自检模式 / dry-run / 「找不到插件目录」，最后那条最坑：它期待的是"没找到插件目录"
// 的提示，实际**先死在 zip 上**，于是那条断言**永远测不到它本该测的东西**，
// 只留下一个看起来很吓人的 ENOENT 堆栈。demo 那条更直白，它自己写着
// "Windows 可用 Git Bash 或 WSL"。
//
// 而"发版产出索引片段"是 Windows 侧**也要能做的事**（`release.mjs` 那条路，而 Windows
// 就是主要发版机），所以这不能靠"我们的开发机是 mac"来回避。
//
// **抽成一个模块的理由是"只可能修一次"**：这类平台假设当时在两个文件里各出现了一次，
// 修完一处另一处还在（`expand()` 里的 `ls -1` 就是同一形状的第二次），
// 所以把"怎么打一个包"收敛到一处，比在两个脚本里各留一份要靠得住。
//
// ## 为什么用 fflate，而不是 `Compress-Archive`
//
// fflate 是仓库**已有**依赖：`src/lib/platform/web.ts`（流式 `Zip`）与
// `src/plugins/builtinCommands.ts`（`zipSync`）都用它打包。复用同一套实现意味着
// Node 侧与浏览器侧产出的 zip 口径一致，且**不引入新依赖**，也不看 PATH。
//
// 不用 PowerShell 的 `Compress-Archive` 将就：它的字节布局与这里不同，会让同一份源码
// 在不同机器上产出不同 `sha256`，而那个哈希要写进索引、被用户端逐字节校验
// ——对不上会被直接拒装，表现为"这个包怎么装不上"，很难倒查到打包机。
//
// ## 一条为「可复现」而定的口径：`mtime` 固定
//
// 绝不把"打包那一刻"写进 zip：否则同一份源码今天与明天打出来的 `sha256` 不同，
// "这个包是不是被换过"就失去了意义（索引里的 size/sha256 正是防篡改用的）。
// 用 `mtime` 选项（而不是 zipSync 的顶层参数）是因为 fflate 的 `ZipAttributes.mtime`
// 会顺带关掉"扩展时间戳"字段，比只设顶层时间更彻底。

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

/**
 * 打进 zip 的固定写入时间。
 *
 * 只要求**是常量**（可复现）；取一个"看起来很新但明显不是当下"的值，便于排查时
 * 一眼认出"这是打包器写的时间戳，不是文件真实时间"。
 *
 * ⚠️ 不要改成 `0` 或 `new Date(0)`：zip 的时间字段最早只能表示 **1980-01-01**，
 * fflate 会以 `date not in range 1980-2099` 直接拒掉（踩过一次）。
 */
export const FIXED_MTIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** 不该进发布包的东西：macOS 的目录元数据。等价于原来 `zip -x '*.DS_Store'`。 */
const EXCLUDED = new Set([".DS_Store"]);

/** 相对 `dir` 的条目名，**一律用 `/`**（Windows 的 `\` 会变成解不出来的条目）。 */
function entryName(dir, abs) {
  return relative(dir, abs).split(sep).join("/");
}

/**
 * 把 `dir` 打成一个 zip 写到 `zipPath`。
 *
 * **包内根目录就是插件目录名**（`<base>/manifest.json`）：规范允许"多一层同名目录"，
 * 应用解包时会自动下钻（只在"恰好一层且里面有 manifest.json"时下钻），
 * 这也正是原来 `zip -r pkg.zip <basename>` 的形状。
 *
 * @param {string} dir 要打包的目录（绝对路径）
 * @param {string} zipPath 输出 zip 的路径
 * @returns {{ fileCount: number, bytes: number }} 文件数与产出的字节数
 */
export function packDirToZip(dir, zipPath) {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  /** @type {Record<string, [Uint8Array, { mtime: Date }]>} */
  const files = {};

  const walk = (absDir) => {
    // 排序：zip 的目录表顺序会进字节，排一下让结果稳定（多插件时顺序也才可复现）。
    for (const name of readdirSync(absDir).sort()) {
      if (EXCLUDED.has(name)) continue;
      const abs = join(absDir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        files[`${base}/${entryName(dir, abs)}`] = [
          new Uint8Array(readFileSync(abs)),
          { mtime: FIXED_MTIME },
        ];
      }
    }
  };
  walk(dir);

  const fileCount = Object.keys(files).length;
  if (fileCount === 0) {
    throw new Error(`插件目录是空的，拒绝打一个空包：${dir}`);
  }
  const out = zipSync(files, { level: 6 });
  writeFileSync(zipPath, Buffer.from(out));
  return { fileCount, bytes: out.length };
}
