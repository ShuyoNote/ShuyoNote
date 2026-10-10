// `aboutFacts`：关于屏那几件"不许写字面量"的机器事实。
//
// 为什么值得单独钉：效果图上就**真的过期过一次** —— 图上写 `版本 1.92.5`，而当天
// `package.json` 已是 `1.92.6` ✗（规格 §4.10 的订正行逐字记着这件事）。
// ⇒ 判据不能靠"写的时候是对的" ✓，得让机器每次去对**真文件** ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { ABOUT_COMPONENTS, ABOUT_DEPS_TOTAL, ABOUT_LICENSE_LINES } from "./aboutFacts";

const ROOT = resolve(__dirname, "..", "..");

describe("aboutFacts（关于屏的数据）", () => {
  it("① 12 项组件的名字与版本都能在 package.json 里对上（不写字面量 ✓）", () => {
    expect(ABOUT_COMPONENTS).toHaveLength(12);
    const deps = (pkg as { dependencies: Record<string, string> }).dependencies;
    for (const c of ABOUT_COMPONENTS) {
      expect(deps[c.key], `${c.label} ⇒ ${c.key} 必须真的在 dependencies 里`).toBeTruthy();
      // 图上显示的 major.minor 必须＝"从真区间里取出的 major.minor" ✓
      const m = String(deps[c.key]).match(/(\d+)(?:\.(\d+))?/);
      const expectV = m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : "—";
      expect(c.version).toBe(expectV);
    }
  });

  it("② `共 N 项 dependencies` 的 N 就是 package.json 的项数", () => {
    const deps = (pkg as { dependencies: Record<string, unknown> }).dependencies;
    expect(ABOUT_DEPS_TOTAL).toBe(Object.keys(deps).length);
  });

  it("③ ★ `LICENSE（N 行）` 的 N 对着仓根真文件数（过期就红 ✓）", () => {
    const text = readFileSync(resolve(ROOT, "LICENSE"), "utf8");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
    expect(ABOUT_LICENSE_LINES).toBe(lines);
    // 顺带钉住许可本身（图上大字写的就是它 ✓）
    expect(text).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
  });
});
