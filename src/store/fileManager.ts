import { create } from "zustand";

// Folder the file-manager view is currently opened at (null = workspace root).
// Lifted to a store so clicking a folder in the sidebar opens the file
// manager focused on that folder.
interface FileManagerState {
  folderId: string | null;
  setFolderId: (id: string | null) => void;
}

export const useFileManagerStore = create<FileManagerState>((set) => ({
  folderId: null,
  setFolderId: (folderId) => set({ folderId }),
}));
