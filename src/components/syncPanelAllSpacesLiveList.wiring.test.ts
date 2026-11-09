// 判据：只读源码钉住「全部空间立即同步」**目标列表必须现取**（2026-11-09）。
//
// 来由（AMD/personal 真机，2026-11-09 10:35）：新建空间后点「全部空间立即同步」，
// 新空间不在目标里、已删的旧空间还在 ⇒ 必须重启 app 才生效。
// 根因：目标列表取的是**组件挂载时那份 `spaces` 快照**（`pickAllSyncSpaces(spaces, …)`）。
// 修法：点按钮时 `await api.listWorkspaces()` 现取一次；读不到才回退快照。
//
// 为什么用源码判据：这是「取数时机」的问题（不是纯函数能表达的语义）；
// 组件级测试要真渲染 2300 行面板 + 打桩十几个 command，成本高于价值 ⇒ 与仓内
// 其它 `*.wiring.test.ts` 同一手法。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/SyncPanel.tsx", "utf8");

/** 截出 `const startAllSpacesSync = async () => { ... }` 的函数体（简单花括号配平）。 */
function startAllSpacesSyncBody(): string {
  const start = src.indexOf("const startAllSpacesSync = async () => {");
  expect(start, "SyncPanel 里找不到 startAllSpacesSync").toBeGreaterThanOrEqual(0);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("startAllSpacesSync 花括号没配平");
}

describe("「全部空间立即同步」的目标列表必须是实时读取", () => {
  it("① 点按钮时调 api.listWorkspaces() 现取（⛔ 不许只用挂载快照）", () => {
    const body = startAllSpacesSyncBody();
    expect(body, "必须现取工作空间列表").toContain("api.listWorkspaces()");
    expect(body, "现取的结果要交给挑目标的纯函数").toMatch(/pickAllSyncSpaces\(\s*liveSpaces/);
    expect(body, "⛔ 不许再直接把挂载快照喂给挑目标").not.toMatch(/pickAllSyncSpaces\(\s*spaces\s*,/);
  });

  it("② 读不到才回退快照（⛔ 不静默少同步）", () => {
    const body = startAllSpacesSyncBody();
    expect(body, "要有 liveSpaces 变量").toContain("let liveSpaces = spaces");
    expect(body, "读失败要兜底（catch 里不抛）").toMatch(/catch\s*\{/);
  });

  it("③ 新建空间要补 sync_profiles 行（否则公告/发现层看不到它），但只在网格已启用时补", () => {
    const body = startAllSpacesSyncBody();
    expect(body, "要调 meshEnsureDefaults 补档案行").toContain("api.meshEnsureDefaults()");
    expect(body, "⛔ 不许在未启用网格时补（会把桌面意外开成广播）").toContain("lanStatus?.mesh?.bind");
  });
});
