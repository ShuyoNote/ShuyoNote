import { create } from "zustand";

/**
 * 外部 `.md` 文件的**只读预览**请求（双击 / “打开方式” 唤起）。
 *
 * 关键语义（owner 2026-11-05）：
 * - **打开 ≠ 导入**：这里只记录路径并让浮层展示，**不建页、不写库**；
 * - 只有用户点「导入为笔记」时，组件才调用 `notes.createPage`；
 * - 路径可能来自冷启动（`--import` 队列 drain）或第二个实例；用队列保证
 *   多条请求不会互相覆盖。
 */
interface MarkdownFilePreviewState {
  /** 当前正在展示的路径；null = 浮层关闭。 */
  path: string | null;
  /** 等待展示的后续路径（多选 / 连续打开）。 */
  queue: string[];
  open: (path: string) => void;
  close: () => void;
}

export const useMarkdownFilePreview = create<MarkdownFilePreviewState>((set, get) => ({
  path: null,
  queue: [],
  open: (path) => {
    const p = String(path ?? "").trim();
    if (!p) return;
    const { path: current, queue } = get();
    if (current === p || queue.includes(p)) return;
    if (current === null) set({ path: p });
    else set({ queue: [...queue, p] });
  },
  close: () => {
    const { queue } = get();
    if (queue.length > 0) set({ path: queue[0], queue: queue.slice(1) });
    else set({ path: null });
  },
}));
