// U11/T5（2026-10-02）· **「逐台解除」** 的判据 —— owner 拍「乙」（屏幕只给**短码 ＋ 时间**）✓
//
// ⚠️ 为什么是**文本级结构判据**（同 `syncPanelDevicePair.wiring.test.ts` 的理由）：
//   这一片最要紧的一条是**结构**（"可见处不许出现裸设备号" ✗）—— 而它是
//   `INV-UI-copy-no-internal-ids` 在**这一屏**上的落点 ✓（既有判据 `syncPanelMesh.wiring.test.ts` ③
//   扫的是同一屏 ✓，本条是**那一条的具体化**：它挡的是"这一块自己带进来的裸 id" ✓）。
// ⛔ 它**不验**"跑起来长什么样" ✗ —— 那是人手/组件测的活 ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, `找不到起始标记：${start}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  expect(j, `找不到结束标记：${end}`).toBeGreaterThan(i);
  return text.slice(i, j);
}

/** 「逐台解除」那一条的**新落点**（⛔ 找不到就抛 ⇒ 不许"没找到当通过" ✗）。
 *
 * ⭐⭐ **2026-10-14（owner 拍删「附近设备」那一行）** ✗：原来这一块是**折叠里的一列**（`data-testid="device-unpair"` ✓，
 *    「设备 短码 · 配于 时间 ／ 解除」✓）—— ⭐ 那一列**已删** ✓（它是**重复**的：主视图每张已信任卡上的
 *    「撤销配对」`nearby-unpair` 就是同一件事 ✓，走的仍是**同一条** `duUnpair` ✓）。
 *    ⭐ 按本仓 R192「**换对象不删断言**」✗：⛔ 三条断言一条没删 ✓，只把**对象**换成**主视图那一支** ✓
 *    （口径一字不变：⭐ 逐台、点名那一台、可见处不许出现裸设备号 ✓）。 */
// ⭐ 2026-10-26（owner：「界面不美观，优化一下」）→ 行结构从"平铺三元表达式"改成
//    「头像／主信息／动作」三段 ✓ ⇒ 判据**换对象不删断言**（R192）：
//    起点放到这一行自己的 `const paired = duList.some(...)`，终点仍是「接入」那一支之前 ✓。
//    断言（已配对是人话 / 不许裸 id / 不许 secret·sha256）一条没删 ✓。
const block = () => between(SRC, "const paired = duList.some(", ") : p.serves_current ? (");

describe("U11/T5 · 逐台解除", () => {
  it("① 只在**真认了设备**时才出现（不假装有设备）", () => {
    expect(SRC).toContain('data-testid="nearby-unpair"');
    // 守卫是"本机认过的那一台" ⇒ 没认过的那几支**不显示**这一颗 ✓
    const guard = SRC.slice(
      SRC.indexOf("duList.some((d) => d.deviceId === p.device_id)"),
      SRC.indexOf('data-testid="nearby-unpair"'),
    );
    expect(guard).toContain("duList.some((d) => d.deviceId === p.device_id)");
    // 顺序：它挂在「已配对」那一句**之后**（同一支里的同一行 ✓）
    expect(SRC.indexOf('data-testid="nearby-paired"')).toBeLessThan(SRC.indexOf('data-testid="nearby-unpair"'));
  });

  it("② ⭐ 可见处**不许出现裸设备号** ✗（只说人话「已配对」）", () => {
    const b = block();
    // 正：这一支里出现的是**人话**（「已配对」✓）—— ⛔ 不是设备号、⛔ 不是短码（短码那一列已删 ✓）
    expect(b).toContain("已配对");
    expect(b, "这一支必须**真有**那只动作（否则下面几条是空集 ⇒ 判据自己失效 ✓）").toContain(
      'data-testid="nearby-unpair"',
    );
    // ★ 变异注入点：把可见处换成裸设备号（`>{p.device_id}`）⇒ 必须红 ✓
    // ⚠️ `key={p.device_id}` 与 `duUnpair(p.device_id)` **不算**违规 —— 它们不进可见槽位 ✓
    //   ⇒ 所以这条只禁"**当作子节点渲染**"那一种形状（`>{p.device_id}` ✗）✓
    expect(b).not.toContain(">{p.device_id}");
    expect(b).not.toContain("{p.device_id}<");
    // ⛔ 也不许把哈希搬上来（读数里根本没有它 —— 见 Rust `MeshPairedDevice` ✓）
    // ⭐ 2026-10-26：先剥掉 `data-testid="…"` 属性再看 —— 「不要 secret」这条管的是**可见槽位** ✓，
    //   而 `data-testid="nearby-no-secret"` 是给判据用的夹具名、不会显示给用户 ✓（旧块不包含那一支，
    //   结构改了之后它落进同一段里 ⇒ 按本意收窄到"可见内容" ✓，⛔ 断言本身没删 ✗）。
    const visible = b
      .replace(/data-testid="[^"]*"/g, "")
      .replace(/"no_secret"|"space_deleted"/g, "");
    expect(visible).not.toContain("secret");
    expect(visible).not.toContain("sha256");
  });

  it("③ 解除**必须点名那一台**，且如实回读数（不含判定语）", () => {
    const fn = between(SRC, "const duUnpair = async", "\n  };");
    // 点的是**这一台**（⛔ 不是"全解除" ✗ —— 那正是 U11 要消灭的旧办法 ✓）
    expect(fn).toContain("api.deviceUnpair(activeId, deviceId)");
    // 如实说三件：本来在不在名单里 ✓、还认几台 ✓、后端那句人话 ✓
    expect(fn).toContain("wasPaired");
    expect(fn).toContain("pairedCount");
    expect(fn).toContain("r.note");
    // ⛔ 判定语（`U13` 同族口径：不许声称系统"确认/验证"过什么 ✗）
    for (const bad of ["已确认", "已验证", "已认证", "系统已识别", "自动通过"]) {
      expect(block()).not.toContain(bad);
      expect(fn).not.toContain(bad);
    }
    // ⛔ 失败也必须**说出来**（不许静默）✓
    expect(fn).toContain("catch");
    expect(fn).toContain("没解除成");
  });
});

// ⭐ **片 D1b（2026-10-14，owner：「缺撤销配对的按钮」）** ✗：⭐「已信任」那张卡片上多一颗「撤销配对」✓
//   ⭐ 它**复用**既有那个 handler（`duUnpair` ✓）⇒ ⭐ 二次确认（`confirmDialog` ✓）与 `api.deviceUnpair`
//   **都不新增** ✓（⭐ `api.deviceUnpair` 全仓**恰好一处** ✓）。
// ⚠️ ① ② ③ 都是**源码级** ✓（⭐ 明标 ✗ —— ⭐ DOM 级**测不到** ✗：⭐ 那一行要 `duList` 里有那一台 ✓
//   而夹具里 `duList` 是空的 ✓）。
describe("片 D1b：已信任的卡片上有「撤销配对」", () => {
  const src = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
  const trustedBranch = () => {
    // ⭐ 2026-10-26 换对象（同 `block()` 那条注释）：这一段现在从 `const paired = …` 开始 ✓。
    const at = src.indexOf("const paired = duList.some(");
    if (at < 0) throw new Error("找不到「已信任」那一支");
    return src.slice(at, src.indexOf(") : p.serves_current ? (", at));
  };

  it("① ⭐（源码级）「已信任」那一支里有「撤销配对」（今天【红】✓）", () => {
    const b = trustedBranch();
    expect(b, "⭐ 那颗按钮要在「已信任」的卡片上 ✓").toContain("撤销配对");
    expect(b, "⭐ 而且只在这一支（⭐ 未配对的不显示 ✓）").toContain("nearby-unpair");
  });

  it("② ⭐（源码级）点它**先二次确认** ✓（⭐ 走既有 `duUnpair` ⇒ `confirmDialog` ✓）", () => {
    const b = trustedBranch();
    expect(b, "⭐ 必须复用既有那个 handler ✓（⛔ 不造第二套 ✗）").toContain("duUnpair(p.device_id)");
    const at = src.indexOf("const duUnpair = async (deviceId: string) => {");
    expect(at, "夹具前提：那个 handler 要在 ✓").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n  };", at));
    expect(body, "⭐ 确认件要用仓内既有那个 ✓（`confirmDialog` ✓，⛔ 别新发明 ✗）").toContain("confirmDialog(");
    expect(body, "⭐ 文案要说清「重新配对」✓（⭐ owner 的承诺口径 ✓）").toContain("重新配对");
  });

  it("③ 锁（今天已绿 ✓）：`api.deviceUnpair` 全仓**恰好一处** ＋ 参数名逐字未变", () => {
    expect(src.split("api.deviceUnpair(").length - 1, "⛔ 不许写第二套 invoke ✗").toBe(1);
    expect(src, "⭐ 参数逐字 ✓").toContain("api.deviceUnpair(activeId, deviceId)");
  });
});
