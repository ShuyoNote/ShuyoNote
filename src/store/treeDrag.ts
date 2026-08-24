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
  /** Title of the dragged node, used to render a floating ghost at the cursor. */
  label: string | null;
  /** Node kind ("folder"/"database"/"page") for the ghost icon. */
  kind: string | null;
  /** Cursor position for the ghost (viewport coords). */
  x: number;
  y: number;
  overId: string | null;
  zone: DropZone | null;
  /** A folder to auto-expand (set after hovering its "inside" zone briefly). */
  expandId: string | null;
  start: (id: string, label: string, kind?: string) => void;
  move: (overId: string | null, zone: DropZone | null) => void;
  /** Update the ghost position (called on every mousemove while dragging). */
  cursor: (x: number, y: number) => void;
  /** Request a folder to auto-expand during a drag. */
  requestExpand: (id: string | null) => void;
  end: () => void;
}

export const useTreeDrag = create<TreeDragState>((set) => ({
  draggingId: null,
  label: null,
  kind: null,
  x: 0,
  y: 0,
  overId: null,
  zone: null,
  expandId: null,
  start: (id, label, kind = "page") => set({ draggingId: id, label, kind }),
  move: (overId, zone) => set({ overId, zone }),
  cursor: (x, y) => set({ x, y }),
  requestExpand: (id) => set({ expandId: id }),
  end: () => set({ draggingId: null, label: null, kind: null, overId: null, zone: null, expandId: null }),
}));
