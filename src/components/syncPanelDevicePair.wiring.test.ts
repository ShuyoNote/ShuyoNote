// T4（2026-10-01）· **「把这台设备接进来」** 的判据 —— owner 拍「乙」（两个入口两个名字）✓
//
// ⚠️ 为什么用**文本级结构判据**（而不是渲染整块 `SyncPanel`）：
//   ① 这一片要挡的三条里有两条**是结构**（"停态里不许有继续入口"、"采纳必须带核对过的码"）；
//   ② 同仓先例：`SpacePrivacySection.test.ts` 的第 ⑧ 条就是文本级判据（"防它变成没人用的孤儿组件"✓）；
//   ③ 渲染整块 SyncPanel 要先铺一堆 store/轮询桩 ⇒ 判据本身反而更难信任 ✓。
// ⛔ 但它**不验**"跑起来长什么样"✗ —— 那是人手/组件测的活 ✓；这一条只钉**文字与结构** ✓。
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

describe("T4 · 把这台设备接进来", () => {
  it("① 这一块真的挂在「附近设备」里（不是没人用的孤儿）", () => {
    expect(SRC).toContain('data-testid="device-pair"');
    // 顺序：先「附近设备」那一行，再这一块 ⇒ 它在这一块**内部**
    expect(SRC.indexOf("附近设备")).toBeLessThan(SRC.indexOf('data-testid="device-pair"'));
  });

  it("② ⭐「停」态里**没有**继续的入口（U3：两端不一致 ⇒ 停，且不许给「继续」）", () => {
    // 停态那一支 = `dpOutcome === "stopped" ? (` 到 `) : (`
    // ⚠️ 锚点要**从停态那一支开始切**（否则 `) : (` 会先命中文件里前面的三元表达式 —— 实测踩到 ✓）
    const from = SRC.slice(SRC.indexOf('dpOutcome === "stopped" ? ('));
    const stopped = between(from, 'dpOutcome === "stopped" ? (', ") : (");
    // ★ 这一条就是变异注入点：往停态里加**任何**"继续"⇒ 必须红 ✓
    // ⚠️ **不许只禁那两颗具体按钮** ✗ —— 实测过：加一个别名的「继续」按钮，只禁具体文案的写法**照样绿** ✓
    //    （第一版就是这么写的，变异没抓住 ⇒ 断言改成"停态里不许出现任何 `<button`" ✓）
    expect(stopped).not.toContain("<button");
    expect(stopped).toContain("dp-stopped");
    // 反过来：**非停态**那一支里必须有这两个动作（否则"停"就没有对立面，判据自己失效 ✓）
    const normal = between(from, ") : (", '{dpOutcome === "ok" &&');
    expect(normal).toContain("先看比对码");
    expect(normal).toContain("我核对过了，采纳");
  });

  it("③ 采纳**必须**带上人核对过的那一串（U2：不许自动通过）", () => {
    const accept = between(SRC, "const dpAccept = async () => {", "\n  };");
    expect(accept).toContain("confirmed_check_code");
    // ⭐ 而"先看比对码"那一步**故意不带**码 —— 后端因此只回读数、**零写入** ✓（这条也是结构事实 ✓）
    const preview = between(SRC, "const dpPreviewImport = async () => {", "\n  };");
    expect(preview).not.toContain("confirmed_check_code");
    // ⛔ 预览那一步不许把结果当成功（不传码只可能是 need_confirm ✓）
    expect(preview).not.toContain("已配对");
  });

  it("④ 文案红线：成功只说「已配对」；不出现判定语、也不出现「自动通过」式的话", () => {
    const block = between(SRC, 'data-testid="device-pair"', "</details>");
    // 判定语（`U13`：⛔ 不许声称"系统能识别是不是你的设备" ✗）
    for (const bad of ["已确认是您的设备", "已认证", "系统已识别", "自动通过"]) {
      expect(block).not.toContain(bad);
    }
    expect(block).toContain("已配对");
    // ⚠️ 这一块的载荷**含窗口口令** ⇒ 必须**明说**不能外传（与「换设备」那句"它不是秘密"相反 ✓）
    expect(block).toContain("含窗口口令");
    expect(block).toContain("别外传");
  });
});
