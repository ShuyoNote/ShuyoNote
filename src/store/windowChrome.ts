import { create } from "zustand";

// 窗口外观（仅桌面端有意义）。
//
// 两个可开关项都做成「能立刻退回」而非一锤子定死：
// - customTitleBar 自绘标题栏：Windows 上无边框要自己接管 Aero Snap 与边缘
//   resize，个别机器手感不对可一键退回系统栏。
// - material（Mica）：与染色互斥，且换壁纸/低配机器上可能发花，默认关。
// 两者都存 localStorage、运行时可切换（setDecorations / set_mica_effect）。
const KEY_TITLEBAR = "shuyonote:customTitleBar";
const KEY_MATERIAL = "shuyonote:material";

interface WindowChromeState {
  /** true = 自绘标题栏（窗口无边框）；false = 系统标题栏。 */
  custom: boolean;
  /** true = 开启 Mica 材质（Win11 22H2+，旧系统静默降级）。 */
  material: boolean;
  setCustom: (v: boolean) => void;
  setMaterial: (v: boolean) => void;
}

function load(key: string): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? defaultFor(key) : v === "1";
  } catch {
    return defaultFor(key);
  }
}
/** 出厂默认值（无 localStorage 时）。⭐ 两个键的默认值**不一样**，见下。 */
export function defaultFor(key: string): boolean {
  // ⚠️⚠️ 2026-10-10（**真事故**，owner 报"标题栏一条都没有"）—— 结论与修法：
  //
  //   ① Rust 侧现在以 `decorations(true)` 创建窗口（`src-tauri/src/lib.rs` ✓，
  //      2026-10-10 从 `false` 改过来）⇒ ⭐ **系统标题栏默认就在** ✓
  //   ② 所以自绘栏的出厂默认**必须是 `false`** ✓ —— 否则默认会同时出现两条栏 ✗
  //   ③ ⭐ **"旧值"这件事要讲清**：这台机器的 `localStorage["shuyonote:customTitleBar"]`
  //      里存着 `"0"` ✓（由 `setCustom(false)` 写的 ✓）⇒ 上面那条 `v === "1"` 会把它当真 ✓。
  //      当时 Rust 侧是 `decorations(false)` ✗ ⇒ ⭐ **"自绘关 ＋ 系统栏不存在"** ⇒ 一条都没有 ✗。
  //      现在 Rust 侧**默认有**系统栏 ⇒ **那个组合不再危险** ✓（这正是 owner 拍 A 的理由 ✓）。
  //   ④ ⚠️ 一条**仍然成立的限制**（别再踩 ✓）：前端运行时 `setDecorations(true)`
  //      （⭐ **"从无到有"** ✓）在 Windows 上实测**不报错、也不生效** ✗
  //      （几何读数 `NC top = 7` 物理像素 ✗，真标题栏 ≥46 ✓；而且 `console` 里**没有错**✓）
  //      ⇒ ⭐ 所以**不许**再依赖"运行时把系统栏找回来"✗；**要系统栏就靠 Rust 侧的默认值** ✓。
  //   ⑤ Mica 仍默认关（与换壁纸／低配机器发花有关 ✓，与标题栏那条无关 ✓）。
  if (key === KEY_MATERIAL) return false;
  return false;
}

/** 把设置应用到窗口：无边框由前端 API 运行时切换，无需重启。 */
export async function applyDecorations(custom: boolean): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setDecorations(!custom);
  } catch (e) {
    console.error("setDecorations failed", e);
  }
}

export const useWindowChrome = create<WindowChromeState>((set) => ({
  custom: load(KEY_TITLEBAR),
  material: load(KEY_MATERIAL),
  setCustom: (v) => {
    try {
      localStorage.setItem(KEY_TITLEBAR, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ custom: v });
    void applyDecorations(v);
  },
  setMaterial: (v) => {
    try {
      localStorage.setItem(KEY_MATERIAL, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ material: v });
    void (async () => {
      const { api } = await import("../lib/api");
      await api.setMicaEffect(v);
      // Mica 与标题栏染色互斥：关 Mica 后要重新染色（Rust 里 MICA_ON 已更新），
      // 当前主题值由 theme.ts 统一持有，这里重新刷一遍即可。
      const { syncTitlebarColors } = await import("../store/theme");
      syncTitlebarColors();
    })().catch(() => {});
  },
}));
