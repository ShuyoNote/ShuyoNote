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
  // ⚠️⚠️ 2026-10-10（**真事故**，owner 报的现象）：自绘标题栏**必须默认开**。
  //
  //   Rust 侧窗口是以 `decorations(false)` 创建的（`src-tauri/src/lib.rs:610`）✗
  //   ⇒ **系统标题栏根本不存在** ✗ —— 而这里原来注释写着"Windows 上默认系统栏，更稳妥"✗，
  //     那个前提是**假的**：系统栏只在 `custom=false` 时才是"系统栏"，
  //     可此时**没有任何代码把它打开**（唯一出路是前端运行时调 `setDecorations` ✓）。
  //   ⇒ ⭐ 两个互相独立的开关**同时为假** ⇒ **"系统栏 ✗ ＋ 自绘栏 ✗ ＝ 一条标题栏都没有"** ✗
  //     （`TitleBar.tsx:116` 是 `if (!desktop || !custom) return null` ✓）
  //
  //   实测读数（AMD 侧只读调查，几何＋像素双证 ✓）：窗口 `Tauri Window`／`MainWindowTitle=测试`／
  //   内嵌 dist（⛔ 不是浏览器页 ✗）｜ ⭐ `NC top = 2` 物理像素 ✗（同 DPI 下真标题栏 ≥46 ✓）｜
  //   右上角（最小化/最大化/关闭该在的地方）**整片空白** ✓
  //   ⚠️ 而窗口样式位 `WS_CAPTION` **是置位的** ✗ ⇒ **拿样式位判会得到假答案** ✓（别再踩 ✗）。
  //
  //   ⇒ 所以：自绘栏默认**开**（这才是设计意图 —— 本仓有 `TitleBar.tsx` ✓）；
  //     Mica 仍默认**关**（与换壁纸／低配机器发花有关 ✓，与上面那条无关 ✓）。
  if (key === KEY_MATERIAL) return false;
  return true;
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
