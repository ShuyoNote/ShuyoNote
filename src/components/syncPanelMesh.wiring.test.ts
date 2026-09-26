// ★ 丙-③-b-2b-2：**网格（对等交换）在面板上真的要有一个可点的入口**。
//
// 为什么用**文本级**判据：这一片的价值全在"用户点得到"上，而"点得到"在 Node 里跑不出来
// （要真 Chromium ＋ 真命令面）。所以这里钉**结构**，与 `lanMulticast.wiring.test.ts` 同一手法：
// 命令面、门槛、清除语义、读数的来源，四处必须同时在岗 —— 少任何一处，这一档都用不了。
//
// ⚠️ 这几条**不是**在验业务逻辑（那在 Rust 侧与 `src/lib/platform` 的判据里），
// 它们只回答一个问题：**界面接上了没有**。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("网格（丙-③-b）· 面板接线", () => {
  const panel = read("src/components/SyncPanel.tsx");
  const webTs = read("src/lib/platform/web.ts");
  const commandsTs = read("src/lib/platform/commands.ts");

  it("① 面板真的调了命令面那两个命令（少一个就有一半功能点不到）", () => {
    expect(panel, "面板没接 `mesh_set_config` ⇒ 用户没法开网格").toContain("api.meshSetConfig(");
    // ★ 2026-09-26 口径收敛：**交换并进「同步」**（原来有一个单独的「立刻交换一轮」按钮）。
    //   所以这条断言从"面板里有这个词"改成"**`syncOne` 那段里有它**" —— 否则把调用挪到别处
    //   （比如某一个已经没人点的按钮里）也照样绿。
    const syncOne = panel.slice(panel.indexOf("const syncOne"), panel.indexOf("const update"));
    expect(syncOne, "「同步」那条路没有跑网格 ⇒ 用户点同步时网格不动").toContain("api.meshSyncNow(");
    // ★ 它在 `finally` 里，**不在 `try` 里** —— 真机实测踩过：服务端那条抛错（"会话已失效"）时
    //   `try` 里剩下的语句一行都不跑 ⇒ 网格被**连坐**跳过，而它根本不依赖服务端。
    const catchAt = syncOne.indexOf("} catch (e) {");
    const meshAt = syncOne.indexOf("api.meshSyncNow(");
    expect(catchAt, "`syncOne` 里没找到 catch（结构变了？）").toBeGreaterThan(-1);
    expect(meshAt, "网格那一步必须放在 **catch 之后**（＝ finally 里）").toBeGreaterThan(catchAt);
    expect(panel, "「立刻交换一轮」那个按钮应当已经删掉（同一个意图两个动作）").not.toContain("const meshRoundNow");
    expect(panel, "「立刻交换一轮」那个按钮应当已经删掉").not.toContain("void meshRoundNow()");
  });

  it("①b **自动同步也对网格生效**（不是只有手点「同步」才换）", () => {
    const app = read("src/App.tsx");
    expect(app, "自动同步那条路没跑网格 ⇒ 用户得手点同步才会换").toContain("api.meshSyncNow(");
    // ⚠️ gate 只许有一处：Rust 侧 `mesh_sync_now` 自己早退；前端**不重判一遍**。
    //    （这条断言钉的是"别在 App 里再写一个 if (mesh.enabled)"那种第二份解释。）
    expect(app, "自动同步那条路里不该自己判网格开没开（gate 在 Rust 侧一处实现）").not.toContain("mesh.enabled");
  });

  it("② 门槛是 `space_id`，**不是** `lanRowBound`（网格不需要服务端地址）", () => {
    // 网格那一块：只要求这个空间有 space_id —— "只开网格、不绑服务端"正是这一档要支持的配置。
    expect(panel).toContain("isDesktopPlatform() && lanStatus && !!activeRow?.space_id.trim() && (");
    // 2026-09-26（地址一处）：`lanRowBound` 那一行现在**同时**认"只开了网格"的空间 ——
    // 否则只开网格、不绑服务端的空间连地址读数都没有（那一档恰恰是丙要支持的）。
    expect(panel, "地址那一行的门槛必须同时认「绑了服务端」与「只开了网格」").toContain(
      "(lanRowBound || lanStatus.mesh.enabled)",
    );
  });

  it("③ 「关掉网格」走**清除**（`\"\"`），不是 `null`（`null` ＝ 不动 ⇒ 关不掉）", () => {
    expect(panel).toContain('api.meshSetConfig(activeId, "", null)');
  });

  it("④ 「别人拉不拉得到」那句人话**来自 Rust**（界面不自己按地址形状判档）", () => {
    // 2026-09-26（地址一处）：这句现在与 `lanStatus.line` 拼在**同一行**里 —— 仍然是 Rust 出的原文
    // （`lanStatus.mesh.note`），界面只是把它摆到那一行去。
    expect(panel).toContain("lanStatus.mesh.note");
    // 面板里不许出现"自己判回环/公网"的痕迹：档位只许由 Rust 出（与 `lan_status` 那条同一纪律）。
    expect(panel).not.toContain("127.0.0.1");
  });

  it("⑤ 契约与 Web 两侧都带 `mesh`（否则面板在 Web 上读到 undefined）", () => {
    expect(commandsTs, "`LanStatus` 少了 mesh").toContain("mesh: MeshConfigState;");
    expect(commandsTs, "缺 `mesh_set_config` 的契约条目").toContain("mesh_set_config:");
    expect(commandsTs, "缺 `mesh_sync_now` 的契约条目").toContain("mesh_sync_now:");
    // Web 的 `lan_status` 必须回同一形状：**如实说"这一档不可用"**，而不是少一个字段。
    expect(webTs).toContain("Web 版开不了本机端口 ⇒ 网格这一档只在桌面版可用");
  });

  // ★ 2026-09-26：网格那一块的**形状**（owner 截图 ＋ 真机实测：输入框 50px、按钮 44~50px 宽 ×
  //   64~112px 高 —— 就是"192."两个字母宽、"保存地址"一个字一行）。
  //   为什么用**文本级**判据：它在 `isDesktopPlatform()`（＝有没有 Rust 内核）后面，
  //   而 `verify-mobile-overlays.mjs` 跑的是 **Web** 平台 ⇒ 那里根本渲染不出来（写断言就是死断言）；
  //   桌面/手机的真机几何只能靠人。所以这里钉"形状不许回退"：
  //   谁把 `.sync-mesh` 改回横排、或去掉那句 `white-space:nowrap`，这几条立刻红。
  it("⑥ 网格那一块是**竖排**，且输入框吃宽、按钮不缩不断行（窄屏不许挤成并排）", () => {
    const css = read("src/App.css");
    // ⚠️ 选择器写**裸**的（`.` 不用转义）：`rule()` 自己会把正则元字符转义 ——
    //    再写一层 `\\.` 会被它转义成"要匹配一个字面反斜杠"，于是永远匹配不上（第一版就踩了）。
    const rule = (sel: string) => {
      const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
      return m ? m[1] : "";
    };
    // ① 它必须把 `.sync-att` 的横排覆盖掉（`.sync-att` 是"文字＋一个复选框"的横排类）。
    expect(rule(".sync-att.sync-mesh"), "`.sync-att.sync-mesh` 没有覆盖 display（横排会挤成并排）").toMatch(
      /display:\s*block/,
    );
    // ② 每一行是**横排**的"输入＋按钮"（不是把两个输入竖着堆成并排的四个孩子）。
    expect(rule(".sync-mesh .sync-field"), "网格的行不是 flex row").toMatch(/flex-direction:\s*row/);
    // ③ 输入框吃宽（`min-width:0` 才能真的收缩而不是撑破容器）。
    expect(rule(".sync-mesh .sync-field > .sync-input"), "输入框没有 `flex: 1 1 auto`").toMatch(/flex:\s*1 1 auto/);
    expect(rule(".sync-mesh .sync-field > .sync-input")).toMatch(/min-width:\s*0/);
    // ④ 按钮不缩、不断行 —— 这一句就是"一个字一行"的直接解药。
    const btn = rule(".sync-mesh .sync-field > .sync-btn");
    expect(btn, "按钮少了 `flex: 0 0 auto`（会被压窄）").toMatch(/flex:\s*0 0 auto/);
    expect(btn, "按钮少了 `white-space: nowrap`（会一个字一行）").toMatch(/white-space:\s*nowrap/);
    // ⑤ 读数里的长 URL 要能按任意位置折行（否则撑破卡片）。
    expect(rule(".sync-mesh .sync-hint"), "hint 少了 `overflow-wrap: anywhere`").toMatch(/overflow-wrap:\s*anywhere/);
  });
});
