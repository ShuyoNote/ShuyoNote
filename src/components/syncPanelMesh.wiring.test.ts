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
    expect(meshAt, "网格那一步必须放在 catch 之后（＝ finally 里）").toBeGreaterThan(catchAt);
    expect(panel, "「立刻交换一轮」那个按钮应当已经删掉（同一个意图两个动作）").not.toContain("const meshRoundNow");
    expect(panel, "「立刻交换一轮」那个按钮应当已经删掉").not.toContain("void meshRoundNow()");
  });

  it("①b 自动同步也对网格生效（不是只有手点「同步」才换）", () => {
    const app = read("src/App.tsx");
    expect(app, "自动同步那条路没跑网格 ⇒ 用户得手点同步才会换").toContain("api.meshSyncNow(");
    // ⚠️ gate 只许有一处：Rust 侧 `mesh_sync_now` 自己早退；前端**不重判一遍**。
    //    （这条断言钉的是"别在 App 里再写一个 if (mesh.enabled)"那种第二份解释。）
    expect(app, "自动同步那条路里不该自己判网格开没开（gate 在 Rust 侧一处实现）").not.toContain("mesh.enabled");
  });

  it("② 门槛**不看服务端绑定**（个人空间也要能看到设备直连）", () => {
    // ⚠️ **2026-10-04 改**（owner：「个人空间不显示服务器同步内容，要显示设备直连的条目」）：
    //   原来这里要求 `!!activeRow?.space_id.trim()` ✗，而 ⭐ 今天 `set_sync_profile` 装了真拦
    //   （只有团队空间能绑服务器）⇒ 个人空间**永远拿不到 `space_id`** ⇒ 它的「设备直连」永远不显示 ✗
    //   —— 而那正是它唯一的远程路径 ✓。
    //   ⚠️ 原顾虑「会显示**别的空间**的地址」已不成立：`api.lanStatus(activeId)` 是**按空间查**的
    //   （Rust `lan_status(db, workspace_id)` ✓）。
    //   ⭐ 两处（网格设置那条 ＋ 地址读数那条）现在都只看「有活动空间那一行」。
    expect(panel, "设备直连的门槛不该再依赖服务端绑定").toContain(
      "isDesktopPlatform() && lanStatus && !!activeRow && (",
    );
    expect(panel, "旧门槛（要求 space_id）不该还在").not.toContain("!!activeRow?.space_id.trim() && (");
  });

  it("②b ⭐ 服务器那一段只列团队空间（个人空间不显示服务器同步内容）", () => {
    // owner 2026-10-04：「个人空间不显示服务器同步内容」。
    // 判据取"那里用的是 serverRows（按 kind 过滤）"这个形状；不给个人空间列服务器卡。
    expect(panel, "服务器那一段没用 serverRows ⇒ 个人空间也会被列进去").toContain("{serverRows.map((r) => {");
    const at = panel.indexOf("const serverRows =");
    expect(at, "没有 serverRows 的定义").toBeGreaterThan(-1);
    expect(panel.slice(at, at + 120), "serverRows 不是按团队过滤的").toContain('r.kind === "team"');
  });

  it("③ 「关掉网格」走清除（`\"\"`），不是 `null`（`null` ＝ 不动 ⇒ 关不掉）", () => {
    expect(panel).toContain('api.meshSetConfig(activeId, "", null)');
  });

  it("④ 「别人拉不拉得到」那句人话来自 Rust（界面不自己按地址形状判档）", () => {
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
    // ⭐ **U8（2026-10-01）扩的一条**（⛔ 上面几条**没删** ✗ —— 形状改了要**加**判据，不是换掉 ✓）：
    //   一扇门能服务**多个**空间 ⇒ 读数里必须有 `served`（否则界面说不出「这一扇门管几个」，
    //   而「关掉一个空间不许关掉整窗」这条口径就看不出来 ✓）。
    expect(commandsTs, "U8：`MeshConfigState` 少了 `served`（一扇门服务哪些空间）").toContain("served: string[];");
    // ⚠️ 而且 Rust 侧的窗口**不许**退回「一个空间一个窗口」（那正是 U8 要消灭的形状 ✓）——
    //   这两条是**结构断言**：注册表的键是**绑定**、鉴权走 `select_space` 那条白名单 ✓。
    const rustMeshU8 = read("src-tauri/src/mesh.rs");
    expect(rustMeshU8, "U8：窗口注册表的键应当是绑定").toContain("guard.insert(bind.to_string(), handle)");
    expect(rustMeshU8, "U8：鉴权应当走 `select_space` 那条白名单").toContain("fn select_space(");
  });

  // ★ 2026-09-26：网格那一块的**形状**（owner 截图 ＋ 真机实测：输入框 50px、按钮 44~50px 宽 ×
  //   64~112px 高 —— 就是"192."两个字母宽、"保存地址"一个字一行）。
  //   为什么用**文本级**判据：它在 `isDesktopPlatform()`（＝有没有 Rust 内核）后面，
  //   而 `verify-mobile-overlays.mjs` 跑的是 **Web** 平台 ⇒ 那里根本渲染不出来（写断言就是死断言）；
  //   桌面/手机的真机几何只能靠人。所以这里钉"形状不许回退"：
  //   谁把 `.sync-mesh` 改回横排、或去掉那句 `white-space:nowrap`，这几条立刻红。
  it("⑥ 网格那一块是竖排，且输入框吃宽、按钮不缩不断行（窄屏不许挤成并排）", () => {
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

  // ★★ 丙-⑤（2026-09-26）：**网格那一轮也要如实收场** —— 报得出 ＋ 说得到就做得到。
  //
  // 为什么这两条是承重的：网格这一档**没有服务端**，"你本机那一版让给了远端"与"有页等你裁决"
  // 这两件事**只能**由 `mesh_sync_now` 的读数报出来（Rust 侧 `round_note` 拼好那句话）。
  // 而且**说到了就必须做得到**：通知是「有 2 页等你裁决」，下面那一段却还是空的 —— 用户只会
  // 以为那两页丢了（那份清单是在网格**开跑之前**读的）。
  it("⑦ 人话来自 Rust（面板不自己数 superseded/awaiting 拼句子）", () => {
    const syncOne = panel.slice(panel.indexOf("const syncOne"), panel.indexOf("const update"));
    expect(syncOne, "网格那轮的结果没有原样显示 `rep.note`").toContain("${rep.note}");
    // 面板**不许**自己遍历 `rep.peers` 去数「输了几页」：那是第二份真相（Rust 里刚数过一遍）。
    expect(panel, "面板自己遍历网格读数拼句子了（应当是 `rep.note` 原文）").not.toContain("rep.peers");
    // 两侧成对：Rust `PeerPullReport` 新加的两项必须在契约里（否则界面拿到的是 undefined）。
    expect(commandsTs, "`MeshPeerPullReport` 少了 `superseded`").toContain("superseded: number;");
    expect(commandsTs, "`MeshPeerPullReport` 少了 `awaiting`").toContain("awaiting: number;");
  });

  it("⑧ 网格那轮之后两份清单跟着刷新（不然通知与现场对不上）", () => {
    const syncOne = panel.slice(panel.indexOf("const syncOne"), panel.indexOf("const update"));
    const meshAt = syncOne.indexOf("api.meshSyncNow(");
    expect(meshAt, "`syncOne` 里没有网格那一轮（结构变了？）").toBeGreaterThan(-1);
    const after = syncOne.slice(meshAt);
    // ⚠️ 断言必须落在**网格那一轮之后**：`try` 里那两个刷新调用在网格**之前**跑
    //    （服务端那条走完就读），拿它们冒充就是「测了个寂寞」。
    expect(after, "网格那轮之后没重拉页面列表 ⇒ 换过来的内容要切一次空间才看得见").toContain(
      "useNotes.getState().loadPages()",
    );
    expect(after, "网格那轮之后没重读「待取回的远端版本」⇒ 刚说有页等你裁决、那一段还是空的").toContain(
      "await loadPendingRemote()",
    );
  });

  // ★★ `VL-3`（2026-09-30）：**"功能通了，而普通用户不知道有这条路"**。
  //
  // 由来：`VL-2`（`d34c1c0f`）让 `0.0.0.0:<端口>` **能填了**（`checked_bind` 放行通配 ＋
  // `announced_bases_with` 按网卡枚举报出可达地址）—— 可面板里原来**只写"填虚拟网卡的地址"**
  // ⇒ 普通用户**不知道可以填 `0.0.0.0`** ⇒ "地址自动"这件事**在用户眼里没发生**（＝ `U5` 没解决）。
  // ⇒ 所以这两条钉的是：**那条路必须出现在用户看得见的文案里、且说清它是什么**；
  //    以及**那一屏不许出现已废／越界的措辞**。
  //
  // ⚠️ **「邀请」只在"设备直连那一屏"上禁**：面板**前半**有**团队版成员邀请**
  //    （注册邀请码／被邀请者邮箱／「邀请」按钮 —— 那是走服务端的**另一个功能**，仍在提供）。
  //    全文件禁会把那些**正当文案**判红（我核过：`邀请` 在 `SyncPanel.tsx` 里的出现**全在**
  //    「设备直连」那一屏**之前**，且都是团队版成员邀请与它的注释）⇒ 判据按**区域**收敛，
  //    而不是一刀切 —— 这条边界写在这里，免得后人"顺手"把它扩成全文。
  it("⑨ ⭐ VL-3：`0.0.0.0`（听所有网卡）那条路要在用户看得见的文案里，且说清它是什么", () => {
    // 去掉行注释：注释里讲"`0.0.0.0 ⇒ Err`"的历史**不算**用户可见文案。
    const copy = panel.replace(/\/\/[^\n]*/g, "");
    expect(copy, "地址那一栏没提 `0.0.0.0` ⇒ `VL-2` 开的这条在用户眼里不存在").toContain("0.0.0.0");
    expect(
      copy,
      "提了 `0.0.0.0` 却没说清它是什么 —— 必须写「听所有网卡」＋「地址由系统报出」",
    ).toMatch(/0\.0\.0\.0[\s\S]{0,160}?听所有网卡[\s\S]{0,40}?系统(自己)?报/);
    expect(copy, "另一条路（手填本机内网地址）也不许删 —— 两条都通").toContain("192.168.1.5:8788");
    expect(copy, "不许把地址说成「必须手填」（两条路都通）").not.toMatch(/必须(手填|填写)[^\n]{0,8}地址/);
    // ⚠️ 可见性：不许只写在 `title`（悬停才看得见）里 —— `placeholder` 或常规文案里也要有。
    const slots = [...copy.matchAll(/(?:placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]).join("\n");
    expect(slots, "`0.0.0.0` 只出现在悬停提示里 ⇒ 普通用户照样看不见").toContain("0.0.0.0");
  });

  it("⑩ ⭐ VL-3 红线：设备直连那一屏不许出现已废／越界措辞（含裸内部标识）", () => {
    const copy = panel.replace(/\/\/[^\n]*/g, "");
    const at = copy.indexOf('sync-row-label">设备直连');
    expect(at, "找不到「设备直连」那一屏（结构变了？）").toBeGreaterThan(-1);
    const device = copy.slice(at);
    // 口径来源：owner §14「设备直连只做配对，没有邀请」＋「只说"已配对"，不许说"已确认是您的设备"」
    // ＋「不承诺所有 VPN 都能用」（我们只放行了常见默认网段）。
    for (const bad of [
      "邀请",
      "请先加密",
      "所有 VPN",
      "所有VPN",
      "任何 VPN",
      "任何VPN",
      "已确认是您的设备",
      "已验证是您的设备",
    ]) {
      expect(device, `设备直连那一屏不该出现「${bad}」`).not.toContain(bad);
    }
    // ③ 裸 id：这一屏的**用户可见槽位**不许出现内部标识（`INV-UI-copy-no-internal-ids`）。
    const slots = [...device.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]).join("\n");
    expect(slots.length, "没抓到任何用户可见槽位（抽取规则变了？）").toBeGreaterThan(0);
    for (const id of ["space_id", "device_id", "ws_id"]) {
      expect(slots, `用户可见文案里不该出现内部标识 ${id}`).not.toContain(id);
    }
  });
});
