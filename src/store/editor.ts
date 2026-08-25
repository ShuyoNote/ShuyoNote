import { create } from "zustand";
import type { LexicalEditor } from "lexical";

// Holds the active LexicalEditor instance so components outside the editor
// tree (e.g. the top toolbar) can run editor commands, plus a pending
// block-id to scroll to after a page switch (block-reference jumps).
interface EditorState {
  editor: LexicalEditor | null;
  focusBlockId: string | null;
  /** Shared flag so the editor's "space opens AI" trigger can open the inline AI bar. */
  aiBarOpen: boolean;
  /** Screen position (fixed) where the floating inline AI bar should be anchored. */
  aiBarPos: { top: number; left: number } | null;
  /** Lexical key of the block where space was pressed — the AI draft inserts here. */
  aiBarAnchorKey: string | null;
  /** The drawing block currently being edited (nodeKey + stored scene refs). */
  drawingEdit: { nodeKey: string; hash: string | null; mime: string | null; text: string } | null;
  setEditor: (editor: LexicalEditor | null) => void;
  setFocusBlockId: (id: string | null) => void;
  clearFocusBlockId: () => void;
  setAiBarOpen: (v: boolean) => void;
  setAiBarPos: (pos: { top: number; left: number } | null) => void;
  setAiBarAnchorKey: (k: string | null) => void;
  openDrawingEdit: (d: { nodeKey: string; hash: string | null; mime: string | null; text: string }) => void;
  closeDrawingEdit: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  focusBlockId: null,
  aiBarOpen: false,
  aiBarPos: null,
  aiBarAnchorKey: null,
  drawingEdit: null,
  setEditor: (editor) => set({ editor }),
  setFocusBlockId: (id) => set({ focusBlockId: id }),
  clearFocusBlockId: () => set({ focusBlockId: null }),
  setAiBarOpen: (v) => set({ aiBarOpen: v }),
  setAiBarPos: (pos) => set({ aiBarPos: pos }),
  setAiBarAnchorKey: (k) => set({ aiBarAnchorKey: k }),
  openDrawingEdit: (d) => set({ drawingEdit: d }),
  closeDrawingEdit: () => set({ drawingEdit: null }),
}));
