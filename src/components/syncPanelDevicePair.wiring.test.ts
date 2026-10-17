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
//    配对路**上 ✓（「接入」⇒ 对码屏 ⇒ 「码对得上，确认」⇒ `mesh_trust_begin` ✓ —— 它的判据在
//    `SyncPanel.trustDevicePanel.wiring.test.tsx` 的修 B／P-4 ②a②b③ 里已经**真挂真点**过 ✓，
//    这里钉的是**文字与结构**那一半 ✓）。⭐ 三条口径一字不变：
//      ① 这一块**真的挂在**那一行里（不是没人用的孤儿 ✓）；
//      ② **停**态里没有继续的入口（码不一样 ⇒ 只说一句、⛔ 不给「继续」✓）；
//      ③ **采纳/确认**必须带上人核对过的那一台（⛔ 不许自动通过 ✓）。
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
/** 对码那一屏（`pair-code-screen` ✓）。 */
const pairScreen = () => between(SRC, 'data-testid="pair-code-screen"', 'data-testid="pair-code-notes"');

describe("T4 · 把这台设备接进来", () => {
  it("① 这一块真的挂在「附近设备」那一行里（不是没人用的孤儿）", () => {
    expect(SRC).toContain('data-testid="nearby-allow"');
    // 顺序：先「附近的设备」那一行，再这一块 ⇒ 它在这一块**内部**
    expect(SRC.indexOf("附近")).toBeLessThan(SRC.indexOf('data-testid="nearby-allow"'));
    // ⭐ **2026-10-14 修的真缺陷**（真机实测）：⭐ 对码屏原来住在**默认收起**的「高级」折叠里 ✗
    //    ⇒ ⭐ 主视图那一行点「接入」**什么都看不见** ✓。⇒ 它必须排在那个折叠**之前** ✓。
    const pairAt = SRC.indexOf('data-testid="pair-code-screen"');
    const foldAt = SRC.indexOf("<SyncAdvancedFold>");
    expect(pairAt, "夹具前提：对码屏要在").toBeGreaterThan(-1);
    expect(foldAt, "夹具前提：那个「高级」折叠要在").toBeGreaterThan(-1);
    expect(
      pairAt,
      "⛔ 对码屏又跑进那个**默认收起**的折叠里了 ✗ ⇒ 点「接入」用户看不见（2026-10-14 实测过 ✓）",
    ).toBeLessThan(foldAt);
  });

  it("② ⭐「停」态里没有继续的入口（U3：两端不一致 ⇒ 停，且不许给「继续」）", () => {
    // ⭐ 停态那一支 ＝ ⭐ 码不一样时**只说一句**（`pair-code-mismatch` ✓）——
    //    ⚠️ **不许只禁那两颗具体按钮** ✗：⭐ 那条路是"不许出现**任何**继续入口" ✓
    //    （实测过：加一个别名的「继续」按钮，只禁具体文案的写法**照样绿** ✓）。
    const screen = pairScreen();
    expect(screen).toContain('data-testid="pair-code-mismatch"');
    expect(screen, "⛔ 停态里不许有「继续」一类入口 ✗").not.toContain("继续");
    expect(screen, "⛔ 也不许有「自动通过」✗").not.toContain("自动通过");
    // 反过来：**非停态**那一支里必须有这两个动作（否则"停"就没有对立面，判据自己失效 ✓）
    expect(screen).toContain("码对得上，确认");
    expect(screen).toContain('data-testid="pair-cancel"');
  });

  it("③ 采纳必须带上人核对过的那一串（U2：不许自动通过）", () => {
    // ⭐ 「确认」那一下**才**把那一台交给后端 ✓ —— 逐字：`setDpPeer` ＋ `trustDevice` ✓
    //    （⭐ 命令名/参数/返回值处理**一字未改** ✓，只挪了**时点** ✓：见 P-4 片②b ✓）。
    const confirm = between(SRC, 'data-testid="pair-confirm"', 'data-testid="pair-cancel"');
    expect(confirm).toContain("void trustDevice([activeId], peer)");
    expect(confirm).toContain("setDpPeer(peer.device_id)");
    // ⛔ 而「接入」那一下**只开一轮比对 ＋ 取读数** ⇒ **零信任登记**（`syncPanelDevicePair` 的旧断言
    //    "预览不许写"同一条口径 ✓：⭐ 人没确认之前，一个字节的**登记**都不做 ✓；
    //    ⚠️ 2026-10-17 起它会调 `mesh_trust_prepare`（只开一轮、⛔ 不写库 ✓）。
    const allow = allowRow();
    expect(allow, "⛔ 「接入」那一下不许直接调 `trustDevice` ✗（人还没确认 ✓）").not.toContain(
      "void trustDevice(",
    );
    expect(allow, "⭐ 它要开的正是那一屏 ✓").toContain("setPairScreen(true)");
    // ⭐ 而取读数那一下走的是**这一台**（⛔ 不传 space_id ✗ —— 空间不参与派生 ✓）
    // ⭐⭐ **2026-10-17**：⭐ 取码前**先开一轮比对**（`mesh_trust_prepare` ✓，
    //   ⛔ 不登记信任 ✗）—— 否则码的料（`trust_ask`）根本还没生成（owner 真机症状 ✓）。
    expect(allow).toContain("void preparePairCode(p)");
    const prep = between(SRC, "const preparePairCode = async", "\n  };");
    expect(prep, "⭐ 先开一轮比对 ✓（命令名逐字 ✓）").toContain("MESH_TRUST_PREPARE_COMMAND");
    expect(prep, "⭐ 开完再取码 ✓").toContain("await fetchPairCode(peer)");
    // ⛔ 而「开一轮」**不是**登记：它一个字节都不写库 ✓（`mesh_trust_begin` 只在确认那颗上 ✓）
    expect(prep).not.toContain("MESH_TRUST_BEGIN_COMMAND");
  });

  it("④ 文案红线：只显示、不下结论；载荷含窗口口令 ⇒ 必须明说不能外传", () => {
    const screen = pairScreen();
    // 判定语（`U13`：⛔ 不许声称"系统能识别是不是你的设备" ✗）
    for (const bad of ["已确认是您的设备", "已认证", "系统已识别", "自动通过"]) {
      expect(screen).not.toContain(bad);
    }
    // ⚠️ 这一屏的载荷**含窗口口令** ⇒ 必须**明说**不能外传（与「换设备」那句"它不是秘密"相反 ✓）
    const notes = between(SRC, 'data-testid="pair-code-notes"', "</div>");
    expect(notes).toContain("含窗口口令");
    expect(notes).toContain("只发你自己那台");
    // ⭐ 而且必须说清它**不是一次性的**（`pairing.rs` 的载荷里没有 nonce／有效期 ✓）
    expect(notes).toContain("不是一次性的");
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
    // ⭐⭐ **2026-10-17**：⭐ 接线点从 `fetchPairCode` 换成 `preparePairCode` ✓（它先开一轮、再取码 ✓）
    expect(allow).toContain("void preparePairCode(p)");
    // ③ ⭐ 那两格**真的传给了后端**（`mesh_trust_begin` 的实参 ✓ —— 命令名/参数逐字 ✓）
    const fn = between(SRC, "const trustDevice = async", "\n  };");
    expect(fn).toContain("peerDeviceId: peer.device_id");
    expect(fn).toContain("peerPubkey: peer.pubkey");
    // ④ ⛔ 对面**没报公钥** ⇒ 如实说、⛔ 不硬凑一个身份 ✗（老版本对端就是这一档 ✓）
    expect(fn).toContain("if (!peer.pubkey)");
  });
});
