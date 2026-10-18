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
// ✅ **2026-10-10 接线完成**：`kind` 原先**到不了渲染层**（Rust `workspaces.rs` 的 `WS_COLS` 没选它 ✗）
//    ⇒ 三处数据流已补（`WS_COLS` ＋ `models.rs::WorkspaceMeta` ＋ `src/types.ts`）＋
//    三处渲染各加一句 `showsServerTag(kind, url)` ✓ ⇒ 下面那些"接线"断言现在**真的**在岗 ✓。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { showsNotifications, showsServerTag, syncTagColor, syncTagLabel, syncTagTitle } from "./syncTag";

const read = (p: string) => readFileSync(p, "utf8");
const URL_IP = "http://121.199.8.9:8787";

describe("服务器标识 · 规则（纯函数：规则只有这一处实现）", () => {
  it("① 个人空间 ⇒ **不显示**（旧行为必红：它照样把地址渲染成文字）", () => {
    expect(showsServerTag("personal", URL_IP)).toBe(false);
    // ⚠️ 未分类（`""`）按个人处理 —— 与仓内既有口径同向（`set_sync_profile` 那道 team-only 拒）✓
    expect(showsServerTag("", URL_IP)).toBe(false);
    expect(showsServerTag("其它", URL_IP)).toBe(false);
    // ⚠️ **拿不到 kind ⇒ 也不显示**（fail-closed ✓）：⛔ 不许"传丢了就恰好放行" ✗
    expect(showsServerTag(undefined, URL_IP)).toBe(false);
  });

  it("② 团队空间 ＋ 有服务器 ⇒ 显示；缺一样都不显示", () => {
    expect(showsServerTag("team", URL_IP)).toBe(true);
    expect(showsServerTag("team", "")).toBe(false);
    expect(showsServerTag("team", "   ")).toBe(false);
    expect(showsServerTag("team", null)).toBe(false);
    expect(showsServerTag("team", undefined)).toBe(false);
    expect(showsServerTag("personal", "")).toBe(false);
  });

  it("①b ⭐「工作」那一例（截图里那枚 IP 胶囊）：`kind=\"personal\"` ⇒ 那个点也必须消失", () => {
    // 数据侧读数（只读查 app data 的 `meta.db`）：`工作` ＝ `91f96e7f…`、`kind="personal"`，
    // 而 `sync_profiles` 里留着一行**过期的** `server_url`（`has_token=0`）—— 见给 Lead 的报告。
    // ⇒ 这一句就是"那个点还会不会显示"的判据：personal ⇒ false ⇒ **不渲染** ✓
    const staleRow = { kind: "personal", server_url: "http://121.199.8.9:8787" };
    expect(showsServerTag(staleRow.kind, staleRow.server_url)).toBe(false);
    // ⚠️ 反面必须有：同一行若是团队空间 ⇒ 显示 ✓（否则这条判据可能"恒 false"地假绿 ✗）
    expect(showsServerTag("team", staleRow.server_url)).toBe(true);
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
  // ⚠️ 判据只判**代码**，不判注释：注释里会**引用**这些模式去解释规则
  //    （实测踩过一次：TitleBar 注释里写了「⛔ 不在这里写 `kind === "team"`」⇒ 直接把判据判红 ✗
  //     —— 与本工作区"讲解规则的文档触发了规则本身"那一类同形 ✓）。
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const pageTreeCode = code(pageTree);
  const titleBarCode = code(titleBar);

  it("① 两处**都不再把地址渲染成文字**（旧行为必红：渲染的就是 `syncTagLabel(...)`）", () => {
    expect(pageTreeCode, "侧栏胶囊/空间行里的地址文字还在").not.toContain("syncTagLabel(");
    expect(titleBarCode, "标题栏里的地址文字还在").not.toContain("syncTagLabel(");
  });

  it("① **两处都真的问了那条规则**（⛔ 别只改侧栏 ✗；PageTree 两个渲染点都要问）", () => {
    expect(
      (pageTreeCode.match(/showsServerTag\(/g) ?? []).length,
      "PageTree 的两处渲染都要过这道门（侧栏胶囊 ＋ 空间列表行）",
    ).toBeGreaterThanOrEqual(2);
    expect(titleBarCode, "TitleBar 没过那道门 ⇒ 个人空间在标题栏照样显示").toContain("showsServerTag(");
    // ⛔ 渲染层不许自己判 kind：规则只有一处，否则下一处接上去就会漂 ✗
    expect(pageTreeCode, "PageTree 自己判 kind 了").not.toMatch(/kind\s*===\s*"team"/);
    expect(titleBarCode, "TitleBar 自己判 kind 了").not.toMatch(/kind\s*===\s*"team"/);
  });

  it("② 颜色点还在（⛔ 不许把整个胶囊删掉）＋ 两处同源 `syncTagColor`", () => {
    expect(pageTreeCode).toContain("sidebar-sync-dot");
    expect(pageTreeCode).toContain("space-item-sync-dot");
    expect(titleBarCode).toContain("titlebar-sync-dot");
    expect((pageTreeCode.match(/syncTagColor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(titleBarCode).toContain("syncTagColor(");
  });

  it("③ **悬停仍要给地址**（⛔ 不许连提示都删掉 —— 那就成了「整个去掉」，owner 没选它）", () => {
    expect(pageTreeCode).toContain("syncTagTitle(");
    expect(titleBarCode).toContain("syncTagTitle(");
    // 前缀只在 `syncTagTitle` 里拼一次；页面里不许再手拼（两处会漂）
    expect(pageTreeCode, "PageTree 手拼了提示前缀").not.toContain("同步目标：${");
    expect(titleBarCode, "TitleBar 手拼了提示前缀").not.toContain("同步目标：${");
    expect(pageTreeCode, "PageTree 手拼了另一个前缀").not.toContain("同步：${");
    expect(titleBarCode, "TitleBar 手拼了另一个前缀").not.toContain("同步：${");
  });

  it("⑤ 无障碍：那个点必须有可读的名字（aria-label 与悬停同一处文案）", () => {
    expect(pageTreeCode, "PageTree 的颜色点没有可读名字").toMatch(/aria-label=\{syncTagTitle\(/);
    expect(titleBarCode, "TitleBar 的颜色点没有可读名字").toMatch(/aria-label=\{syncTagTitle\(/);
  });
});

describe("服务器标识 · 数据流（`kind` 真的发出来了吗）", () => {
  const ws = read("src-tauri/src/workspaces.rs");
  const models = read("src-tauri/src/models.rs");
  const types = read("src/types.ts");

  it("① Rust 侧：`WS_COLS` 含 `kind` ＋ `row_to_meta` 取到它（⛔ 追加在最后，别把前 7 列错位）", () => {
    const cols = /const WS_COLS: &str = "([^"]+)"/.exec(ws)?.[1] ?? "";
    expect(cols.split(","), "`WS_COLS` 没有 kind ⇒ 界面永远拿不到空间分类").toContain("kind");
    expect(
      cols.split(",").indexOf("kind"),
      "`kind` 必须**追加在最后**（`row_to_meta` 按**下标**取值 ⇒ 插中间会把后面每一列都错位）",
    ).toBe(cols.split(",").length - 1);
    expect(ws, "`row_to_meta` 没有把第 8 列读进 `kind`").toMatch(/kind:\s*row\.get\(7\)\?/);
  });

  it("① 两个结构都带 `kind`（Rust `WorkspaceMeta` ＋ TS `WorkspaceMeta`）", () => {
    expect(models, "Rust `WorkspaceMeta` 没有 kind").toMatch(
      /pub struct WorkspaceMeta \{[\s\S]*?pub kind: String/,
    );
    expect(types, "TS `WorkspaceMeta` 没有 kind").toMatch(/interface WorkspaceMeta \{[\s\S]*?kind\?: string/);
  });

  it("① **第二处硬编码的列清单**（导入空间那条路）也要带 `kind`", () => {
    // ⚠️ 这是 `cargo check` 抓出来的：`workspace_io.rs` **没用** `WS_COLS`，自己写了一遍列清单
    //    ⇒ 只补 `WS_COLS` 那边的话，**导入回来的空间**会缺 `kind`（`undefined` ⇒ 标识不显示 ✗）。
    const io = read("src-tauri/src/workspace_io.rs");
    expect(io, "导入空间那条路的 SELECT 没有 kind").toMatch(
      /SELECT id,name,theme,icon,sort_order,created_at,updated_at,kind FROM meta\.workspaces/,
    );
    expect(io, "导入空间那条路没有把 kind 读出来").toMatch(/kind:\s*r\.get\(7\)\?/);
  });
});

// ⭐ 2026-10-18（owner：「那就去掉通知」）：**「通知」只在团队空间出现**。
//   规则与上面同一条脾气 —— 只在一处实现（`showsNotifications`），⛔ 界面里不许再写 `kind === "team"` ✗。
describe("「通知」菜单项按空间类型显隐", () => {
  it("① 规则：团队 ⇒ 显示；个人／未分类／拿不到 ⇒ 不显示（fail-closed）", () => {
    expect(showsNotifications("team"), "团队空间要有「通知」").toBe(true);
    expect(showsNotifications("personal"), "⛔ 个人空间不许有「通知」").toBe(false);
    expect(showsNotifications(""), "未分类按个人处理").toBe(false);
    expect(showsNotifications(undefined), "拿不到类型 ⇒ 不显示（宁可不显示也不误显示）").toBe(false);
  });

  it("② 接线：`EditorToolbar` 那两颗由 `showsNotifications` 判，且**只有「通知」**被它包住", () => {
    const src = read("src/components/EditorToolbar.tsx");
    // ⚠️ 判「有没有自己判 kind」时必须**先剥注释**：本文件的注释里就写着那句禁令（`⛔ … kind === "team"`），
    //    不剥会把"说明"当成"违规" ✗（本仓踩过同形假红：`check-im-boundary` 的注释误判）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code, "工具栏要引用这条规则").toContain("showsNotifications(");
    expect(code, "⛔ 界面不许自己判 kind（第二份真相）").not.toMatch(/kind\s*===\s*"team"/);
    // 讨论那颗在条件块**之外**、通知那颗在**之内**：拿两段的相对位置核
    const discussAt = src.indexOf('openComments(true, "comments")');
    const guardedAt = src.indexOf("withNotifications &&");
    const notifAt = src.indexOf('openComments(true, "notifications")');
    expect(discussAt, "「讨论」那颗要在").toBeGreaterThan(-1);
    expect(guardedAt, "条件渲染要真的存在").toBeGreaterThan(-1);
    expect(notifAt, "「通知」那颗要在").toBeGreaterThan(-1);
    expect(discussAt, "「讨论」必须在条件块**之前**（⛔ 别把两颗一起藏 ✗）").toBeLessThan(guardedAt);
    expect(notifAt, "「通知」必须在条件块**之后**（＝被包住 ✓）").toBeGreaterThan(guardedAt);
    // 条件块里应当只包着「通知」那颗（到下一个兄弟条目 `copyMarkdown` 为止），
    // ⛔ 不能顺手把「讨论」也卷进去 ✗
    const block = src.slice(guardedAt, src.indexOf("copyMarkdown()"));
    expect(block, "条件块里要包着「通知」那颗").toContain("BellIcon");
    expect(block, "条件块里要留着它的 testid（判据能点到）").toContain("menu-notifications");
    expect(block, "⛔ 条件块里不许出现「讨论」那颗").not.toContain("CommentIcon");
  });

  it("③ 抽屉里的「通知」页签也按同一口径藏（owner：「抽屉面板里面的通知也去掉」）", () => {
    const src = read("src/components/CommentsDrawer.tsx");
    expect(src, "抽屉要引用同一条规则").toContain("showsNotifications(");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code, "⛔ 抽屉里也不许自己判 kind").not.toMatch(/kind\s*===\s*"team"/);
    const guardedAt = code.indexOf("withNotifications &&");
    const tabAt = code.indexOf('setTab("notifications")');
    expect(guardedAt, "页签要真的在条件块里").toBeGreaterThan(-1);
    expect(tabAt, "页签按钮要在").toBeGreaterThan(-1);
    expect(guardedAt, "条件块要在页签之前（包住它）").toBeLessThan(tabAt);
    // 关键词：正文用**回落后的** tab —— 否则个人空间里 `commentsTab` 还停在 notifications 时
    // 会渲染出一页空的「通知」（本判据就是为了钉这个残留态 ✓）
    expect(code, "正文必须用回落后的 tab（个人空间回落「评论」）").toMatch(/effectiveTab\s*===\s*"comments"/);
  });
});
