// 「同步口径收敛」第二片的判据（文本级）：**两个控件** ＋ **地址一处**。
//
// 为什么用文本级：这一片的产物全是"界面形状"（一个下拉代替两个控件、一行地址代替两行），
// 而面板里的网格块在 `isDesktopPlatform()` 后面 ⇒ `verify-mobile-overlays.mjs`（跑 Web 平台）
// 根本渲染不出来。所以形状由这里钉、真机读数由人量（见 CHANGELOG 里那张前后对照）。
//
// ⚠️ 断言一律对着**去过注释**的源码：这一片的注释里到处在解释旧形状（"原来是两个控件"），
// 不剥注释就会拿说明文字当代码判（本仓踩过同型的坑）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

describe("同步方式：**一个**控件（不是一个间隔下拉 ＋ 一个近实时开关）", () => {
  const panel = read("src/components/SyncPanel.tsx");

  it("① 面板用的是 `syncMode` 那一个下拉，映射与人话都从 `lib/syncMode.ts` 来", () => {
    expect(panel, "面板没接 `syncMode`（又拆回两个控件了？）").toContain("value={syncMode}");
    expect(panel, "面板要经 `applySyncMode` 改档（一处写入口）").toContain("applySyncMode(");
    expect(panel, "那句人话必须来自 `lib/syncMode.ts`，不许在面板里再写一遍").toContain("syncModeHint(syncMode)");
  });

  it("② 旧的四档间隔必须消失（10 秒 / 1 分钟 / 5 分钟不再是各自一个选项）", () => {
    for (const legacy of ['value="10000"', 'value="60000"', 'value="300000"']) {
      expect(panel, `旧档位 ${legacy} 还在 ⇒ 控件没收窄`).not.toContain(legacy);
    }
  });

  it("③ 近实时不再有**自己的**复选框（它是「同步方式」里的一档）", () => {
    expect(panel, "近实时那个独立复选框还在 ⇒ 同一条路上仍是两个控件").not.toContain(
      "toggleNearRealtime(e.target.checked)",
    );
    // 但那一档**必须**在（桌面才有那条流）——少了它就是"把能力删了"而不是"收窄入口"。
    expect(panel, "「近实时」那一档不见了 ⇒ 能力被删了而不是入口收窄").toContain("近实时（连着服务端时立刻拉）");
    expect(panel, "近实时那一档只在桌面出现（Web 上没有那条流）").toContain("isDesktopPlatform() && <option");
  });
});

describe("地址只说一处", () => {
  const panel = read("src/components/SyncPanel.tsx");

  it("④ `lanStatus.mesh.note` 在面板里只出现**一次**（并进了「局域网直连」那一行）", () => {
    const hits = panel.split("lanStatus.mesh.note").length - 1;
    expect(hits, "地址/可达性那句被说了多遍 ⇒ 两个读数看起来互相矛盾").toBe(1);
  });

  it("⑤ 网格那一块里**不再**自己说地址（它只管设置与开关）", () => {
    const at = panel.indexOf('className="sync-att sync-mesh"');
    expect(at, "找不到网格那一块").toBeGreaterThan(-1);
    // 切到**下一个块级** `sync-att sync-*`（`sync-att-text` / `-name` 是块内的子元素，不算边界）
    // —— 第一版按 `className="sync-att` 切，结果切在了块自己的 `sync-att-text` 上（差点假绿）。
    const next = panel.indexOf('className="sync-att sync-', at + 10);
    const block = panel.slice(at, next === -1 ? panel.length : next);
    expect(block, "网格块里还在重复窗口地址").not.toContain("lanStatus.mesh.note");
    expect(block, "网格块里应当保留它的设置（监听地址 / 口令）").toContain("saveMeshBind");
    expect(block, "网格块里应当保留「关掉网格」").toContain("disableMesh");
  });

  it("⑦ 改了档位要让 App 那条定时器**重挂**（否则「选了按间隔可它没动」）", () => {
    const app = read("src/App.tsx");
    expect(app, "App 没订阅档位变更事件 ⇒ 面板改档后定时器还按老间隔跑").toContain(
      "AUTO_SYNC_CHANGED_EVENT",
    );
    expect(app, "订阅必须是 `addEventListener`（不是只在渲染时读一次）").toContain(
      "window.addEventListener(AUTO_SYNC_CHANGED_EVENT",
    );
    expect(panel, "面板改档要经 `applySyncMode`（一处写入口）").toContain("applySyncMode(");
    expect(panel, "面板写档位要走 `writeAutoSyncMs`（它负责广播）").toContain("writeAutoSyncMs(");
    expect(panel, "面板不该再自己 `localStorage.setItem` 那个键").not.toContain('setItem("shuyonote:autoSync"');
    // ★★ 2026-09-26（口径对齐）：光有 `writeAutoSyncMs` 那一次广播**不够** ——
    //   有效间隔是 `f(间隔档位, 近实时开关)` 的函数，而那一刻近实时**还是旧值**：
    //   「近实时 → 关闭」会被算成"还开着 ⇒ 挂 5 分钟兜底" ⇒ 用户选了「关闭」，
    //   机器却每 5 分钟自动同步一次。所以两半都落定之后必须**再喊一次**。
    const at = panel.indexOf("toggleNearRealtime(next.nearRealtime)");
    expect(at, "找不到 applySyncMode 里近实时那半（结构变了？）").toBeGreaterThan(-1);
    expect(
      panel.slice(at, at + 400),
      "第二次广播必须跟在「近实时那半落定」之后（否则那一刻读到的还是旧开关）",
    ).toContain("broadcastAutoSyncChanged()");
  });

  it("⑥ 合一那一行的门槛要**同时**认「绑了服务端」与「只开了网格」", () => {
    expect(
      panel,
      "只开网格、不绑服务端的空间看不到那一行 ⇒ 地址反而没了（丙 的目标配置）",
    ).toContain("(lanRowBound || lanStatus.mesh.enabled)");
  });
});
