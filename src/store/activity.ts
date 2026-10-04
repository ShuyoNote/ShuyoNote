import { create } from "zustand";

/** 左侧竖条（activity bar）当前选中的活动——每一项都对应一个主区视图。
 *  搜索**不是**活动：它是弹层式的一次性动作（用完即走、不占侧栏、不把页面树
 *  顶掉，在看板/关系图视图下同样可用），触发器只是借住在竖条里。 */
export type Activity = "notes" | "files" | "board" | "graph" | "timeline" | "map";

/** ⭐ 活动的**唯一白名单** ✓ —— `Activity` 类型 ＋ 运行时可核的名单放在一起，
 *  免得两处各写一份（⭐ 原先 `initialActivity()` 里手写了一遍这 6 个字面量 ✗）。 */
export const ACTIVITIES = ["notes", "files", "board", "graph", "timeline", "map"] as const;

/**
 * ⚠️ **2026-10-04 加**：运行时收窄 `Activity` ✓。
 * 来由：⭐ `AppView`（`store/view` 的 `view` ✓）**比 `Activity` 宽** ✗ ——
 * ⚠️ **2026-10-04 订正**：原写「它还有 settings / trash / **templates** / search 这类非活动视图」✗ ——
 *    ⭐ 那句**是错的** ✓：`store/view.ts` 的 `AppView` 逐字只有
 *    `"notes" | "board" | "graph" | "files" | "timeline" | "map"` ✓ ⇒ ⭐ **没有 templates** ✓
 *    （⭐ 模板中心今天走的是它自己那个光杆布尔 `store/templateCenter` ✓ ⇒ ⭐ 它**不是** view ✓）。
 *    ⭐ settings / trash / search 也不是 `view` 的值 ✗ —— 它们各有各的开关 ✓
 *    ⇒ ⭐ 所以"宽"这句话**结论对、举例全错** ✓ ⇒ ⭐ 按代码订正 ✓。
 * 而 `ActivityBar` 里有一处 `setActivity(view as Activity)` ✗（⭐ `as` 把类型检查绕过去了 ✓），
 * 于是打开设置/回收站时会把**非法值**写进 `activity` ✓。
 * ⇒ ⭐ 正确写法是**先收窄再写**：`if (isActivity(view)) setActivity(view)` ✓。
 */
export function isActivity(v: unknown): v is Activity {
  return typeof v === "string" && (ACTIVITIES as readonly string[]).includes(v);
}

interface ActivityState {
  activity: Activity;
  /** 侧栏是否展开。⭐ 收起/展开只由竖条那颗 `.sidebar-toggle-btn` 负责 ✓
   *  （⚠️ 2026-10-04 改：原先点**当前活动图标**也能收起侧栏 —— VS Code 行为 ✗；
   *   但那让每个活动图标都"能收起侧栏"，与"切换视图"混在一起 ✗ ⇒ 已去掉 ✓）。 */
  sidebarOpen: boolean;
  /** 窄屏的浮层竖条是否展开。**不持久化**：它是瞬时的布局状态，由屏幕尺寸
   *  决定，跨会话记住没有意义（和 sidebarOpen 的区别就在这）。 */
  railOpen: boolean;
  setActivity: (a: Activity) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean, opts?: { persist?: boolean }) => void;
  setRailOpen: (v: boolean) => void;
}

const KEY_ACTIVITY = "shuyonote:activity";
const KEY_SIDEBAR = "shuyonote:sidebarOpen";

function initialActivity(): Activity {
  // ⭐ 复用白名单（原先这里手写了一遍 6 个字面量 ✗ —— 加活动时容易只改一处 ✓）。
  const v = localStorage.getItem(KEY_ACTIVITY);
  return isActivity(v) ? v : "notes";
}

// 竖条状态独立于 `useViewStore`：view 描述**主区**显示什么，activity 描述
// **左侧导航**选中什么；两者保持同步（命令面板切视图时竖条也会跟着高亮），
// 拆成两个 store 是因为竖条还要管 sidebarOpen 这类纯 UI 状态。
export const useActivity = create<ActivityState>((set, get) => ({
  activity: initialActivity(),
  sidebarOpen: localStorage.getItem(KEY_SIDEBAR) !== "0",
  railOpen: false,
  setRailOpen: (v) => set({ railOpen: v }),
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
  setSidebarOpen: (v, opts) => {
    // `persist: false` 用于**布局驱动**的收起（移动端进入时自动收起、点遮罩、
    // 选完笔记）：那是屏幕尺寸决定的状态，不是用户对侧栏的偏好，写进
    // localStorage 会污染桌面端——手机上开过一次应用，桌面端下次启动侧栏
    // 就是收起的（用户从没在桌面收过它）。
    if (opts?.persist !== false) {
      try {
        localStorage.setItem(KEY_SIDEBAR, v ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
    set({ sidebarOpen: v });
  },
}));
