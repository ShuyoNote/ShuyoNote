// 准绳：**"窗口至少得存在一条标题栏"** —— 这是本仓此前**没有任何地方断言**的一条不变量 ✗。
//
// 来由（2026-10-10，owner 报"标题栏整条没有"）：机制链（AMD 侧只读调查，几何＋像素双证 ✓）
//   ① Rust 侧窗口曾以 `decorations(false)` 创建 ⇒ 系统栏**不存在**（当时 `src-tauri/src/lib.rs`）
//   ② 自绘栏只在 `custom` 为真时渲染（`src/components/TitleBar.tsx`：`if (!desktop || !custom) return null`）
//   ③ 当时"找回系统栏"唯一出路是前端运行时 `setDecorations(!custom)`
//   ④ 而 `custom` 出厂默认是 **false**
//   ⇒ ③＋④ ⇒ **两个互相独立的开关同时为假** ⇒ "一条标题栏都没有"**是可达状态** ✗
//
// ⭐ 2026-10-10 owner 拍 **A：默认用系统标题栏** ⇒ 修法（本条判据钉的就是它）：
//   · Rust 侧改成 `decorations(true)` ⇒ **系统栏默认就在** ✓ ⇒ 那个可达状态**结构性消失** ✓
//   · 因此自绘栏的出厂默认**必须关**（否则默认两条栏 ✗）
//   · ⚠️ 而且实测确认过一条**不许再依赖**的路：前端运行时 `setDecorations(true)`
//     （"从无到有"）在 Windows 上**不报错、也不生效** ✗（几何读数 `NC top = 7` 物理像素 ✗，
//      真标题栏 ≥46 ✓，且 console 里没有错 ✓）⇒ 要系统栏就靠 Rust 侧默认值 ✓。
//
// ⚠️ 这条判据**故意声明"Rust 侧的事实"**：哪天有人把 `lib.rs` 改回 `decorations(false)`，
//    这里必须同步改（下面那条源码扫描会把不同步**直接判红** ✓，⛔ 不是静默错配 ✗）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultFor } from "./windowChrome";

// 与 `src-tauri/src/lib.rs` 同源的事实：窗口是否**默认带系统装饰**。
const RUST_WINDOW_IS_DECORATED_BY_DEFAULT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_RS = join(HERE, "..", "..", "src-tauri", "src", "lib.rs");

describe("窗口外观：至少得存在一条标题栏", () => {
  it("系统栏默认存在 ⇒ 自绘栏出厂默认必须关（否则默认两条栏）", () => {
    const customTitleBar = defaultFor("shuyonote:customTitleBar");
    expect(
      customTitleBar,
      "系统栏默认在时，自绘栏默认必须关 —— 否则默认会同时出现两条标题栏",
    ).toBe(!RUST_WINDOW_IS_DECORATED_BY_DEFAULT);
  });

  it("⭐ 不许两条都没有：源码里必须真的写成 decorations(true)", () => {
    const src = readFileSync(LIB_RS, "utf8");
    // 只看真正参与构建的那一行（⛔ 不把注释里提到的 `decorations(false)` 当判据 ✗）
    const liveLines = src
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => /\.decorations\(/.test(l));
    expect(
      liveLines.some((l) => /\.decorations\(true\)/.test(l)),
      "Rust 侧必须以 decorations(true) 建窗（owner 2026-10-10 拍 A：默认系统标题栏）",
    ).toBe(true);
    expect(
      liveLines.some((l) => /\.decorations\(false\)/.test(l)),
      "⛔ 不许再出现生效的 decorations(false) —— 那会让「自绘关 + 系统栏不存在」再次可达",
    ).toBe(false);
  });

  it("Mica 仍默认关（与标题栏那条无关：换壁纸／低配机器可能发花）", () => {
    expect(defaultFor("shuyonote:material")).toBe(false);
  });
});
