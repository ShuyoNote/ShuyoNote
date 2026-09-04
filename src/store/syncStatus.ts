import { create } from "zustand";

export type SyncPhase = "idle" | "pushing" | "pulling" | "attachments" | "scanning" | "done" | "error";

export interface SyncStatusState {
  /** 每次同步一个自增 id，UI 据此判断是否新一次同步。 */
  syncing: boolean;
  phase: SyncPhase;
  message: string;
  /** 附件进度。 */
  attCurrent: number;
  attTotal: number;
  attName: string;
  error: string | null;
}

export interface SyncStatusApi extends SyncStatusState {
  setProgress: (p: Partial<SyncStatusState>) => void;
  begin: (message?: string) => void;
  end: (error?: string | null) => void;
}

export const useSyncStatus = create<SyncStatusApi>((set) => ({
  syncing: false,
  phase: "idle",
  message: "",
  attCurrent: 0,
  attTotal: 0,
  attName: "",
  error: null,

  setProgress: (p) => set({ ...p, syncing: true }),
  begin: (message) =>
    set({ syncing: true, phase: "idle", message: message ?? "", attCurrent: 0, attTotal: 0, attName: "", error: null }),
  end: (error) =>
    set({ syncing: false, phase: error ? "error" : "done", error: error ?? null }),
}));
