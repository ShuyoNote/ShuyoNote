// 文档相对链接检查：扫描仓库内所有 .md，校验形如 `[文字](相对路径.md)` 的链接
// 目标文件真实存在（忽略 http(s) 外链与纯锚点）。
//
// 起因：`docs/plans/*.md` 里长期存在「按自己在 docs/ 根目录」写的链接
// （`](plans/xxx.md)`、`](design-philosophy.md)`），实际应为 `](xxx.md)` /
// `](../design-philosophy.md)`——渲染出来是死链，评审时才发现。
//
// 用法：node scripts/check-doc-links.mjs   （有死链即非零退出）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /(^|[\\/])(node_modules|tmp|dist|dist-web|target|\.git)([\\/]|$)/;
const LINK = /\]\((?!https?:|#|mailto:)([^)#\s]+\.md)(?:#[^)\s]*)?\)/g;

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (SKIP.test(relative(root, p))) continue;
    if (entry.isDirectory()) collect(p, acc);
    else if (entry.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

const files = collect(root);
const broken = [];
let links = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK)) {
    links++;
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) {
      // 行号便于直接定位
      const line = text.slice(0, m.index).split("\n").length;
      broken.push(`${relative(root, file)}:${line} → ${m[1]}`);
    }
  }
}

if (broken.length) {
  console.error(`文档死链 ${broken.length} 处（共扫描 ${files.length} 个 .md / ${links} 条相对链接）：`);
  for (const b of broken) console.error("  - " + b);
  process.exit(1);
}
console.log(`文档链接完整：${files.length} 个 .md，${links} 条相对链接全部可达。`);
