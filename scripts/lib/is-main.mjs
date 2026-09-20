// 「这个模块是**被直接 node 跑的**，还是被 import 的？」—— 一处实现，七处调用点共用。
//
// ★ 为什么单独抽出来（2026-09-20，复核 Windows 那条新门禁时实测发现的**静默空转**）：
//   本仓 7 个脚本都用过这个写法：
//     if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
//   它在**路径经过符号链接**时**恒为假** ⇒ 脚本**什么都不做、退出码 0**（连一行输出都没有）。
//   实测（macOS，`/tmp` 是指向 `/private/tmp` 的符号链接）：
//
//   | cwd | 传给的路径 | argv[1] | import.meta.url | 相等 | 实际 |
//   |---|---|---|---|---|---|
//   | 仓库内 | `scripts/x.mjs`（相对） | `/private/tmp/...` | `/private/tmp/...` | ✅ | 跑 |
//   | 任意 | `/tmp/.../scripts/x.mjs`（绝对） | `/tmp/...` | `/private/tmp/...` | ❌ | **静默 exit 0** |
//
//   根因：Node 把 **`import.meta.url` 解析成 realpath**，而 `process.argv[1]` **原样保留**你给的形式。
//   ⇒ 门禁"静默空转 + 退出码 0"正是我们最不能接受的那类失败（**绿得不是它声称的那件事**）。
//   今天没炸是因为 `test-report.mjs` 用**相对路径 + cwd=仓库根**调门禁；
//   但绝对路径调用（任务运行器、Makefile、Windows 的 junction/subst、我自己的手工复跑）就会中招。
//
// 修法：**两边都过 realpath 再比**（`realpathSync` 失败时退回 `resolve` 比较，绝不因为"文件系统问了句
// 我不知道的"就判成"不是我" —— 那会把"直接运行"误判成"被 import"，同样是静默空转）。
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 规范化一个路径：优先 realpath（解符号链接），失败退回 `resolve`。 */
export function canonicalPath(p) {
  const abs = resolve(String(p ?? ""));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * `argv1`（默认取 `process.argv[1]`）指向的**就是** `metaUrl` 这个模块吗？
 *
 * @param {string} metaUrl 调用方的 `import.meta.url`
 * @param {string} [argv1] 覆盖用（单测注入）
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return canonicalPath(argv1) === canonicalPath(fileURLToPath(metaUrl));
}
