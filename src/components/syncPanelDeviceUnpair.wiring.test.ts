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

/** 「逐台解除」那一块（⛔ 找不到就抛 ⇒ 不许"没找到当通过" ✗）。 */
const block = () => between(SRC, 'data-testid="device-unpair"', 'data-testid="device-pair"');

describe("U11/T5 · 逐台解除", () => {
  it("① 只在**真认了设备**时才出现（不假装有设备）", () => {
    expect(SRC).toContain('data-testid="device-unpair"');
    // 守卫是"列表非空" ⇒ 一台都没认时不渲染这一块 ✓
    const guard = SRC.slice(SRC.indexOf("duList.length > 0"), SRC.indexOf('data-testid="device-unpair"'));
    expect(guard).toContain("duList.length > 0");
    // 顺序：它挂在「把这台设备接进来」那块**之前**（同一屏的同一段 ✓）
    expect(SRC.indexOf('data-testid="device-unpair"')).toBeLessThan(SRC.indexOf('data-testid="device-pair"'));
  });

  it("② ⭐ 可见处**不许出现裸设备号** ✗（只给短码 ＋ 时间）", () => {
    const b = block();
    // 正：屏幕上出现的是**派生短码** ✓
    expect(b).toContain("duCode(d.deviceId)");
    expect(b).toContain("duWhen(d.addedAtMs)");
    // ★ 变异注入点：把短码换成裸设备号（`{d.deviceId}`）⇒ 必须红 ✓
    // ⚠️ `key={d.deviceId}` 与 `duUnpair(d.deviceId)` **不算**违规 —— 它们不进可见槽位 ✓
    //   ⇒ 所以这条只禁"**当作子节点渲染**"那一种形状（`>{d.deviceId}` ✗）✓
    expect(b).not.toContain(">{d.deviceId}");
    expect(b).not.toContain("{d.deviceId}<");
    // ⛔ 也不许把哈希搬上来（读数里根本没有它 —— 见 Rust `MeshPairedDevice` ✓）
    expect(b).not.toContain("secret");
    expect(b).not.toContain("sha256");
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
