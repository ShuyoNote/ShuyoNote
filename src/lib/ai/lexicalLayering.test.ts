// **分层**判据：`ai/lexical.ts` 是**纯 JSON 逻辑**层，绝不许 import 编辑器节点表。
//
// 这是 2026-09-18 一次**真门禁红灯**（`smoke-web` 62 个 esbuild error，红了 6 小时没人发现）的直接根因：
// 正文派生合一那次把 `contentTextOf` 放在 `ai/lexical.ts` 里、让它委托 `../contentText`
// ⇒ **任何** import `ai/lexical` 的打包路径都被拖进整个编辑器节点图
// （excalidraw 的 `index.css`、katex 的 30 个字体、sql.js 的 wasm）。
// `vitest`（Vite 接手 CSS/`?url`）看不出问题，`smoke-web`（node 侧裸 esbuild + 严格 `exports`）当场红。
//
// 处置是**分层**：`contentTextOf` 搬到 `ai/lexicalContent.ts`，由编辑器侧调用方 import。
// 但"分层"这件事原先只写在注释里 ⇒ 本文件把它变成可执行判据（谁再把它拖回去，这里先红，
// 不必等到有人想起跑 smoke-web）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/**
 * 去掉注释再断言：`ai/lexical.ts` 的注释里**故意**记着这次事故（提到 `contentText` / `deriveContentText`），
 * 那是文档不是依赖。判据只看**代码**。
 * （简单剥法即可：宁可少剥 ⇒ 判据偏保守；这里剥不干净只会让判据更严，不会漏。）
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** 编辑器侧真正需要编辑器语义的调用方（它们必须走 `lexicalContent`）。 */
const EDITOR_SIDE_CALLERS = [
  "src/lib/ai/apply.ts",
  "src/components/PdfAnnotationCanvas.tsx",
  "src/components/PdfAskBar.tsx",
];

describe("ai/lexical.ts 必须保持**纯 JSON 逻辑**（不许拖进编辑器节点表）", () => {
  it("★ 不许 import `../contentText`（那是事故根因：它要 editor/config 的节点表）", () => {
    expect(stripComments(read("src/lib/ai/lexical.ts"))).not.toMatch(/from\s+"\.\.\/contentText"/);
  });

  it("★ 代码里不许出现 `deriveContentText` / `editor/config`（注释里的历史记录不算）", () => {
    const code = stripComments(read("src/lib/ai/lexical.ts"));
    expect(code).not.toMatch(/deriveContentText/);
    expect(code).not.toMatch(/editor\/config/);
  });
});

describe("contentTextOf 只住在 `lexicalContent.ts`（调用方不许从纯层拿它）", () => {
  it("纯层不导出 `contentTextOf`", () => {
    expect(stripComments(read("src/lib/ai/lexical.ts"))).not.toMatch(/export\s+(async\s+)?function\s+contentTextOf/);
  });

  it("编辑器语义层导出它，而且是**薄委托**", () => {
    const src = read("src/lib/ai/lexicalContent.ts");
    expect(src).toMatch(/export\s+function\s+contentTextOf/);
    expect(src).toMatch(/return\s+deriveContentText\(/);
  });

  it("★ 编辑器侧调用方 import 的是 `lexicalContent`（不是 `lexical`）", () => {
    for (const f of EDITOR_SIDE_CALLERS) {
      const src = read(f);
      if (!src.includes("contentTextOf")) continue; // 只检查确实用到它的文件
      expect(src, `${f} 应当从 lexicalContent 取 contentTextOf`).toMatch(/["'][^"']*lexicalContent["']/);
      expect(src, `${f} 不应再从 lexical 取 contentTextOf`).not.toMatch(/\{[^}]*contentTextOf[^}]*\}\s*from\s*["'][^"']*\/lexical["']/);
    }
  });
});
