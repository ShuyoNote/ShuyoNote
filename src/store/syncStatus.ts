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

/**
 * 跑一次同步并**保证配对收尾**。
 *
 * ## 为什么要有这个包装（2026-09-15 真机验收的教训）
 *
 * P1 之后，Rust 侧每传一件附件都会 emit 进度，前端把它写进本 store —— 而 `setProgress`
 * 会把 `syncing` 置真。于是**任何触发同步的路径，只要忘了调 `end()`，面板就会永远停在
 * "正在同步…"**（真机上实测到：自动同步跑过一次之后，状态行 14 秒一动不动地停在
 * 「正在下载附件（1/2）」，而当时根本没有任何同步在跑）。
 * 这正是 B2 修过的那个 bug，只是从 P1 的门里回来了 —— 所以别再让每个调用点自己记得：
 * **触发同步就套这个函数**。
 *
 * ⚠️ `SyncPanel` 是例外：它要自己决定错误文案与冲突提示，所以自己配对（那边本来就对）。
 */
export async function withSyncStatus<T>(message: string, run: () => Promise<T>): Promise<T> {
  useSyncStatus.getState().begin(message);
  let err: string | null = null;
  try {
    return await run();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    useSyncStatus.getState().end(err);
  }
}
