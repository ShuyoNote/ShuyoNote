// 测试用的 CSS 源清单：`src/App.css` ＋ `src/styles/**/*.css`。
// S4 strangler 起，CSS 会分批从 App.css 搬到 `src/styles/*.css`；判据必须按**同一份清单**看，
// 否则每搬一个域，字号/间距/层序/卫生判据就少看一个文件（规则搬进"法外之地"）。
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();

export function cssFilePaths(): string[] {
  const out = [resolve(ROOT, "src/App.css")];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".css")) out.push(p);
    }
  };
  walk(resolve(ROOT, "src/styles"));
  return out;
}

export function readCssFiles(): { path: string; text: string }[] {
  return cssFilePaths().map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
}

/** 全量 CSS 文本（按清单顺序拼接；用于"全仓 CSS"口径的扫描）。 */
export function allCssText(): string {
  return readCssFiles()
    .map((f) => f.text)
    .join("\n");
}
