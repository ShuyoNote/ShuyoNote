// **接线判据**：全应用"打开外部网站"只能走 `src/lib/openExternal.ts` 这一个出口。
//
// 这条判据的存在理由就是这次改动本身：那个总闸开关原先只被「关于」查过一次，另外 5 处
// （社区保存 / 发布到社区 / 插件索引 / 网页书签 / 链接悬浮条）各写各的 `platform.opener.openUrl`
// —— 于是"允许跳转到外部项目网站"实际只盖住 1/6，同一份判定在 6 个地方各漂一次。
//
// 所以这里扫**生产源码**（测试文件不算）钉两件相反的事：
//   ① `opener.openUrl(` 只许出现在出口那一个文件里（有人绕过就红）；
//   ② `opener.openPath(`（打开**本地文件**）**必须还在** —— 关掉外链不该让"用系统程序打开附件"失效，
//      那是离线能力，不在这个开关的语义里（负向判据，防误伤）。
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 用 cwd 拼路径而不是 `new URL(..., import.meta.url)`：vitest 在 happy-dom 下
// `import.meta.url` 不是 `file:` 方案，`readFileSync` 会报 "The URL must be of scheme file"。
const ROOT = process.cwd();

function productionSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      productionSources(rel, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

const SOURCES = productionSources("src");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("外部网站只有一个出口（真总闸的接线判据）", () => {
  it("`opener.openUrl(` 只出现在 src/lib/openExternal.ts", () => {
    const hits = SOURCES.filter((f) => read(f).includes("opener.openUrl("));
    expect(hits).toEqual(["src/lib/openExternal.ts"]);
  });

  it("六个调用点都走出口，不自己判开关", () => {
    const wired = [
      "src/components/AboutDialog.tsx",
      "src/components/CommunitySaveDialog.tsx",
      "src/components/CommunityPublishDialog.tsx",
      "src/components/PluginIndexPanel.tsx",
      "src/editor/nodes/WebBookmarkNode.tsx",
      "src/editor/plugins/LinkPopoverPlugin.tsx",
    ];
    for (const f of wired) {
      const src = read(f);
      expect(src, `${f} 应引用 openExternalUrl`).toContain("openExternalUrl");
      expect(src, `${f} 不该再自己开外链`).not.toContain("opener.openUrl(");
    }
  });

  it("除了「设置界面」和那一层，没有生产文件自己读开关（判定只该在出口里）", () => {
    // 两个例外各有理由：
    //  · `links.ts` —— 开关状态本身住在这里（读写它的地方）；
    //  · `AboutDialog.tsx` —— **设置界面**必须读当前值才能把开关画成开/关；
    //    它已经不能再自己开外链了（上面那条断言钉着 `opener.openUrl(` 只许出现在出口里）。
    const allowed = new Set(["src/lib/links.ts", "src/components/AboutDialog.tsx"]);
    const hits = SOURCES.filter((f) => !allowed.has(f) && read(f).includes("getAllowExternal"));
    expect(hits).toEqual([]);
  });

  it("本地文件仍照旧打开：`opener.openPath(` 还在（外链开关不误伤离线能力）", () => {
    const hits = SOURCES.filter((f) => read(f).includes("opener.openPath("));
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });
});
