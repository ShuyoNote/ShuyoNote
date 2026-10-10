// 服务器标识（那个"颜色点/胶囊"）的判据 —— owner 2026-10-10 的两条口径：
//   ① ⭐「**个人空间没有服务器，就不显示**」✓（⛔ 不是"把 IP 藏起来" ✗，是它**本来就不该有** ✓）
//   ② ⭐「**团队空间**：平时只留一个**颜色点**、**悬停**才显示地址」✓
//
// 为什么用文本级判据（与 `syncPanelMesh.wiring.test.ts` 同一手法）：这一片的可见结果要真 Chromium
// 才渲染得出来（本机不跑 browser 组），而"地址到底有没有被渲染成文字"这件事，
// 在**源码 ＋ 纯函数**这一层就能钉死 ✓ —— ⛔ 不必也不该等浏览器 ✗。
//
// ⚠️ 三处共用这套标识（`PageTree` 空间行 ／ `TitleBar` 状态芯片 ／ `SyncPanel` 空间标签），
//    本轮 `SyncPanel` 归另一条线（task-15）⇒ 判据覆盖前两处 ＋ **规则本身**（`showsServerTag`）✓。
// ⚠️ **已知缺口（2026-10-10，已报 Lead）**：`kind` 现在**到不了渲染层**
//    （`src-tauri/src/workspaces.rs:26` 的 `WS_COLS` 不含 `kind`，TS `WorkspaceMeta` 也没这个字段）
//    ⇒ 规则已实现并被判据钉住，但三处调用点**还没法传 kind** ⇒ 本文件里那条"渲染层接线"的断言
//    只钉"⛔ 不许自己写 kind 判断"，**不假装已经接上了** ✗。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { showsServerTag, syncTagColor, syncTagLabel, syncTagTitle } from "./syncTag";

const read = (p: string) => readFileSync(p, "utf8");
const URL_IP = "http://121.199.8.9:8787";

describe("服务器标识 · 规则（纯函数：规则只有这一处实现）", () => {
  it("① 个人空间 ⇒ **不显示**（旧行为必红：它照样把地址渲染成文字）", () => {
    expect(showsServerTag("personal", URL_IP)).toBe(false);
    // ⚠️ 未分类（`""`）按个人处理 —— 与仓内既有口径同向（`set_sync_profile` 那道 team-only 拒）✓
    expect(showsServerTag("", URL_IP)).toBe(false);
    expect(showsServerTag("其它", URL_IP)).toBe(false);
  });

  it("② 团队空间 ＋ 有服务器 ⇒ 显示；缺一样都不显示", () => {
    expect(showsServerTag("team", URL_IP)).toBe(true);
    expect(showsServerTag("team", "")).toBe(false);
    expect(showsServerTag("team", "   ")).toBe(false);
    expect(showsServerTag("team", null)).toBe(false);
    expect(showsServerTag("team", undefined)).toBe(false);
    expect(showsServerTag("personal", "")).toBe(false);
  });

  it("②b ⚠️ 过渡态：`kind` 还传不进来时，**有服务器就显示**（⛔ 等那一格接上后这条必须翻成 false）", () => {
    // 这条**故意**钉住现状：`kind === undefined` ＝ 渲染层拿不到空间类型（见文件头缺口）。
    // ⇒ 过渡期宁可"先只留颜色点"（把 owner 看得见的 IP 去掉 ✓），也不装作能判个人空间 ✗。
    expect(showsServerTag(undefined, URL_IP)).toBe(true);
    // ⛔ 但"没服务器"这一条**不**受过渡影响：一律不显示 ✓
    expect(showsServerTag(undefined, "")).toBe(false);
  });

  it("③ 悬停给的是**完整地址**（含端口）—— 写死一处，⛔ 不许两处两种说法", () => {
    expect(syncTagTitle(URL_IP)).toContain(URL_IP);
    expect(syncTagTitle(URL_IP)).toContain("8787");
    // 与"host 短标签"**不是**同一个东西：短标签留给"有地方放文字"的场景（同步面板那处）✓
    expect(syncTagLabel(URL_IP)).toBe("121.199.8.9:8787");
    expect(syncTagTitle(URL_IP)).not.toBe(syncTagLabel(URL_IP));
    // 空地址不许拼出半个句子（那时根本不该渲染标识 ✓）
    expect(syncTagTitle("")).not.toContain("：");
  });

  it("④ 颜色算法**没被动**（⛔ 不许改：同地址永远同色是这套编码的意义）", () => {
    // 钉一个真值：谁动了 `syncTagColor` 的算法，这条立刻红 ✓
    expect(syncTagColor("http://a")).toBe("hsl(127 65% 45%)");
    expect(syncTagColor(URL_IP)).toBe(syncTagColor(URL_IP));
    expect(syncTagColor(URL_IP)).not.toBe(syncTagColor("http://other:1"));
  });
});

describe("服务器标识 · 两处渲染（PageTree ／ TitleBar）", () => {
  const pageTree = read("src/components/PageTree.tsx");
  const titleBar = read("src/components/TitleBar.tsx");

  it("① 两处**都不再把地址渲染成文字**（旧行为必红：渲染的就是 `syncTagLabel(...)`）", () => {
    expect(pageTree, "侧栏胶囊/空间行里的地址文字还在").not.toContain("syncTagLabel(");
    expect(titleBar, "标题栏里的地址文字还在").not.toContain("syncTagLabel(");
  });

  it("① 规则只有一处：渲染层 ⛔ 不许自己写 `kind === \"team\"` 那种判断", () => {
    expect(pageTree, "PageTree 自己判 kind 了（规则应当只有一处）").not.toMatch(/kind\s*===\s*"team"/);
    expect(titleBar, "TitleBar 自己判 kind 了（规则应当只有一处）").not.toMatch(/kind\s*===\s*"team"/);
  });

  it("② 颜色点还在（⛔ 不许把整个胶囊删掉）＋ 两处同源 `syncTagColor`", () => {
    expect(pageTree).toContain("sidebar-sync-dot");
    expect(pageTree).toContain("space-item-sync-dot");
    expect(titleBar).toContain("titlebar-sync-dot");
    expect((pageTree.match(/syncTagColor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(titleBar).toContain("syncTagColor(");
  });

  it("③ **悬停仍要给地址**（⛔ 不许连提示都删掉 —— 那就成了「整个去掉」，owner 没选它）", () => {
    expect(pageTree).toContain("syncTagTitle(");
    expect(titleBar).toContain("syncTagTitle(");
    // 前缀只在 `syncTagTitle` 里拼一次；页面里不许再手拼（两处会漂）
    expect(pageTree, "PageTree 手拼了提示前缀").not.toContain("同步目标：${");
    expect(titleBar, "TitleBar 手拼了提示前缀").not.toContain("同步目标：${");
    expect(pageTree, "PageTree 手拼了另一个前缀").not.toContain("同步：${");
    expect(titleBar, "TitleBar 手拼了另一个前缀").not.toContain("同步：${");
  });

  it("⑤ 无障碍：那个点必须有可读的名字（aria-label 与悬停同一处文案）", () => {
    expect(pageTree, "PageTree 的颜色点没有可读名字").toMatch(/aria-label=\{syncTagTitle\(/);
    expect(titleBar, "TitleBar 的颜色点没有可读名字").toMatch(/aria-label=\{syncTagTitle\(/);
  });
});
