// check-nsis-template 的判据自测：每条断言都"改坏那一处就变红"（变异测试）。
// 这里不碰真实文件系统 —— `inspect()` 是纯函数，喂进构造好的输入即可。
import { describe, expect, it } from "vitest";

import {
  SENTINEL,
  UPSTREAM_LINE,
  WANTED_LINE,
  inspect,
  parseMeta,
  upstreamPart,
} from "./check-nsis-template.mjs";

const HEADER = [
  "; upstream-repo: tauri-apps/tauri",
  "; upstream-crate: tauri-bundler 2.9.4",
  `; upstream-path: src/bundle/windows/nsis/installer.nsi`,
  "; upstream-sha256: deadbeef",
  "; cli-version: 2.11.4",
  "; ============================================================================",
  SENTINEL,
  "",
].join("\n");

const upstreamBody = [
  "Unicode true",
  "ManifestDPIAware true",
  `Section`,
  UPSTREAM_LINE,
  "  Call RestorePreviousInstallLocation",
  "SectionEnd",
  "",
].join("\n");

const ourBody = upstreamBody.replace(UPSTREAM_LINE, WANTED_LINE);

const base = {
  conf: { bundle: { windows: { nsis: { template: "nsis/installer.nsi" } } } },
  templateText: HEADER + ourBody,
  cliVersion: "2.11.4",
  upstreamText: upstreamBody,
  upstreamFetched: true,
};

describe("check-nsis-template", () => {
  it("正常情况：零问题", () => {
    expect(inspect(base)).toEqual([]);
  });

  it("变异 1：没配 template → 报红（默认目录会退回 AppData）", () => {
    const problems = inspect({ ...base, conf: { bundle: { windows: { nsis: {} } } } });
    expect(problems.join()).toContain("没配");
  });

  it("变异 2：模板文件不存在 → 报红", () => {
    const problems = inspect({ ...base, templateText: null });
    expect(problems.join()).toContain("模板文件不存在");
  });

  it("变异 3：那一行改回去了（旧写法残留）→ 报红", () => {
    const problems = inspect({ ...base, templateText: HEADER + upstreamBody });
    expect(problems.join()).toContain("还留着上游的旧默认目录");
    expect(problems.join()).toContain("出现 0 次");
  });

  it("变异 4：把那行写成 Programs 之外的目录 → 报红", () => {
    const wrong = ourBody.replace(WANTED_LINE, '  StrCpy $INSTDIR "$LOCALAPPDATA\\ShuyoNote2"');
    const problems = inspect({ ...base, templateText: HEADER + wrong });
    expect(problems.join()).toContain("出现 0 次");
  });

  it("变异 5：CLI 升级了但模板没重做 → 报红", () => {
    const problems = inspect({ ...base, cliVersion: "2.12.0" });
    expect(problems.join()).toContain("Tauri CLI 升级了");
  });

  it("变异 6：重做 fork 时多改了一行 → 报红（联网比对才查得出）", () => {
    const extra = ourBody.replace("Unicode true", "Unicode tru3");
    const problems = inspect({ ...base, templateText: HEADER + extra });
    expect(problems.join()).toContain("差异不止那一行");
  });

  it("变异 7：哨兵行被删 → 报红（无法定位上游原文）", () => {
    const problems = inspect({ ...base, templateText: ourBody });
    expect(problems.join()).toContain("找不到哨兵行");
  });

  it("变异 8：没联网时不该因为缺上游而失败", () => {
    expect(inspect({ ...base, upstreamText: null, upstreamFetched: false })).toEqual([]);
  });

  it("上游结构变了（找不到那一行）→ 报红", () => {
    const problems = inspect({
      ...base,
      upstreamText: "Unicode true\nSection\nSectionEnd\n",
    });
    expect(problems.join()).toContain("上游结构变了");
  });

  it("parseMeta 只认这几个键、且值里可以有空格（`tauri-bundler 2.9.4`）", () => {
    const meta = parseMeta(
      "; upstream-crate: tauri-bundler 2.9.4\nUnicode true\n; 说明文字\n; cli-version: 2.11.4\n; https://example.com/x\n",
    );
    expect(meta["upstream-crate"]).toBe("tauri-bundler 2.9.4");
    expect(meta["cli-version"]).toBe("2.11.4");
    // 正文里那种 `; https://…` 注释不许被当成键
    expect(Object.keys(meta).sort()).toEqual(["cli-version", "upstream-crate"]);
  });

  it("upstreamPart 返回哨兵之后的原文", () => {
    expect(upstreamPart(HEADER + ourBody)).toBe(ourBody);
  });
});
