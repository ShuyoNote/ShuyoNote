import { create } from "zustand";
import type { LexicalEditor } from "lexical";

// Holds the active LexicalEditor instance so components outside the editor
// tree (e.g. the top toolbar) can run editor commands.
interface EditorState {
  editor: LexicalEditor | null;
  setEditor: (editor: LexicalEditor | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  setEditor: (editor) => set({ editor }),
}));
