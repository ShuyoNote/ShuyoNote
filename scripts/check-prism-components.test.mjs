// `check-prism-components` 的判据。
//
// 这组用例的重点在**变异**：判据要挡的是「第二条 Prism 装配路径又长出来」，
// 所以必须证明「只要它在，就一定红」—— 只证明「现在绿」没有意义（判据塌掉的方式正是
// 「它什么都没看」：目录读空、正则失配、列表解析成空数组，全都在绿读数里看不出来）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  check,
  importedComponents,
  legacyScripts,
  legacyVendored,
  offeredLanguages,
} from "./check-prism-components.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("R1 唯一路径：`index.html` 里不许再有 Prism 的 script", () => {
  it("认得 `prism/x.js` 与 `./prism/x.js`；别的 script 不算", () => {
    const html = [
      '<script src="es-polyfills.js"></script>',
      '<script src="prism/prism-core.js"></script>',
      '<script src="./prism/prism-json.js"></script>',
    ].join("\n");
    expect(legacyScripts(html)).toEqual(["prism-core.js", "prism-json.js"]);
  });

  it("**变异实测**：真实 `index.html` 里塞回一行 ⇒ 立刻算违规（「第二条路长回来」的样子）", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(legacyScripts(html), "本仓 index.html 现在应当是零 script").toEqual([]);
    const mutated = html.replace("<head>", '<head>\n    <script src="prism/prism-rust.js"></script>');
    expect(mutated).not.toBe(html);
    expect(legacyScripts(mutated)).toEqual(["prism-rust.js"]);
  });
});

describe("R1 唯一路径：`public/prism/` 不许再有 vendored 组件", () => {
  it("目录不存在 ⇒ 空表（不是抛异常）", () => {
    expect(legacyVendored(join(root, "public", "prism"))).toEqual([]);
    expect(legacyVendored(join(root, "public", "definitely-not-here"))).toEqual([]);
  });

  it("过滤器只认 `prism-*.js`（拿真目录验证它不会误伤别的文件）", () => {
    // `public/` 下今天确实没有 `prism-*.js` 了；这条防的是"过滤器写成 `*.js`，把别的东西也算进去"。
    expect(legacyVendored(join(root, "public"))).toEqual([]);
    expect(legacyVendored(join(root, "public", "icons")).every((n) => /^prism-.+\.js$/.test(n))).toBe(true);
  });
});

describe("R2 静态对账：选择器 ↔ `prismSetup.ts` 的 import", () => {
  const setup = readFileSync(join(root, "src", "editor", "prismSetup.ts"), "utf8");

  it("解析得出 import 了哪些组件（≥10 份；含 json / rust / sql 这些选择器里也有的）", () => {
    const imported = importedComponents(setup);
    expect(imported.length).toBeGreaterThanOrEqual(10);
    expect(imported).toContain("prism-json");
    expect(imported).toContain("prism-rust");
    expect(imported).toContain("prism-sql");
  });

  it("`LANGS` 搬家 ⇒ 返回 `null`（**不猜**：宁可说「没核对」，也不拿空表判「全都支持」）", () => {
    expect(offeredLanguages('const SOMETHING = ["json"];')).toBeNull();
  });

  it("把 `json` 的 import 删掉 ⇒ 它出现在「没有显式 import」那一类里（这条只报告、不判红）", () => {
    const mutated = setup.replace('import "prismjs/components/prism-json";\n', "");
    expect(mutated).not.toBe(setup);
    expect(importedComponents(mutated)).not.toContain("prism-json");
  });
});

describe("全仓自洽", () => {
  it("现在是零 script ＋ 零 vendored，且**真的读到了** index.html 与选择器", () => {
    const { scripts, vendored, imported, offered, notImported } = check(root);
    expect(scripts).toEqual([]);
    expect(vendored).toEqual([]);
    expect(imported.length).toBeGreaterThanOrEqual(10);
    expect(offered, "选择器列表没解析出来 ⇒ R2 会静默变成「没核对」").not.toBeNull();
    expect(offered.length).toBeGreaterThan(10);
    // ⚠️ 名单非空是**事实**、不是失败：`markdown` / `yaml` 静态看不到 import（运行期实测 markdown 可用）。
    //    这两条断言防的是「名单被悄悄清空」（那会让上面那句报告变成空话）。
    expect(Array.isArray(notImported)).toBe(true);
    expect(notImported.length).toBeGreaterThan(0);
  });
});
