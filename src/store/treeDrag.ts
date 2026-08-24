import { create } from "zustand";

// Pointer-based (HTML5-DnD-independent) drag state for the sidebar page tree.
//
// Tauri v2 enables `dragDropEnabled` by default, which suppresses the webview's
// native HTML5 drag-and-drop — so a `draggable` node works in a browser but NOT
// in the desktop app. We therefore drag using mouse events (mousedown → move →
// mouseup) which work identically everywhere and don't conflict with OS file drop.
export type DropZone = "before" | "after" | "inside";

interface TreeDragState {
  draggingId: string | null;
  overId: string | null;
  zone: DropZone | null;
  start: (id: string) => void;
  move: (overId: string | null, zone: DropZone | null) => void;
  end: () => void;
}

export const useTreeDrag = create<TreeDragState>((set) => ({
  draggingId: null,
  overId: null,
  zone: null,
  start: (id) => set({ draggingId: id }),
  move: (overId, zone) => set({ overId, zone }),
  end: () => set({ draggingId: null, overId: null, zone: null }),
}));
