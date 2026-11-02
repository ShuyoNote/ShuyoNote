// T4（2026-10-01）· **「把这台设备接进来」** 的判据 —— owner 拍「乙」（两个入口两个名字）✓
//
// ⚠️ 为什么用**文本级结构判据**（而不是渲染整块 `SyncPanel`）：
//   ① 这一片要挡的三条里有两条**是结构**（"停态里不许有继续入口"、"采纳必须带核对过的码"）；
//   ② 同仓先例：`SpacePrivacySection.test.ts` 的第 ⑧ 条就是文本级判据（"防它变成没人用的孤儿组件"✓）；
//   ③ 渲染整块 SyncPanel 要先铺一堆 store/轮询桩 ⇒ 判据本身反而更难信任 ✓。
// ⛔ 但它**不验**"跑起来长什么样"✗ —— 那是人手/组件测的活 ✓；这一条只钉**文字与结构** ✓。
//
// ⭐⭐ **2026-10-14（owner 拍删「附近设备」那一行，连内容）** ✗ —— ⭐ 这一整份原来钉的是
//    **「严格模式（高级）」那条投放码路**（`device-pair` ／ `device-pair-advanced` ／
//    「生成投放码」／「先看比对码」／「我核对过了，采纳」✓）—— ⭐ 那些**已经整块删掉** ✓。
//    ⭐ 按本仓 R192「**换对象不删断言**」✗：⛔ **五条断言一条都没删** ✓，全部换到**现在承重的那条
//    配对路**上 ✓（「接入」⇒ **确认身份**那一屏 ⇒ 「就是这台，确认」⇒ `mesh_trust_begin` ✓ —— 它的判据在
//    `SyncPanel.trustDevicePanel.wiring.test.tsx` 的修 B／R176-A 那几组里已经**真挂真点**过 ✓，
//    这里钉的是**文字与结构**那一半 ✓）。⭐ 三条口径一字不变：
//      ① 这一块**真的挂在**那一行里（不是没人用的孤儿 ✓）；
//      ② **停**态里没有继续的入口（对不上 ⇒ 只说一句、⛔ 不给「继续」✓）；
//      ③ **采纳/确认**必须带上人核对过的那一台（⛔ 不许自动通过 ✓）。
// ⭐⭐ **R176-A（2026-10-29）**：⭐ 那一屏**不再显示任何要人逐位比对的长串** ✗ —— 只显示
//    **设备名 ＋ 短标识** ✓（唯一实现 `../lib/peerIdentity.ts` ✓）。这条口径在本文件里有
//    机器判据：那一屏（**剥注释后**）**一个「码」字都不许有** ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");

/** 取两个标记之间的那一段（找不到 ⇒ 抛 —— ⛔ 不许"没找到就当通过" ✗）。 */
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, `找不到起始标记：${start}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  expect(j, `找不到结束标记：${end}`).toBeGreaterThan(i);
  return text.slice(i, j);
}

/** 从一条**整行锚**（`trim()` 逐字）切到下一个标记 —— ⛔ 不用 `indexOf(<testid 字面>)` ✗：
 *  实测（2026-10-14）：`data-testid="nearby-allow"` 这个字面**在注释里也出现过一次**
 *  （`trustDevice` 里那句"主路径（`data-testid=\"nearby-allow\"` ✓）**点名**那一台"✓）
 *  ⇒ `indexOf` 从那句注释开始切，切出来的是一大段**别的代码**（`trustDevice` 本体 ✓）——
 *  于是 `not.toContain("void trustDevice(")` 必然假红（实测踩到 ✓）。 */
function fromWholeLine(lineText: string, endText: string): string {
  const lines = SRC.split("\n");
  const i = lines.findIndex((l) => l.trim() === lineText);
  expect(i, `找不到整行锚：${lineText}`).toBeGreaterThanOrEqual(0);
  const at = lines.slice(0, i).join("\n").length;
  return between(SRC, SRC.slice(at, at + lines[i].length), endText);
}

/** 「接入」那一颗**按钮本身**（整行锚 `data-testid="nearby-allow"` ⇒ 到它自己的 `</button>` ✓）。
 *  ⚠️ **再去掉注释** ✗（`//` 行注释与 JSX 注释**两种** ✓）——按钮 `onClick` 里那段注释**正是在讲**
 *     「原来那两步搬走了」✓ ⇒ ⛔ 不剥的话，下面那条 not.toContain 会被**解释它自己的注释**喂饱 ✓。 */
const allowRow = () =>
  fromWholeLine('data-testid="nearby-allow"', "</button>")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
/** **确认身份**那一屏（`pair-identity-screen` ✓）。
 *  ⚠️ **R176-A（2026-10-29）**：⭐ 旧的「逐位比对那一屏」已撤 ✗ ⇒ 切到它的**新下界**（「高级」折叠 ✓）——
 *     ⛔ 不再拿 `pair-code-notes` 当界 ✗（那一段已随那一串一起删 ✓）。 */
const pairScreen = () => between(SRC, 'data-testid="pair-identity-screen"', "<SyncAdvancedFold>");

describe("T4 · 把这台设备接进来", () => {
  it("① 这一块真的挂在「附近设备」那一行里（不是没人用的孤儿）", () => {
    expect(SRC).toContain('data-testid="nearby-allow"');
    // 顺序：先「附近的设备」那一行，再这一块 ⇒ 它在这一块**内部**
    expect(SRC.indexOf("附近")).toBeLessThan(SRC.indexOf('data-testid="nearby-allow"'));
    // ⭐ **2026-10-14 修的真缺陷**（真机实测）：⭐ 对码屏原来住在**默认收起**的「高级」折叠里 ✗
    //    ⇒ ⭐ 主视图那一行点「接入」**什么都看不见** ✓。⇒ 它必须排在那个折叠**之前** ✓。
    const pairAt = SRC.indexOf('data-testid="pair-identity-screen"');
    const foldAt = SRC.indexOf("<SyncAdvancedFold>");
    expect(pairAt, "夹具前提：那一屏要在").toBeGreaterThan(-1);
    expect(foldAt, "夹具前提：那个「高级」折叠要在").toBeGreaterThan(-1);
    expect(
      pairAt,
      "⛔ 那一屏又跑进那个**默认收起**的折叠里了 ✗ ⇒ 点「接入」用户看不见（2026-10-14 实测过 ✓）",
    ).toBeLessThan(foldAt);
  });

  it("② ⭐「停」态里没有继续的入口（U3：对不上 ⇒ 停，且不许给「继续」）", () => {
    // ⭐ 停态那一支 ＝ ⭐ 对不上时**只说一句**（`对不上就点「取消」` ✓）——
    //    ⚠️ **不许只禁那两颗具体按钮** ✗：⭐ 那条路是"不许出现**任何**继续入口" ✓
    //    （实测过：加一个别名的「继续」按钮，只禁具体文案的写法**照样绿** ✓）。
    // ⚠️ **R176-A**：旧的「两边那串不一样 ⇒ 先别确认」那句已随那一串一起撤 ✗ ⇒ 换成现在承重的这句 ✓
    //    （⭐ 按 R192「换对象不删断言」：⛔ 不是把这条删掉 ✓）。
    const screen = pairScreen();
    expect(screen, "⭐ 停态要说话：对不上 ⇒ 只点「取消」✓").toContain("对不上就点「取消」");
    expect(screen, "⛔ 停态里不许有「继续」一类入口 ✗").not.toContain("继续");
    expect(screen, "⛔ 也不许有「自动通过」✗").not.toContain("自动通过");
    // 反过来：**非停态**那一支里必须有这两个动作（否则"停"就没有对立面，判据自己失效 ✓）
    expect(screen).toContain("就是这台，确认");
    expect(screen).toContain('data-testid="pair-cancel"');
  });

  it("③ 采纳必须带上人核对过的**那一台**（U2：不许自动通过）", () => {
    // ⭐ 「确认」那一下**才**把那一台交给后端 ✓ —— 逐字：`setDpPeer` ＋ `trustDevice` ✓
    //    （⭐ 命令名/参数/返回值处理**一字未改** ✓，只挪了**时点** ✓：见 P-4 片②b ✓）。
    const confirm = between(SRC, 'data-testid="pair-confirm"', 'data-testid="pair-cancel"');
    expect(confirm).toContain("void trustDevice([activeId], peer)");
    expect(confirm).toContain("setDpPeer(peer.device_id)");
    // ⛔ 而「接入」那一下**只记下那一台 ＋ 开屏** ⇒ **零命令**（⭐ R176-A 起连「先开一轮」也撤了 ✓；
    //    旧断言"预览不许写"同一条口径 ✓：人没确认之前，一个字节都不发 ✓）。
    const allow = allowRow();
    expect(allow, "⛔ 「接入」那一下不许直接调 `trustDevice` ✗（人还没确认 ✓）").not.toContain(
      "void trustDevice(",
    );
    expect(allow, "⭐ 它要开的正是那一屏 ✓").toContain("setPairScreen(true)");
    expect(allow, "⭐ 它记下的正是**那一台** ✓").toContain("setPairPeer(p)");
    // ⭐ **R176-A（2026-10-29）**：⛔ 「接入」那一下**不再调任何命令** ✗ ——
    //   旧的「先开一轮」（`mesh_trust_prepare`）与「读那一串」两条路**整条撤掉** ✓。
    expect(allow, "⛔ 那一行不许再先调任何命令 ✗（`void prepare…(p)` 那一步已撤 ✓）").not.toMatch(
      /void prepare[A-Za-z]*\(p\)/,
    );
  });

  it("④ 文案红线：只显示、不下结论；两句说明都在", () => {
    const screen = pairScreen();
    // 判定语（`U13`：⛔ 不许声称"系统能识别是不是你的设备" ✗）
    for (const bad of ["已确认是您的设备", "已认证", "系统已识别", "自动通过"]) {
      expect(screen).not.toContain(bad);
    }
    // ⭐ **两边各点一次**那句必须在（⭐ 信任靠的是这个动作 ✓）
    expect(screen).toContain("两台设备上各点一次「接入」，再各点一次「确认」就会通。");
    // ⚠️ 并且**兜底那句**必须在：对不上就取消（⭐ 同一个网段里可能有别的设备 ✓）
    expect(screen).toContain("对不上就点「取消」");
    // ⛔ **R176-A**：屏上**零「码」字** ✗（旧的「比对码」那几句已全撤 ✓）——
    //    ⚠️ ⭐ 必须**剥注释**再判 ✗（本文件与组件里都有"解释这次撤掉了什么"的注释 ✓）。
    const screenCode = screen.replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(screenCode, "⛔ 那一屏上不许再出现「码」字 ✗").not.toContain("码");
    // ⛔ 而旧那几句（含窗口口令／不是一次性的）**已随那一串一起撤** ✗ —— 换对象：现在一句都不许回来 ✓。
    expect(screenCode).not.toContain("含窗口口令");
    expect(screenCode).not.toContain("不是一次性的");
  });

  // ⭐ R110（owner 2026-10-02 拍 A · macOS 侧落地）：**确认前先认下「这一台」**。
  //   ⭐ **2026-10-14**：那条「这段码给哪一台」的下拉（`dp-peer` ✓）随投放码那一块**一起删掉** ✓ ⇒
  //     ⭐ 按 R192 换对象：现在承重的是 ⭐ **「接入」那一颗自己记下是哪一台** ✓（`setPairPeer(p)` ✓），
  //     而**确认**时把它的**设备号 ＋ 公钥**一起交给后端 ✓ —— ⭐ 少了这一步，"登记"根本不会发生 ✓。
  //   **变异**：把确认那一下的 `peerPubkey` 去掉 ⇒ ③／P-4 片③ 必须红 ✓。
  it("⑤ R110：认下的是**那一台**，且它的设备号与公钥真的传给了后端", () => {
    const allow = allowRow();
    // ① 「接入」记下的是**当前这一台**（⛔ 不是"第一台"／不是全选 ✗）
    expect(allow).toContain("setPairPeer(p)");
    // ② 候选来自**唯一那处读数**（`nearby` ✓）—— 界面不自己造一个身份 ✓
    // ⭐ **R176-A（2026-10-29）**：⭐ 旧的那一步「先开一轮 ＋ 读那一串」**已撤** ✗
    //    ⇒ ⭐ 「接入」只**记下那一台 ＋ 开屏** ✓（⛔ 一个命令都不发 ✗）。
    expect(allow, "⛔ 「接入」不许再先调任何命令 ✗").not.toMatch(/void prepare[A-Za-z]*\(p\)/);
    // ③ ⭐ 那两格**真的传给了后端**（`mesh_trust_begin` 的实参 ✓ —— 命令名/参数逐字 ✓）
    const fn = between(SRC, "const trustDevice = async", "\n  };");
    expect(fn).toContain("peerDeviceId: peer.device_id");
    expect(fn).toContain("peerPubkey: peer.pubkey");
    // ④ ⛔ 对面**没报公钥** ⇒ 如实说、⛔ 不硬凑一个身份 ✗（老版本对端就是这一档 ✓）
    expect(fn).toContain("if (!peer.pubkey)");
  });

  // ⭐ **2026-10-19（owner 真机：「配对成功后，页面不能自动刷新」）**：
  //   配好之后那一行**还停在「待配对」** —— 成功那条路只弹了一句 toast、**没重读** `lan_status`
  //   ⇒ 要等下一轮 5 秒轮询才变，用户看到的是"配好了没反应" ✓。
  //   **变异**：删掉 `setLanNonce` 那两行 ⇒ 这一条必红（真机上也会再退回"要等一轮轮询"）✓。
  it("⑥ 配对成功/失败之后都要**立刻重读**局域网读数（⛔ 不能让那一行停在旧状态 ✗）", () => {
    const fn = between(SRC, "const trustDevice = async", "\n  };");
    // 成功 ＋ 失败各一次（失败也要让那台回到该在的那一段）
    expect((fn.match(/setLanNonce\(/g) ?? []).length, "成功＋失败两处").toBe(2);
    // 那个 nonce 必须真的进了轮询 effect 的依赖（否则自增不触发重读 ⇒ 静默无效）
    expect(SRC, "轮询 effect 的依赖里要有 lanNonce").toMatch(
      /\}, \[open, contentOnly, activeId, lanNonce\]\);/,
    );
    // ⛔ 界面不许自己改列表：列表唯一来源仍是后端那份读数
    expect(fn).not.toMatch(/setLanStatus\(/);
  });

  // ⭐ **2026-10-19（owner：「配对成功，没有同步发生？」）**：
  //   配对**只做信任、不搬数据** —— 真正搬运原本只发生在同步节拍上（可能是分钟级）⇒ 配完像"什么都没发生"。
  //   ⇒ 信任成功后**立刻跑一轮网格交换**（与「立即同步」同一条 `mesh_sync_now`），并刷新那两份清单。
  //   **变异**：删掉 `api.meshSyncNow` 那一段 ⇒ 这一条必红（真机上就要等节拍才动数据）。
  it("⑦ 配对成功后**立刻交换一轮**（⛔ 不让用户等同步节拍 ✗）", () => {
    const fn = between(SRC, "const trustDevice = async", "\n  };");
    expect(fn, "要用那条现成的网格命令").toContain("api.meshSyncNow(");
    // 交换会改数据 ⇒ 页面列表与待取回清单必须跟着刷（否则"说拉了 2 页、列表还是空"）
    expect(fn).toContain("loadPages()");
    expect(fn).toContain("loadPendingRemote()");
    // ⛔ 失败不许吞：要说出来（信任已成立，这一步只是"立刻搬一次"失败）
    expect(fn).toContain("立刻交换失败");
  });
});
