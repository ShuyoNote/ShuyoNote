import { create } from "zustand";
import type { LexicalEditor } from "lexical";

/** 设置中心的标签页 id（单一来源，SettingsDialog 与命令面板共用）。 */
export type SettingsTab = "appearance" | "spaces" | "account" | "email" | "data" | "plugins" | "security" | "ai" | "about";

// Holds the active LexicalEditor instance so components outside the editor
// tree (e.g. the top toolbar) can run editor commands, plus a pending
// block-id to scroll to after a page switch (block-reference jumps).
interface EditorState {
  editor: LexicalEditor | null;
  focusBlockId: string | null;
  /**
   * 阶段 1 · **有未决冲突的块**（提示条发布、编辑器画角标）：
   * 空数组 = 没有冲突（编辑器会把角标清掉）。
   */
  conflictBlockIds: string[];
  /** Shared flag so the editor's "space opens AI" trigger can open the inline AI bar. */
  aiBarOpen: boolean;
  /** Screen position (fixed) where the floating inline AI bar should be anchored. */
  aiBarPos: { top: number; left: number } | null;
  /** Lexical key of the block where space was pressed — the AI draft inserts here. */
  aiBarAnchorKey: string | null;
  /** The drawing block currently being edited (nodeKey + stored scene refs). */
  drawingEdit: { nodeKey: string; hash: string | null; mime: string | null; text: string } | null;
  /** M25 — whether the keyboard-shortcuts overlay is open. */
  shortcutsOpen: boolean;
  /** M25 P2 — whether the "关于" dialog is open. */
  aboutOpen: boolean;
  /** 设置中心：是否打开 + 当前标签页（外观/插件/安全/AI/关于）。 */
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Whether a newer version is available (globally checked on app start). */
  updateAvailable: boolean;
  /** Latest available version string (when updateAvailable). */
  latestVersion: string | null;
  setEditor: (editor: LexicalEditor | null) => void;
  setFocusBlockId: (id: string | null) => void;
  clearFocusBlockId: () => void;
  setConflictBlockIds: (ids: string[]) => void;
  setAiBarOpen: (v: boolean) => void;
  setAiBarPos: (pos: { top: number; left: number } | null) => void;
  setAiBarAnchorKey: (k: string | null) => void;
  openDrawingEdit: (d: { nodeKey: string; hash: string | null; mime: string | null; text: string }) => void;
  closeDrawingEdit: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openAbout: () => void;
  closeAbout: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setUpdateAvailable: (v: boolean, latest?: string | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  focusBlockId: null,
  conflictBlockIds: [],
  aiBarOpen: false,
  aiBarPos: null,
  aiBarAnchorKey: null,
  drawingEdit: null,
  shortcutsOpen: false,
  aboutOpen: false,
  settingsOpen: false,
  settingsTab: "appearance",
  updateAvailable: false,
  latestVersion: null,
  setEditor: (editor) => set({ editor }),
  setFocusBlockId: (id) => set({ focusBlockId: id }),
  clearFocusBlockId: () => set({ focusBlockId: null }),
  // 同一份表重复发布时**不产生新状态**（否则每轮同步都会让编辑器重挂一次 update listener）
  setConflictBlockIds: (ids) =>
    set((s) => (s.conflictBlockIds.join("\u0000") === ids.join("\u0000") ? s : { conflictBlockIds: ids })),
  setAiBarOpen: (v) => set({ aiBarOpen: v }),
  setAiBarPos: (pos) => set({ aiBarPos: pos }),
  setAiBarAnchorKey: (k) => set({ aiBarAnchorKey: k }),
  openDrawingEdit: (d) => set({ drawingEdit: d }),
  closeDrawingEdit: () => set({ drawingEdit: null }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),
  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setUpdateAvailable: (v, latest) => set({ updateAvailable: v, latestVersion: latest ?? null }),
}));
