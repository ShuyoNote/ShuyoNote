// M26 公式 —— Notion 风格的公式编辑器弹窗 store. Opened for the `/公式` insert
// and for editing an existing FormulaNode. While editing, each keystroke is
// live-previewed onto the editor's formula block (livePreview); commit persists
// the final value, cancel restores the original.
import { create } from "zustand";

export interface FormulaEditorState {
  open: boolean;
  /** Initial LaTeX (empty for a new formula). */
  initial: string;
  /** Original value of the block being edited, restored on cancel. */
  original: string;
  /** Screen rect of the anchor block, to position the dialog just below it. */
  anchor: { top: number; left: number; width: number; height: number } | null;
  /** Callback invoked on every input change to live-preview onto the block. */
  livePreview: ((latex: string) => void) | null;
  /** Commit callback: receives the final LaTeX. */
  onCommit: ((latex: string) => void) | null;
}

interface FormulaEditorStore extends FormulaEditorState {
  openEditor: (opts: {
    initial?: string;
    original?: string;
    anchor?: { top: number; left: number; width: number; height: number } | null;
    livePreview?: (latex: string) => void;
    onCommit: (latex: string) => void;
  }) => void;
  close: () => void;
}

export const useFormulaEditorStore = create<FormulaEditorStore>((set) => ({
  open: false,
  initial: "",
  original: "",
  anchor: null,
  livePreview: null,
  onCommit: null,
  openEditor: (opts) =>
    set({
      open: true,
      initial: opts.initial ?? "",
      original: opts.original ?? opts.initial ?? "",
      anchor: opts.anchor ?? null,
      livePreview: opts.livePreview ?? null,
      onCommit: opts.onCommit,
    }),
  close: () => set({ open: false }),
}));

// Convenience helper, mirroring `inputDialog`.
export function openFormulaEditor(opts: {
  initial?: string;
  original?: string;
  anchor?: { top: number; left: number; width: number; height: number } | null;
  livePreview?: (latex: string) => void;
  onCommit: (latex: string) => void;
}): void {
  useFormulaEditorStore.getState().openEditor(opts);
}
