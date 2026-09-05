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
  /** 耗时显示。 */
  startedAt: number;
  durationMs: number;
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
  startedAt: 0,
  durationMs: 0,

  setProgress: (p) => set({ ...p, syncing: true }),
  begin: (message) =>
    set({ syncing: true, phase: "idle", message: message ?? "", attCurrent: 0, attTotal: 0, attName: "", error: null, startedAt: Date.now(), durationMs: 0 }),
  end: (error) =>
    set((s) => ({ syncing: false, phase: error ? "error" : "done", error: error ?? null, durationMs: Date.now() - (s.startedAt || Date.now()) })),
}));
