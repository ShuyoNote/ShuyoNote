// ★ 丙-③-b-2b-2：**网格（对等交换）在面板上真的要有一个可点的入口**。
//
// 为什么用**文本级**判据：这一片的价值全在"用户点得到"上，而"点得到"在 Node 里跑不出来
// （要真 Chromium ＋ 真命令面）。所以这里钉**结构**，与 `lanMulticast.wiring.test.ts` 同一手法：
// 命令面、门槛、清除语义、读数的来源，四处必须同时在岗 —— 少任何一处，这一档都用不了。
//
// ⚠️ 这几条**不是**在验业务逻辑（那在 Rust 侧与 `src/lib/platform` 的判据里），
// 它们只回答一个问题：**界面接上了没有**。
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("网格（丙-③-b）· 面板接线", () => {
  const panel = read("src/components/SyncPanel.tsx");
  // ⭐⭐ **2026-10-14（owner：「去掉孤儿组件」）** ✗：抽出去的那个 `MeshAdvancedForm.tsx` **已删** ✓
  //    （它先丢了挂载点、随后整份走了 ✓）⇒ ⛔ 不再有「两个文件一起读」✗。⭐ 按 R192「换对象不删断言」✗：
  //    ⛔ ③ 与 ⑨ 不是删掉 ✓，而是换成**现在承重的落点**（后端命令面 ＋ `mesh.rs` 那条口径 ✓）。
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
    //   ⚠️⭐ **2026-10-14（真机 CDP 实测）**：⭐ 门槛虽然去掉了 `space_id` ✓，⛔ **但 `!!activeRow` 还在** ✗，
    //     而**个人空间没有同步档案行** ⇒ `activeRow` 为空 ⇒ ⭐ 整块仍不渲染 ✗ ——
    //     ⭐ 这正是 owner 连问三次「同步面板还是旧的」的机械原因 ✓。⇒ ⭐ 现在放行 `isPersonalActive` ✓。
    expect(panel, "设备直连的门槛不该再依赖服务端绑定").toContain(
      "isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive) && (",
    );
    expect(panel, "旧门槛（要求 space_id）不该还在").not.toContain("!!activeRow?.space_id.trim() && (");
    expect(panel, "旧门槛（要求 activeRow）也不该还在").not.toContain("&& !!activeRow && (");
    // ⚠️⭐ **2026-10-14 第二个真因**：⭐ 读数 effect 原来只在 `open` 时才拉 ✗ ⇒
    //    ⭐ `contentOnly`（⭐ 左栏那颗「同步」走的正是它 ✓）拿到的 `lanStatus` 永远是 null ✗
    //    ⇒ ⭐ 依赖它的那两块（⭐ 设备直连折叠／地址行 ✓）**永远不渲染** ✓。⭐ 这条钉住修法 ✓。
    expect(panel, "contentOnly 也要去读 lanStatus（否则那两块永远不渲染）").toContain(
      "if ((!open && !contentOnly) || !isDesktopPlatform()) return;",
    );
  });

  it("②b ⭐ 服务器那一段只列团队空间（个人空间不显示服务器同步内容）", () => {
    // owner 2026-10-04：「个人空间不显示服务器同步内容」。
    // 判据取"那里用的是 serverRows（按 kind 过滤）"这个形状；不给个人空间列服务器卡。
    expect(panel, "服务器那一段没用 serverRows ⇒ 个人空间也会被列进去").toContain("{serverRows.map((r) => {");
    const at = panel.indexOf("const serverRows =");
    expect(at, "没有 serverRows 的定义").toBeGreaterThan(-1);
    expect(panel.slice(at, at + 120), "serverRows 不是按团队过滤的").toContain('r.kind === "team"');
  });

  it("③ 「关掉网格」走清除（`\"\"`），不是 `null` —— **换对象**：那条界面已撤，口径归后端", () => {
    // ⭐ **2026-10-14（owner：先拍删那张卡 ⇒ 再拍「去掉孤儿组件」）** ✗：这一条原来钉的是界面里那句
    //   `api.meshSetConfig(activeId, "", null)` ✓ —— ⭐ 它住的 `MeshAdvancedForm.tsx` **已删** ✓ ⇒ ⭐ 对象没了 ✓。
    //   ⭐ 按 R192 换对象：⛔ 不删这条 ✓，换成**现在承重的那两半** ✓：
    //     · ⛔ 界面里不许再有那句（撤了就是撤了 ✓）；
    //     · ⭐ 「清除 ＝ 空串、⛔ 不是 `null`」这条口径**在后端仍有承重**（`mesh.rs` 的 `mesh_set_config` ✓）。
    // ⚠️ **必须先剥注释** ✗ —— 本文件的 `read()` 是**原样读**（不剥 ✓），而面板里那条注释**正是**在讲这句
    //    调用 ✓（`SyncPanel.tsx` 的 `disableMesh` 那条 ✓）⇒ ⛔ 不剥的话这条判据会被**解释它自己的注释**喂饱 ⇒ 假红 ✓
    //    （实测：第一版就是这么红的 ✓）。
    const stripped = panel.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped, "⛔ 界面里那条清除调用已撤（owner 2026-10-14 拍删 ✓）").not.toContain('api.meshSetConfig(activeId, "", null)');
    const meshRs = readFileSync(resolve(__dirname, "..", "..", "src-tauri", "src", "mesh.rs"), "utf8");
    expect(meshRs, "⭐ 那条口径后端仍在（`mesh_set_config` ✓）").toContain("mesh_set_config");
  });

  it("④ 「别人拉不拉得到」那句人话来自 Rust（界面不自己按地址形状判档）", () => {
    // 2026-09-26（地址一处）：这句现在与 `lanStatus.line` 拼在**同一行**里 —— 仍然是 Rust 出的原文
    // （`lanStatus.mesh.note`），界面只是把它摆到那一行去。
    // ⭐ **2026-10-14**：那句人话现在分两格 —— ⭐ 绿条第二行取 `.reach` ✓（见 `syncControls` ④ ✓）。
    expect(panel).toContain("lanStatus.mesh.reach");
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
  it("⑨ ⭐ VL-3（**换对象**）：`0.0.0.0` 那条路**已从界面撤掉** —— 它现在只由后端承重", () => {
    // ⭐⭐ **2026-10-14（owner：先「整张卡连输入框一起去掉」⇒ 再「去掉孤儿组件」）** ✗：这一条原来钉的是
    //   ⭐「那条路要在**用户看得见的文案**里」✓（`panel + meshForm` ✓）—— ⭐ 而两处载体（面板那张卡 ＋
    //   `MeshAdvancedForm.tsx` ✓）**都删了** ✓ ⇒ ⭐ 界面这一侧**没有载体**了 ✓。
    //   ⭐ 按 R192「换对象不删断言」✗：⛔ 不是把这条删掉 ✓，换成**现在承重的两半** ✓：
    //     · ⛔ 界面**不许再提供**填地址的入口（挂载点 0 处 ＋ 组件文件已删 ✓）；
    //     · ⭐ 那条口径**仍然后端一侧承重** ✓（`src-tauri/src/mesh.rs`：通配 ⇒ 听所有网卡 ⇒ 报枚举到的 ✓）；
    //     · ⭐ 而「读数的形状」那条说明留在面板里（`splitMeshBind` ✓ —— 它讲的是拆 `0.0.0.0:8788` 这种串 ✓）。
    const code = panel.replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(
      code.split("\n").some((l) => l.trim() === "<MeshAdvancedForm"),
      "⛔ 面板里不许再有填地址那一块的挂载点 ✗（owner 2026-10-14 拍删 ✓）",
    ).toBe(false);
    expect(
      existsSync(resolve(__dirname, "MeshAdvancedForm.tsx")),
      "⛔ 那个组件**已删**（owner「去掉孤儿组件」✓）—— ⛔ 不许加回来一个没人挂的 ✗",
    ).toBe(false);
    const meshRs = readFileSync(resolve(__dirname, "..", "..", "src-tauri", "src", "mesh.rs"), "utf8");
    expect(meshRs, "⭐ 那条口径**后端仍在**：通配 ⇒ 「听所有网卡」（⛔ 撤的是界面，⛔ 后端没撤 ✗）").toContain("听所有网卡");
    expect(meshRs, "⭐ 通配那条分支仍在（`is_unspecified` ✓）").toContain("is_unspecified");
    expect(panel, "⭐ 「读数的形状」那条文档仍在（`splitMeshBind` ✓）").toContain("splitMeshBind");
  });

  it("⑨b ⭐ 2026-10-14（owner：「去掉这部分」）：那句「AP 隔离／开手机热点」提示**已删** ⇒ ⛔ 不许再渲染", () => {
    // ⚠️ 为什么钉这条：它原先**故意常显**（旧注释写着"代价是多一行字"）⇒ 按设计图⑦ 应改成
    //    「**连不上时**这里会说出原因」✓。⛔ 而判据**不许**去解析 `lanStatus.line`（那是上面钉着的口径：
    //    界面不自己按读数再判一次档）⇒ 只能用**结构化**的 `lanStatus.peers`
    //    （它与状态行那个"N 台"**是同一个数**，`INV-NEARBY-one-source` ✓）。
    // ⚠️ 注释要**两种都去掉**：上一版只去了 `//` ⇒ 而我自己那段 JSX 注释（`{/* … */}`）里
    //    也写着 `lanStatus.peers === 0` ⇒ **判据被自己的注释喂饱了**，真变异（把条件改回常显）
    //    竟然还是绿的 ✗（实测：13 passed）。
    // ⚠️ 第二版又绿了一次 ✗ ⇒ 真因：`lanStatus.peers === 0` 这个字串在面板里**不止一处**（别处也在用读数）
    //    ⇒ `toContain` 被**别处**的用法满足 ✓。⇒ 改成**邻近判据**：条件**紧跟着**那句提示才算数。
    const copy = panel.replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    // ⭐⭐ **2026-10-14（owner：「去掉这部分」）** ✗：⭐ 那块提示**整块删了** ✓（连着它的条件块 ✓）——
    //   ⚠️ 上面那三段注释是**当时的**口径（"⛔ 不许常显、要挂结构化读数上"✓），保留作历史 ✓。
    //   ⭐ 按 R192「**换对象不删断言**」✗：⛔ 三条一条没删 ✓，全部翻成**反面**（"不许再渲染"）✓：
    expect(
      copy,
      "⛔ 那句「AP 隔离」提示不许再渲染 ✗（owner 2026-10-14：「去掉这部分」✓）",
    ).not.toContain("AP 隔离");
    expect(copy, "⛔ 「开手机热点」那半句也一起去掉了 ✓ —— ⛔ 别只删一半 ✗").not.toContain("开手机热点");
    expect(
      copy,
      "⛔ 也不许把它改挂到别的读数上（`peers === 0 &&` 那种条件块不许回来 ✗）",
    ).not.toMatch(/peers === 0\s*&&\s*\(/);
  });

  it("⑨c ⭐ 2026-10-11：面板里的强调要用 `<b>`，⛔ 不许写 Markdown 的 `**…**`（那会在界面上原样显示星号）", () => {
    // ⚠️ 来由（owner 2026-10-11 截图实测）：「严格模式（高级）」那一折里「只是要**配两次**」
    //    在界面上**原样显示成了星号** ✗ —— 因为它是**我们自己写死的** JSX 文本（⛔ 不是后端来的），
    //    所以没走 `inlineMd`（那条契约只管 Rust 来的话 ✓）。⛔ 也不该再补 inlineMd ✗：
    //    自己写的文案直接用 `<b>` 就对了（`TrustDevicePanel` 头部写着同一条口径 ✓）。
    // ⚠️ 注释要**两种都去掉**（`//` 与 `/* … */`）：否则注释里的 `**` 会让这条判据**永远是红的**（假红 ✗）。
    // ⚠️ 还要去掉**走过 `inlineMd("…")`** 的那些 —— ⭐ 那些是**正确用法** ✓（那条契约就是给"后端来的话"用的 ✓）
    //    举例：`{inlineMd("填 **本机内网地址**（…）")}` ✓。⛔ 不排除 ⇒ 判据一次报 14 处假红（实测 ✓）。
    const code = panel
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/inlineMd\("(?:[^"\\]|\\.)*"\)/g, "");
    const bad = code.match(/\*\*[^*\n]{1,40}\*\*/g);
    expect(bad, `JSX 文本里出现了 Markdown 粗体：${bad?.[0]} ⇒ 请用 <b> 包起来`).toBeNull();
    // ⭐⭐ **2026-10-14（实测漏过一次）** ✗：⭐ 一条 JSX 注释的**最后一行**在改它时**掉到了注释外面** ✓
    //   ⇒ ⭐ 那句话**当成正文渲染出来了** ✓（真机截图里看到「判据 `syncPanelMesh` ② 钉的仍是…」✓）。
    //   ⚠️ 上面那条 `**` 判据**抓不到它** ✗（漏出来的那行里没有星号 ✓）⇒ ⭐ 这里补一条**注释体**判据：
    //   ⭐ 剥注释之后，面板里**不许**再出现只有注释里才用的那几种写法 ✓（⛔ 它们不该给用户看 ✗）。
    for (const marker of ["判据 `", "钉的仍是", "本笔", "owner 2026-10-14"]) {
      expect(code, `⛔ 注释体「${marker}」漏到 JSX 正文里了（实测踩过一次 ✓）`).not.toContain(marker);
    }
  });

  it("⑩ ⭐ VL-3 红线：设备直连那一屏不许出现已废／越界措辞（含裸内部标识）", () => {    const copy = panel.replace(/\/\/[^\n]*/g, "");
    // ⚠️ **2026-10-14（owner 拍删「设备直连」那一折）** ✗：这一屏的锚从**那条行的摘要**（`sync-row-label">设备直连` ✓，
    //    它随行一起删了 ✓）换成 ⭐ **这一组的开头**（`sync-group is-advanced` ✓）—— ⭐ 按 R192「换对象不删断言」✗：
    //    ⛔ 断言一条没删 ✓，只换**这一屏的入口** ✓。
    //    ⚠️⭐ **同日再改（owner：「和上面重复了」「一个不剩，全去掉」）** ✗：⭐ 卡片标题「设备直连设置」
    //    （与**面板标题「设备直连」**重复 ✓）**也删了** ✓ ⇒ ⭐ 再钉一道**语义**（标题没了，就用**那一组的成员**
    //    认这一屏 ✓）：这一屏里必须**还有** `<MeshAdvancedForm` ✓。
    //    ⚠️ ⛔ **不能**把锚换成那一块的门槛（`isDesktopPlatform() && lanStatus && …`）✗ —— **实测踩到**：
    //    那个门槛在**输入框那一格之后** ⇒ ⛔ 后面的 `SyncPanel.tsx` 里**一个可见槽位字面都没有** ✗
    //    （`placeholder=` 长在 `MeshAdvancedForm.tsx` 里 ✓）⇒ 下面那句 `slots.length > 0` 会假红 ✓。
    const at = copy.indexOf('className="sync-group is-advanced"');
    expect(at, "找不到「设备直连」那一屏（结构变了？）").toBeGreaterThan(-1);
    const device = copy.slice(at);
    // ⚠️ **2026-10-14 稍后（owner：「和上面重复了」⇒ 拍「整张卡连输入框一起去掉」）** ✗：⭐ 那张卡
    //    （`MeshAdvancedForm` 的挂载点 ✓）**也删了** ✓ ⇒ ⭐ 这一屏里现在**真实的成员**是「中继」那张卡 ✓
    //    （`RelayStatusSection` ✓）⇒ ⭐ 锚语换成它 ✓。
    //    ⚠️ ⛔ **不许**写 `<MeshAdvancedForm` 来认这一屏 ✗ —— **实测踩到**：上面那段注释里**就写着**这个
    //    字面 ✓ ⇒ 那条 `toContain` 会被**解释它的注释**喂饱 ⇒ **假绿** ✓（本笔就是顺手把它堵掉 ✓）。
    expect(device, "这一屏里应当还有中继那张卡").toContain("<RelayStatusSection />");
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

  // ⭐⭐ **2026-10-14（真机截图：状态条那一行把 `**` 原样摆出来了）** ✗ ——
  //   ⭐ 「窗口**听所有网卡**」／「**能被别人拉到**」两句在**界面上真出现了星号** ✓。
  //   ⭐ 真因：那一格是 `{shown(note)}` **裸渲染** ✗ —— 而 `note` 是 **Rust 来的行内 Markdown**
  //   （`mesh.rs` 那句逐字就是 `**能被别人拉到**` ✓）。⭐ 契约（`src/lib/inlineMd.tsx` ✓）要求：
  //   ⭐ **后端来的话必须在【渲染边界】过 `inlineMd`** ✓；面板自己写的文案才用 `<b>` ✓（⑨c 那条管的是后者 ✓）。
  //   ⚠️ 这一格**新增**（⛔ 不是改既有断言 ✗）：那条 `**` 是这一笔真踩出来的 ⇒ 它得有守卫 ✓。
  it("⑪ ⭐ 后端来的那句（`mesh.reach`）必须在渲染边界过 `inlineMd`（⛔ 不许裸渲染）", () => {
    const strip = readFileSync(resolve(__dirname, "SyncStatusStrip.tsx"), "utf8");
    expect(
      strip,
      "⛔ 绿条没给 `mesh.reach` 过 `inlineMd` ⇒ 屏上会出现字面 `**`（2026-10-14 真机实测 ✓）",
    ).toContain("inlineMd(reach)");
    // 反：⛔ 不许把它**裸**摆上去（`{shown(note)}` 与 `{note}` 这两种形状都算裸 ✓）。
    // ⚠️ 判据只看**代码**（剥注释 ✓）—— 文件头那段**正是在讲这次事故** ✓，不剥就会拿说明文字当代码判 ✓。
    const code = strip.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "⛔ 不许裸渲染（要过 `inlineMd`）").not.toContain("{shown(reach)}");
    expect(code, "⛔ 不许裸渲染（要过 `inlineMd`）").not.toMatch(/\{reach\}/);
    // ⚠️ 旧形状（`note`）也一并禁掉 ✓ —— 那一格已经不摆 `note` 了（第一行那两格说短了同一件事 ✓）。
    expect(code, "⛔ 不许裸渲染 `note`").not.toContain("{shown(note)}");
    // 而那句读数的来源仍是 Rust 的**原文**（⛔ 界面不自己拼一句 ✗）：
    // ⭐ **2026-10-14（owner：顶上那条拆两行）**：⭐ 那句话现在来自 `mesh.reach` ✓ ——
    //   ⭐ 判据换对象不删条（R192 ✓）：口径一字不变 —— ⭐ 仍是**后端原文**，⛔ 界面不自己拼 ✗。
    expect(panel, "那句话应当仍是 `mesh.reach` 原文（⛔ 界面不自己拼 ✗）").toContain(
      "reach={lanStatus?.mesh?.reach",
    );
  });
});

// ⭐ **片 D1a-1（2026-10-14，owner 截图）** ✗：⭐ **0 台时三段标题也要在** ✓（⭐ 每段底下一行实话 ✓，⛔ 不编数字 ✗）
//   ⚠️ ① 是**源码级**判据 ✓（⭐ 明标 ✗ —— DOM 级**测不到** ✗：⭐ 那一整块被 `lanDirectOn` 挡着 ✓）；
//   ⭐ ② 是锁（⭐ 今天已绿 ✓）。
describe("片 D1a-1：0 台时也渲染三段标题", () => {
  const src = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
  const branch = () => {
    const at = src.indexOf("nearby.length === 0 ? (");
    if (at < 0) throw new Error("找不到 `nearby.length === 0` 那一支");
    // ⚠️ ⭐ **必须剥注释** ✗：这一段是**源码切片** ✓ ⇒ 注释里只要提到那句话，
    //   下面的 `not.toContain` 就会被**自己的解释**喂饱 ✗（2026-10-14 实测踩到 ✓；
    //   本文件 225-229 行早就抱怨过同族的坑 ✓）。testid 与文案都在**代码**里 ✓ ⇒ 剥了照样判得出 ✓。
    return src
      .slice(at, src.indexOf(") : (", at))
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  };

  it("① ⭐（源码级）那一支里 `nearby-group-*` 的 testid 都在（⛔ 不含异常段 ✗）", () => {
    const b = branch();
    for (const id of ["nearby-group-trusted", "nearby-group-pending"]) {
      expect(b, "⛔ 0 台时那一段标题也要在 ✗：" + id).toContain(id);
    }
    // ⭐⭐ **2026-10-14（owner：「这部分默认不出现可以吗？」）** ✗：⭐「需要重新配对」是**异常段** ✓
    //   ⇒ ⭐ **0 台时不出现** ✓ —— 这本来就是**有设备那一支**的行为 ✓
    //   （`showWhenEmpty: g.testid !== "nearby-group-keychanged"` ✓）⇒ 上一版这一支硬渲染它 ✗ 是**两支不一致** ✓。
    //   ⭐ 按 R192「**换对象不删断言**」✗：⛔ 这条没删 ✓，从 for 里挪出来**翻成反面** ✓。
    expect(
      b,
      "⛔ 「需要重新配对」那一整段不许再渲染 ✗（它是异常段 ✓：0 台时不出现，与有设备那一支一致 ✓）",
    ).not.toContain("nearby-group-keychanged");
    expect(b, "⭐ 每段底下一行**实话** ✓（⛔ 不编数字 ✗）").toContain("这一轮没找到这一段的设备");
    // ⭐⭐ **2026-10-14（owner 选 C：「文案合并」）** ✗：⭐ 那句总说明**已删** ✓（它与三段计数同义 ✓）
    //   ⇒ ⭐ 按 R192「**换对象不删断言**」✗：⛔ 这条没删 ✓，从「保留」翻成「**不许再渲染**」✓。
    expect(
      b,
      "⛔ 那句总说明不许再渲染 ✗（owner 2026-10-14：「文案合并」✓ —— 它与三段计数说的是同一件事 ✓）",
    ).not.toContain("还没发现别的设备");
  });

  it("② 锁（今天已绿 ✓）：`NEARBY_GROUPS` 三条 label 逐字未变 ＋ 另两支逐字未变", () => {
    expect(src, "⭐ 三条 label 逐字 ✓").toContain('{ testid: "nearby-group-keychanged", label: "需要重新配对" }');
    expect(src, "⭐ 三条 label 逐字 ✓").toContain('{ testid: "nearby-group-trusted", label: "已信任" }');
    expect(src, "⭐ 三条 label 逐字 ✓").toContain('{ testid: "nearby-group-pending", label: "待配对" }');
    expect(src, "⛔ 「看不到这一层」那一支不许动 ✗").toContain("附近的设备：这台机器上看不到这一层");
    expect(src, "⛔ 有设备那一支不许动 ✗").toContain("NEARBY_GROUPS[nearbyBucket(p)].testid");
  });
});
