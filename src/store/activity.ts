import { create } from "zustand";

/** 左侧竖条（activity bar）当前选中的活动——每一项都对应一个主区视图。
 *  搜索**不是**活动：它是弹层式的一次性动作（用完即走、不占侧栏、不把页面树
 *  顶掉，在看板/关系图视图下同样可用），触发器只是借住在竖条里。 */
export type Activity = "notes" | "files" | "board" | "graph";

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
  return v === "notes" || v === "files" || v === "board" || v === "graph" ? v : "notes";
}

// 竖条状态独立于 `useViewStore`：view 描述**主区**显示什么，activity 描述
// **左侧导航**选中什么；两者保持同步（命令面板切视图时竖条也会跟着高亮），
// 拆成两个 store 是因为竖条还要管 sidebarOpen 这类纯 UI 状态。
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
