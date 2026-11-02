// vite 文件监听的「临时物豁免」判据（2026-10-29 修 EBUSY 崩 dev 的回归）。
//
// 来由（实测两次）：编辑器的原子写在仓根建 `.CHANGELOG.md.<pid>.<uuid>.tmpdir/…`，
// vite 的文件监听到它报 `EBUSY` 并把**整个 dev server 弄挂** —— 表现是"改一下 CHANGELOG，
// dev 就退出"，而日志里只有一句 EBUSY、看不出是另一个进程的一次性临时目录。
// ⇒ 两个 vite 配置都必须忽略这些临时物。这条判据只读配置文件（纯文本），不需要起 dev。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (name: string) => readFileSync(resolve(root, name), "utf8");

describe("vite 文件监听必须忽略原子写的临时目录（否则改 CHANGELOG 会把 dev 弄挂）", () => {
  it("① 桌面（Tauri dev）那份：忽略 `.tmpdir` 临时目录 ＋ `*.tmp`，且 `src-tauri` 仍被忽略", () => {
    const cfg = read("vite.config.ts");
    expect(cfg).toContain('"**/.*.tmpdir/**"');
    expect(cfg).toContain('"**/*.tmp"');
    expect(cfg, "src-tauri 那条老规矩不许被顺手删掉").toContain('"**/src-tauri/**"');
  });

  it("② Web（`pnpm dev:web`）那份：同一条豁免（Web 那档同样会被 EBUSY 弄挂）", () => {
    const cfg = read("vite.web.config.ts");
    expect(cfg).toContain('"**/.*.tmpdir/**"');
    expect(cfg).toContain('"**/*.tmp"');
  });
});
