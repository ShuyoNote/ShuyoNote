import { create } from "zustand";

/** 左侧竖条（activity bar）当前选中的活动。 */
export type Activity = "notes" | "search" | "files" | "board" | "graph";

/** 只有这些活动会改变**侧栏内容**；其余切换的是主区视图。 */
export type SidebarPanel = "tree" | "search";

interface ActivityState {
  activity: Activity;
  /** 侧栏是否展开（竖条常驻；点当前活动图标可收起侧栏，VS Code 行为）。 */
  sidebarOpen: boolean;
  setActivity: (a: Activity) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean) => void;
}

const KEY_ACTIVITY = "shuyonote:activity";
const KEY_SIDEBAR = "shuyonote:sidebarOpen";

function initialActivity(): Activity {
  const v = localStorage.getItem(KEY_ACTIVITY);
  return v === "notes" || v === "search" || v === "files" || v === "board" || v === "graph" ? v : "notes";
}

// 竖条状态独立于 `useViewStore`：view 描述**主区**显示什么，activity 描述
// **左侧导航**选中什么。两者大部分时候同步（点「看板」= 切主区），但
// 「搜索」只换侧栏面板、不动主区——这正是 activity bar 与视图切换的区别。
export const useActivity = create<ActivityState>((set, get) => ({
  activity: initialActivity(),
  sidebarOpen: localStorage.getItem(KEY_SIDEBAR) !== "0",
  setActivity: (a) => {
    try {
      localStorage.setItem(KEY_ACTIVITY, a);
    } catch {
      /* ignore */
    }
    set({ activity: a });
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    try {
      localStorage.setItem(KEY_SIDEBAR, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ sidebarOpen: next });
  },
  setSidebarOpen: (v) => {
    try {
      localStorage.setItem(KEY_SIDEBAR, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ sidebarOpen: v });
  },
}));

/** 该活动对应的侧栏面板（notes/files/board/graph 都用页面树）。 */
export function panelOf(a: Activity): SidebarPanel {
  return a === "search" ? "search" : "tree";
}
