import { create } from "zustand";

// 窗口外观（仅桌面端有意义）。
//
// 自绘标题栏在 Windows 上是有代价的交易：换来一条可用的顶栏与统一的视觉，
// 但要自己接管系统本来免费提供的东西（Aero Snap、边缘 resize、系统菜单）。
// 因此做成**可开关**且能即时切换（`setDecorations` 运行时可调），万一某台机器
// 上贴边分屏或缩放手感不对，用户可以立刻退回系统标题栏，而不是被卡住。
const KEY = "shuyonote:customTitleBar";

interface WindowChromeState {
  /** true = 自绘标题栏（窗口无边框）；false = 系统标题栏。 */
  custom: boolean;
  setCustom: (v: boolean) => void;
}

function load(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
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
  custom: load(),
  setCustom: (v) => {
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ custom: v });
    void applyDecorations(v);
  },
}));
