// 准绳：**"窗口至少得存在一条标题栏"** —— 这是本仓此前**没有任何地方断言**的一条不变量 ✗。
//
// 来由（2026-10-10，owner 报的现象）：标题栏整条没有（既无系统栏、也无自绘栏）。
// 机制（AMD 侧只读调查，几何＋像素双证 ✓）：
//   ① Rust 侧窗口以 `decorations(false)` 创建 ⇒ 系统栏**不存在**（`src-tauri/src/lib.rs:610`）
//   ② 自绘栏只在 `custom` 为真时渲染（`src/components/TitleBar.tsx:116`：`if (!desktop || !custom) return null`）
//   ③ 找回系统栏唯一的出路是前端运行时调 `setDecorations(!custom)`（`src/store/windowChrome.ts`）
//   ④ 而 `custom` 出厂默认曾是 **false** ✗
//   ⇒ ④＋① ⇒ **两个互相独立的开关同时为假** ⇒ "一条标题栏都没有"**是可达状态** ✗
//
// 实测读数（判据该钉的就是这些）：`NC top = 2` 物理像素（同 DPI 下真标题栏 ≥46）／
// 右上角整片空白 ✓。⚠️ 窗口样式位 `WS_CAPTION` **是置位的** ⇒ **拿样式位判会得到假答案** ✗。
//
// ⚠️ 这条判据**故意不复刻 Rust 侧那个常量**：若哪天有人把 `lib.rs:610` 改成 `decorations(true)`，
//    那"系统栏存在"⇒ 默认自绘栏就**可以**关（本测试会失败 ⇒ 逼人回来一起改，而不是静默错配 ✓）。
import { describe, expect, it } from "vitest";
import { defaultFor } from "./windowChrome";

// 与 `src-tauri/src/lib.rs:610` 同源的事实：窗口是**无边框**创建的 ⇒ 系统栏不存在。
const RUST_CREATES_WINDOW_WITHOUT_DECORATIONS = true;

describe("窗口外观：至少得存在一条标题栏", () => {
  it("出厂默认：自绘标题栏必须开（因为系统栏由 Rust 侧关掉了）", () => {
    const customTitleBar = defaultFor("shuyonote:customTitleBar");
    // 不变量的形式：**不允许**出现 "系统栏 ✗ ＋ 自绘栏 ✗"
    expect(
      RUST_CREATES_WINDOW_WITHOUT_DECORATIONS && customTitleBar,
      "无边框窗口 + 自绘栏关闭 ⇒ 一条标题栏都没有（owner 2026-10-10 报的就是这个）",
    ).toBe(true);
  });

  it("Mica 仍默认关（与标题栏那条无关：换壁纸／低配机器可能发花）", () => {
    expect(defaultFor("shuyonote:material")).toBe(false);
  });

  it("两个键的默认值**不一样**（曾经共用一个 defaultFor() ⇒ 改一个会连坐另一个）", () => {
    expect(defaultFor("shuyonote:customTitleBar")).not.toBe(defaultFor("shuyonote:material"));
  });
});
