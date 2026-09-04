import { create } from "zustand";
import { useFilePreview } from "./filePreview";
import { usePdfReader } from "./pdfReader";

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
  setFolderId: (folderId) => {
    // 进入/切换文件夹时关掉残留的 MD/图片预览与 PDF 阅读器，避免覆盖层叠在文件夹视图上。
    useFilePreview.getState().close();
    usePdfReader.getState().close();
    set({ folderId });
  },
  revision: 0,
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}));
