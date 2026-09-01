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
function defaultFor(key: string): boolean {
  return key === KEY_TITLEBAR; // 标题栏默认开，材质默认关
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
