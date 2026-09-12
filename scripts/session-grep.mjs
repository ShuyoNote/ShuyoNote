// 在 DSH 的会话记录里搜关键词（给人用，也能给 agent 用）。
//
// ## 为什么需要这个脚本（这不是"顺手做的小工具"）
//
// 2026-09-12 真实踩到：用户问"百度搜索引擎提交了吗"，我先在本仓和**没解压**的会话文件上搜，
// 得到"没有任何命中"，差点据此得出"这件事从没做过"的结论。而实际上**做过**，只是：
//
//   1. 改动落在**另一个仓库**（`shuyo-community`，不是这个应用仓库）；
//   2. 会话记录是 **zstd 压缩**的，明文搜不到；
//   3. 更糟的是：会话文件是**多帧拼接**（append-only，每次写入一帧），
//      而 `zlib.zstdDecompressSync(buf)` **只解第一帧**——4.6 MB 的文件"成功"解出
//      **196 字符**，**不抛错**。于是"搜索"在一个 0.004% 的内容上跑，结论却是"没有"。
//
// **核心教训：搜索工具坏了，表现和"确实没有"一模一样。**
// 所以这个脚本做两件事来防止误读：
//   · 汇报每个文件**解出了多少字符**（解出 0/极小 = 工具可疑，不是"文件空"）；
//   · 零命中时**主动提示先做对照测试**（用一个必定出现的词，例如 `git`）。
//
// ## 用法
//
//   node scripts/session-grep.mjs <关键词>
//   node scripts/session-grep.mjs <关键词> --max 8          # 每个文件最多显示几条上下文
//   node scripts/session-grep.mjs <关键词> --sessions <目录> # 指定会话目录
//   node scripts/session-grep.mjs <关键词> --files-only      # 只列命中的文件，不打印内容
//
// 默认会话目录（DSH）：`%APPDATA%/dsh-desktop/harness/sessions`（Windows）
// 或 `~/.dsh/sessions`（另一处历史目录）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** zstd 帧魔数 `28 B5 2F FD`。多帧拼接的文件靠它切帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压**可能是多帧拼接**的 zstd 缓冲，返回完整文本。
 *
 * 为什么不能直接用 `zstdDecompressSync(buf)`：DSH 的会话是 append-only JSONL，
 * 每次写入是一个独立 zstd 帧，整个文件是多帧拼接；而 `zstdDecompressSync` 只解**第一帧**
 * 且**不报错**。后果见文件顶部注释 —— 这是本脚本存在的理由。
 *
 * ⚠️ 还有一层（探针实测，比上面那层更阴）：**截断的帧也不抛错**，只返回解出来的那部分。
 * 实测 31 字节的帧截到 4 字节 → 返回空串；截到 16 字节 → 返回半个汉字。**都不报错。**
 * ⇒ 所以 `brokenFrames` 抓不到"截断"，**唯一可信的信号是解出的字符规模**（调用方要汇报它）。
 * 单帧结构性损坏（完全无法识别的头）才会走到 `brokenFrames`。
 */
export function decompressMaybeMultiFrame(buf) {
  const starts = [];
  for (let i = buf.indexOf(ZSTD_MAGIC, 0); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) {
    starts.push(i);
  }
  if (starts.length === 0) return { text: buf.toString("utf8"), frames: 0, brokenFrames: 0 };

  const parts = [];
  let broken = 0;
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8"));
    } catch {
      broken++;
    }
  }
  return { text: parts.join(""), frames: starts.length, brokenFrames: broken };
}

/** 递归收集会话文件（`.jsonl.zstd` 与未压缩的 `.jsonl`）。 */
export function collectSessionFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl.zstd") || e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 默认会话目录候选（存在哪个用哪个）。 */
export function defaultSessionDirs() {
  const cands = [
    join(process.env.APPDATA ?? "", "dsh-desktop", "harness", "sessions"),
    join(homedir(), ".dsh", "sessions"),
  ];
  return cands.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function main() {
  const argv = process.argv.slice(2);
  const needle = argv.find((a) => !a.startsWith("--"));
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const maxShow = Number(flag("--max", "4"));
  const filesOnly = argv.includes("--files-only");
  const explicitDir = flag("--sessions", null);

  if (!needle) {
    console.error("用法: node scripts/session-grep.mjs <关键词> [--max N] [--sessions 目录] [--files-only]");
    process.exit(2);
  }

  const dirs = explicitDir ? [explicitDir] : defaultSessionDirs();
  if (!dirs.length) {
    console.error("找不到会话目录。用 --sessions <目录> 指定。");
    process.exit(2);
  }

  const files = dirs
    .flatMap(collectSessionFiles)
    .map((f) => ({ f, mt: statSync(f).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)
    .map((x) => x.f);

  console.log(`在 ${files.length} 个会话文件里搜「${needle}」（目录：${dirs.join("、")}）\n`);

  let total = 0;
  let totalChars = 0;
  const hitFiles = [];
  for (const f of files) {
    let res;
    try {
      res = decompressMaybeMultiFrame(readFileSync(f));
    } catch (e) {
      console.log(`  !! 读取失败 ${f}: ${e.message}`);
      continue;
    }
    totalChars += res.text.length;
    const lines = res.text.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) hits.push(i);
    if (!hits.length) continue;
    total += hits.length;
    hitFiles.push(f);

    const mt = new Date(statSync(f).mtime).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `=== ${mt}  …/${f.split(/[\\/]/).slice(-3, -1).join("/")}  ${hits.length} 处` +
        `（解出 ${res.text.length.toLocaleString("en-US")} 字符 / ${res.frames} 帧${res.brokenFrames ? `，坏帧 ${res.brokenFrames}` : ""}）===`,
    );
    if (!filesOnly) {
      for (const i of hits.slice(0, maxShow)) {
        const at = lines[i].indexOf(needle);
        const snip = lines[i]
          .slice(Math.max(0, at - 240), at + 360)
          .replace(/\\n/g, " ↵ ")
          .replace(/\\"/g, '"');
        console.log(`  L${i + 1}: …${snip}…`);
      }
      if (hits.length > maxShow) console.log(`  （还有 ${hits.length - maxShow} 处未显示，用 --max 调）`);
    }
    console.log();
  }

  console.log(`合计 ${total} 处命中；会话内容总计解出 ${totalChars.toLocaleString("en-US")} 字符`);
  if (!total) {
    console.log(
      [
        "",
        "⚠️ 零命中时**先别下「没有这件事」的结论** —— 先做对照测试：",
        "      node scripts/session-grep.mjs git      # 「git」几乎必定出现",
        "   如果对照也零命中，或上面那个「解出 N 字符」的数量小得离谱，那是**工具坏了**，",
        "   不是「记录里没有」。2026-09-12 就因为这个静默失败差点得出错误结论（见文件头注释）。",
      ].join("\n"),
    );
  }
}

// 只在直接运行时执行 main（被 import 时只导出工具函数，供测试使用）。
const invokedDirectly = process.argv[1] && /session-grep\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();
