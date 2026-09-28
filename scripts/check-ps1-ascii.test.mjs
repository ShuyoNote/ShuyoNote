// `scripts/check-ps1-ascii.mjs` 的判据：
//   ① **扫描范围**：本机生成物目录（尤其 `.gm-build/`）必须跳掉 —— 2026-09-25 的假红就是它；
//   ② **判定本身**：非 ASCII 且无 BOM ⇒ 违规；带 BOM ⇒ 合规（那是允许的写法）。
//
// 为什么值得两条：这条门禁判的是"文本编码"，而它自己**曾经因为扫到第三方 crate 的 `.ps1`**
// 在"跑过一次国密构建"的机器上恒红。假红的代价不是多看一眼，是**把门禁训练成可以忽略**。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SKIP_DIRS, collectPs1Files, scanPs1Buffer } from "./check-ps1-ascii.mjs";

describe("扫描范围：本机生成物目录必须跳掉（`.gm-build` 那次假红）", () => {
  it("★ `.gm-build` 在跳过名单里（它是不入库的私有 CARGO_HOME，里面有第三方 crate 的 .ps1）", () => {
    expect(SKIP_DIRS.has(".gm-build")).toBe(true);
    for (const d of ["node_modules", "target", "dist", ".git", "vendor"]) expect(SKIP_DIRS.has(d)).toBe(true);
  });

  it("★ 夹具：`scripts/a.ps1` 收得到，`.gm-build/cargo-home/registry/src/x/b.ps1` 收不到", () => {
    const t = mkdtempSync(join(tmpdir(), "ps1-ascii-"));
    try {
      mkdirSync(join(t, "scripts"), { recursive: true });
      mkdirSync(join(t, ".gm-build", "cargo-home", "registry", "src", "jni-0.21.1", ".github", "workflows"), {
        recursive: true,
      });
      writeFileSync(join(t, "scripts", "a.ps1"), "Write-Host 'ok'\n");
      // 这份**故意**带非 ASCII：它模拟 `jni-0.21.1/.github/workflows/run_windows_invocation_tests.ps1`
      writeFileSync(join(t, ".gm-build", "cargo-home", "registry", "src", "jni-0.21.1", ".github", "workflows", "b.ps1"), "Write-Host '中文'\n");
      const found = collectPs1Files(t).map((p) => p.slice(t.length + 1).replace(/\\/g, "/"));
      expect(found).toEqual(["scripts/a.ps1"]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("默认跳过名单可以覆盖（夹具用得上，也说明它不是写死的）", () => {
    const t = mkdtempSync(join(tmpdir(), "ps1-ascii-"));
    try {
      mkdirSync(join(t, "sub"), { recursive: true });
      writeFileSync(join(t, "sub", "c.ps1"), "Write-Host 'ok'\n");
      expect(collectPs1Files(t, new Set(["sub"]))).toEqual([]);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("判定本身：非 ASCII ＋ 无 BOM ⇒ 违规；带 BOM ⇒ 合规", () => {
  it("★ 纯 ASCII ⇒ 0 个违规字节", () => {
    expect(scanPs1Buffer(Buffer.from("Write-Host 'hello'\r\n", "utf8"))).toEqual({ hasBom: false, offenders: [] });
  });

  it("★ 无 BOM 的中文 ⇒ 违规，且报出行号（错误信息里要能直接跳过去）", () => {
    const buf = Buffer.from("line1\n$x = '中文'\n", "utf8");
    const { offenders } = scanPs1Buffer(buf);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders[0].line).toBe(2);
  });

  it("★ 带 UTF-8 BOM 的中文 ⇒ **合规**（允许的写法，别把它也判红）", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("$x = '中文'\n", "utf8")]);
    expect(scanPs1Buffer(buf)).toEqual({ hasBom: true, offenders: [] });
  });

  it("制表/换行不算违规字节（\\t \\n \\r 是合法控制字符）", () => {
    expect(scanPs1Buffer(Buffer.from("\t\r\n", "utf8")).offenders).toEqual([]);
  });
});
