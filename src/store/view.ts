import { create } from "zustand";
import { useFilePreview } from "./filePreview";
import { usePdfReader } from "./pdfReader";

// ⚠️ **2026-10-04 加 "templates"**（owner 批的 c）：⭐ 模板中心原来是**它自己一个光杆布尔**
// （store/templateCenter 的 open）⇒ ⭐ 不高亮、不记忆、只能"开/关" ✗。
// ⇒ ⭐ 并进这里之后：⭐ 活动栏能高亮它 ✓ ／ ⭐ 命令面板与别处一条 setView 就能切 ✓ ／
//    ⭐ 与其它视图一样受"切换时关掉残留浮层"那条规则管 ✓。
export type AppView = "notes" | "board" | "graph" | "files" | "timeline" | "map" | "templates";
export type ContentWidth = "centered" | "full";

interface ViewState {
  view: AppView;
  setView: (view: AppView) => void;
  /** ⭐ 进模板中心**之前**那个视图 —— 退出模板中心要回得去 ✓（原来靠一个布尔，没有"回哪"的问题）。 */
  prevView: AppView;
  /** ⭐ 退出模板中心：回 prevView ✓。三个调用点原来都是 setOpen(false)。 */
  leaveTemplates: () => void;
  // Page content width: centered (capped at --doc-width) or adaptive full width.
  contentWidth: ContentWidth;
  setContentWidth: (width: ContentWidth) => void;
  // ⭐ 2026-10-02（owner）：「目录做成并排停靠 ＋ 鼠标拖拽调整正文区与目录区的宽度」。
  // 目录宽度（px）—— 与 `contentWidth` **同一套存法**（命名空间键 ＋ try/catch ✓），
  // 因为它同属"界面偏好"⇒ 重启后应当还在 ✓（⛔ 不发明第二种持久化 ✗）。
  tocWidth: number;
  setTocWidth: (width: number) => void;
}

const WIDTH_KEY = "shuyonote:contentWidth";
const TOC_W_KEY = "shuyonote:tocWidth";

/** 目录宽度的上下限与默认值 —— 拖拽时按这几个数夹住 ✓（导出让组件与判据共用同一份 ✓）。 */
export const TOC_W_MIN = 240;
export const TOC_W_MAX = 560;
export const TOC_W_DEFAULT = 300;

export function clampTocWidth(w: number): number {
  return Math.min(TOC_W_MAX, Math.max(TOC_W_MIN, Math.round(w)));
}

/** 读历史偏好 ✓：⛔ 坏值不许把界面搞崩 ✗（不是有限数就用默认值 ✓）。 */
function readTocWidth(): number {
  try {
    const n = Number(localStorage.getItem(TOC_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampTocWidth(n) : TOC_W_DEFAULT;
  } catch {
    return TOC_W_DEFAULT;
  }
}

// Active top-level view (notes / board / relationship graph). Lifted to a
// store so the command palette and keyboard shortcuts can switch views.
export const useViewStore = create<ViewState>((set, get) => ({
  view: "notes",
  prevView: "notes",
  setView: (view) => {
    // ⚠️ **2026-10-04 删掉一句**：这里原来有一句「自动关闭模板中心」（setOpen(false)）——
    //    那是模板中心**还不是 view** 时的补丁 ✓。⚠️ 并进来之后它会 _自己关自己_ ✗：
    //    切到 templates 时这句先把 templates 关掉，界面永远进不去 ✓（实测推理出来的，务必别加回来）。
    // ⭐ 现在只做一件相关的事：**从非模板视图切进模板时记住来路** ✓（退出时回得去 ✓）。
    if (view === "templates" && get().view !== "templates") set({ prevView: get().view });
    // 切到主区视图（尤其「文件/文件夹」视图）时，关掉残留的 MD/图片预览与 PDF 阅读器，
    // 避免这些覆盖层叠在切换后的视图上（活动栏之外经由目录树/面包屑/命令面板切换也会走到这里）。
    useFilePreview.getState().close();
    usePdfReader.getState().close();
    set({ view });
  },
  // ⭐ 退出模板中心：回"进来之前"那个视图 ✓（三个调用点原来都是 setOpen(false)）。
  leaveTemplates: () => get().setView(get().prevView === "templates" ? "notes" : get().prevView),
  contentWidth: (localStorage.getItem(WIDTH_KEY) as ContentWidth) || "centered",
  setContentWidth: (width) => {
    try {
      localStorage.setItem(WIDTH_KEY, width);
    } catch {
      /* ignore */
    }
    set({ contentWidth: width });
  },
  tocWidth: readTocWidth(),
  setTocWidth: (width) => {
    const clamped = clampTocWidth(width);
    try {
      localStorage.setItem(TOC_W_KEY, String(clamped));
    } catch {
      /* ignore */
    }
    set({ tocWidth: clamped });
  },
}));
