import { create } from "zustand";
import { useTemplateCenterStore } from "./templateCenter";
import { useFilePreview } from "./filePreview";
import { usePdfReader } from "./pdfReader";

export type AppView = "notes" | "board" | "graph" | "files" | "timeline" | "map";
export type ContentWidth = "centered" | "full";

interface ViewState {
  view: AppView;
  setView: (view: AppView) => void;
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
export const useViewStore = create<ViewState>((set) => ({
  view: "notes",
  setView: (view) => {
    // 切换视图（笔记/看板/关系图/文件）时自动关闭模板中心，避免覆盖层残留。
    useTemplateCenterStore.getState().setOpen(false);
    // 切到主区视图（尤其「文件/文件夹」视图）时，关掉残留的 MD/图片预览与 PDF 阅读器，
    // 避免这些覆盖层叠在切换后的视图上（活动栏之外经由目录树/面包屑/命令面板切换也会走到这里）。
    useFilePreview.getState().close();
    usePdfReader.getState().close();
    set({ view });
  },
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
