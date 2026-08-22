import { create } from "zustand";

// Folder the file-manager view is currently opened at (null = workspace root).
// Lifted to a store so clicking a folder in the sidebar opens the file
// manager focused on that folder; revision lets the sidebar refresh its file
// lists after uploads/removals.
interface FileManagerState {
  folderId: string | null;
  setFolderId: (id: string | null) => void;
  revision: number;
  bumpRevision: () => void;
}

export const useFileManagerStore = create<FileManagerState>((set) => ({
  folderId: null,
  setFolderId: (folderId) => set({ folderId }),
  revision: 0,
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}));
