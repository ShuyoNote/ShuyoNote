// 「同步口径收敛」第二片的判据（文本级）：**两个控件** ＋ **地址一处**。
//
// 为什么用文本级：这一片的产物全是"界面形状"（一个下拉代替两个控件、一行地址代替两行），
// 而面板里的网格块在 `isDesktopPlatform()` 后面 ⇒ `verify-mobile-overlays.mjs`（跑 Web 平台）
// 根本渲染不出来。所以形状由这里钉、真机读数由人量（见 CHANGELOG 里那张前后对照）。
//
// ⚠️ 断言一律对着**去过注释**的源码：这一片的注释里到处在解释旧形状（"原来是两个控件"），
// 不剥注释就会拿说明文字当代码判（本仓踩过同型的坑）。
import { existsSync, readFileSync } from "node:fs";
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
  // ⭐⭐ **2026-10-14（owner：「去掉孤儿组件」）** ✗：网格那一块住的 `MeshAdvancedForm.tsx` **已删** ✓
  //    （它先丢了挂载点、随后整份走了 ✓）⇒ ⛔ 这里不再读它 ✗。⭐ 按 R192「换对象不删断言」✗：
  //    ⛔ ⑤ 不是删掉 ✓，换成**现在承重的那两半**（文件不许回来 ＋ 后端那条口径仍在 ✓）。

  it("④ `lanStatus.mesh.note` 那句话在面板里只出现**一次**（现在在绿条上）", () => {
    // ⭐⭐ **owner 2026-10-14 拍删**「设备直连」那条读数行 ✗ ⇒ 那句人话的**唯一落点**＝ ⭐ **绿条**
    //    （`SyncStatusStrip` 的 `note` prop ✓）。⭐ 按本仓 R192「**换对象不删断言**」✗：⛔ 不是把这条
    //    删掉 ✓，只把**对象**换到新的那一处 ✓（口径一字不变：同一件事**只许说一处** ✓）。
    // ⭐ **2026-10-14（owner：顶上那条拆两行）**：⭐ 绿条第二行取的是 `.reach` ✓（`.note` 那句「开没开／
//   窗口在哪」没有再摆 ✗ —— 第一行那两格已经把同一件事说短了 ✓）。⭐ 判据换对象不删条（R192 ✓）：
//   口径一字不变 —— ⭐ 「别人拉不拉得到」那句人话**只许来自 Rust 且只出现一次** ✓。
    const hits = panel.split("lanStatus?.mesh?.reach").length - 1;
    expect(hits, "地址/可达性那句被说了多遍 ⇒ 两个读数看起来互相矛盾").toBe(1);
    // 反面：那条**已删**的读数行不许回来（它当年就是"第二处地址"）。
    expect(panel, "那条被删的读数行不许回来（它会成为第二处地址）").not.toContain("lanRowBound ? lanStatus.line");
  });

  it("⑤ 网格那一块**已删**（它随 `MeshAdvancedForm.tsx` 一起走了）—— ⛔ 但后端那条口径仍在", () => {
    // ⭐ **2026-10-14（owner：「去掉孤儿组件」）** ✗：这一条原来是「网格那一块里**不再**自己说地址」✓ ——
    //   ⭐ 而**那一块本身**已随组件删除 ✓ ⇒ ⭐ 对象没了 ✓。⭐ 按 R192 换对象：⛔ 不删这条 ✓，换成
    //   ⭐「文件不许回来 ＋ 它当年的设置承诺**在后端仍有承重**」✓（⛔ 撤的是界面，⛔ 后端一个字节没动 ✗）。
    expect(existsSync(join(process.cwd(), "src/components/MeshAdvancedForm.tsx")), "⭐ 那个组件已删 ✓").toBe(false);
    const cmds = readFileSync(join(process.cwd(), "src/lib/platform/commands.ts"), "utf8");
    expect(cmds, "⭐ 网格那条命令仍在命令面 ✓（`mesh_set_config` ✓）").toContain("mesh_set_config");
    const api = readFileSync(join(process.cwd(), "src/lib/api.ts"), "utf8");
    expect(api, "⭐ 而它的 api 封装也仍在 ✓（⛔ 后端那一侧没撤 ✗）").toContain("meshSetConfig");
    expect(panel, "⛔ 面板里不该再出现那一块的类名 ✗（它随组件走了 ✓）").not.toContain('className="sync-att sync-mesh"');
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

  it("⑥ 合一那一行的门槛不再依赖服务端绑定（个人空间也显示）", () => {
    const needle = "isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive) && (";
    expect(
      panel,
      "⚠️ 2026-10-04 改：门槛不再依赖服务端绑定 —— 个人空间（没绑、也没有 space_id）也要看到这一行",
      // ⚠️ 2026-10-14：⭐ 只去掉 `space_id` 不够 ✗ —— `!!activeRow` 还在，而个人空间**没有同步档案行**
      //    ⇒ 仍然什么都不显示（真机 CDP 实测）⇒ 断言跟着改成"放行 isPersonalActive"✓，意图不变 ✓。
    ).toContain(needle);
    // ⭐⭐ **2026-10-14（owner 拍删「设备直连」那一折 ⇒ 再拍「整张卡连输入框一起去掉」）** ✗：
    //    ⭐ 这条门槛里原来装着「设备直连设置」那一组（`MeshAdvancedForm` ✓）—— ⭐ **它已删** ✓。
    //    ⭐ 按 R192「换对象不删断言」✗：⛔ 不是把这条删掉 ✓，换成**门槛里现在真实的成员**：
    //    ⭐ 中继（`RelayStatusSection` ✓）。⭐ 要钉的口径一字不变：⭐ **个人空间（`isPersonalActive`）
    //    必须看得到这一块** ✓（中继那一格正是个人空间也要看得到的东西 ✓）。
    const at = panel.indexOf(needle);
    expect(
      panel.slice(at, at + 800),
      "门槛里装的应当是「中继」那一格（个人空间看得到它 ✓；⛔ 门槛本身不许再依赖服务端绑定 ✗）",
    ).toContain("<RelayStatusSection />");
  });
});

// ⭐⭐ **2026-10-14（owner：「去掉最下边这（根）横线」）** ✗ —— ⭐ 真机读数（CDP `:9222`）：
//    `footer.sync-foot` **h=25 ／ textLen=0** ✓，可它自己带着 `border-top: 1px solid` ＋
//    `padding: 12px 16px` ✓ ⇒ ⭐ 没有进度、也没有状态时，它渲染成**一条空横线**摆在面板最底下 ✓。
//    ⇒ ⭐ 修法＝**按同一个条件挂整格**（`syncing || status` ✓ —— 里面那两支本来就决定"有没有话说" ✓）；
//    ⛔ 不碰样式表 ✗（改 CSS 会动到常驻 chrome 那条不变量 `INV-UI-sync-panel-persistent-chrome` ✓）。
describe("面板底那条常驻状态条（`.sync-foot`）", () => {
  const panel = read("src/components/SyncPanel.tsx");

  it("⑧ 没有话说时**整格不挂**（⛔ 不许渲染成一条空横线 ✗）", () => {
    // 正：整格被同一个条件包着 ✓
    expect(
      panel,
      "⛔ `.sync-foot` 必须按「有没有话说」挂 ✗ —— 否则它会渲染成一条 25px 高的空横线（真机实测 ✓）",
    ).toContain("{(liveSyncing || status) && (");
    // 反：⛔ 不许把 `.sync-foot` 留成**无条件**挂在面板里（那样横线又回来了 ✗）。
    //   ⚠️ 判据取**它上一条语句**（⛔ 不是缩进 ✗ —— 缩进判不出"有没有条件" ✓，第一版就写错了 ✓）。
    const at = panel.indexOf('<footer className="sync-foot">');
    expect(at, "夹具前提：页脚要在").toBeGreaterThan(-1);
    const above = (panel.slice(0, at).trimEnd().split("\n").pop() ?? "").trim();
    expect(
      above,
      "⛔ 页脚上一条必须是那个条件 ✗（否则它又**无条件**挂了 ⇒ 空横线回来 ✓）",
    ).toBe("{(liveSyncing || status) && (");
  });
});

// ⭐⭐ **2026-10-14（owner：「看看是否需要添加滚动支持」）** ✗ —— ⭐ 答案是 **需要** ✓，判据＝真读数：
//    ⭐ CDP（`Emulation.setDeviceMetricsOverride` 改视口、⛔ 没 reload ✗）实测：
//      · **修前**：视口 1280×720 ⇒ 内容 899 ／ 可视 719 ⇒ ⭐ **静默裁掉 156px**（1180×640 裁 236px ✓），
//        ⭐ 而面板里**一个能滚的容器都没有** ✗（`.sync-popover` 有 `overflow-y:auto` ✓ 却从没被限高 ✓）；
//      · **修后**：`.main` 的 `scrollH === clientH` ✓（不再丢内容 ✓）、`.sync-popover` 就是那个滚动容器 ✓、
//        ⭐ 滚到底能看见最后一个后代 ✓（1180×520 同样成立 ✓）。
//    ⭐ 真因（⭐ 量出来的 ✓）：⭐ `.main > .sync-popover.is-inline` 那条**直子选择器从没匹配过** ✗
//    （真子级是 `.sync-panel` ✓）；⭐ 同一族：`.is-inline { height: 100% }` 的父级是**自动高** ⇒ 也不生效 ✗。
describe("同步面板：嵌进内容区那一档（`.is-inline`）要占满并能滚", () => {
  const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");

  it("⑨ 面板要按「占满 ＋ 内部滚」挂（⛔ 不许再被 `.main` 静默裁掉 ✗）", () => {
    expect(
      css,
      "⛔ 父级 `.sync-panel` 不给 flex ＋ `min-height:0` ⇒ 子项的 `flex:1 1 auto` 撑不进去 ⇒ 撑破后被裁 ✗",
    ).toContain(".sync-panel:has(> .sync-popover.is-inline) {");
    expect(
      css,
      "⛔ 子项没被钉成 `flex:1 1 auto; min-height:0` ⇒ `overflow-y:auto` 永远不会成为滚动容器 ✗",
    ).toContain(".sync-panel:has(> .sync-popover.is-inline) > .sync-popover.is-inline {");
    // ⛔ 那条**从来没匹配过**的死规则不许回来 —— ⭐ 它正是"以为修好了、其实没有"的来源 ✓。
    expect(
      css.split("\n").some((l) => l.trim() === ".main > .sync-popover.is-inline {"),
      "⛔ 直子选择器 `.main > .sync-popover` 匹配不到真子级 `.sync-panel` ⇒ 是死规则 ✗",
    ).toBe(false);
  });
});
