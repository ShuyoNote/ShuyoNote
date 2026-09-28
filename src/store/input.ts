import { create } from "zustand";

export interface InputOptions {
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  // The plain-text input. Returns the trimmed value, or null when cancelled.
  onSubmit?: (value: string) => void;
}

/** 【单选模式】的一问一答（A1：建空间时选「个人 / 团队」）—— 与 `confirm.ts` 同一手法。 */
export interface ChoiceOptions {
  title?: string;
  cancelLabel?: string;
  /** 每项：`value` 回给调用方，`label` 是按钮上的字，`hint` 是按钮下面那行小字。 */
  choices: { value: string; label: string; hint?: string }[];
}

interface InputState {
  options: InputOptions | null;
  open: (options: InputOptions) => void;
  close: () => void;
  /** 单选模式当前那一问（`null` ＝ 没在问）。 */
  chooser: ChoiceOptions | null;
  /** 单选模式的兑现函数（`confirm.ts` 同款：把 resolver 放进 store，组件只负责调它）。 */
  chooseResolver: ((v: string | null) => void) | null;
  openChoice: (options: ChoiceOptions) => Promise<string | null>;
  /** 组件调这一个：`value === null` ＝ 取消（点背景 / Esc / 取消按钮都走它）。 */
  closeChoice: (value: string | null) => void;
}

export const useInputStore = create<InputState>((set, get) => ({
  options: null,
  open: (options) => set({ options }),
  close: () => set({ options: null }),
  chooser: null,
  chooseResolver: null,
  openChoice: (options) =>
    new Promise<string | null>((resolve) => {
      set({ chooser: options, chooseResolver: resolve });
    }),
  // ⚠️ 取消也必须**兑现**这个 promise（`null`）—— 否则调用方永远等下去，
  // 现场就是"按钮点了没反应"的静默失败。
  closeChoice: (value) => {
    const resolve = get().chooseResolver;
    set({ chooser: null, chooseResolver: null });
    resolve?.(value);
  },
}));

// In-app text-input dialog, centered in the app window (not the OS screen).
export function inputDialog(options: InputOptions): void {
  useInputStore.getState().open(options);
}

/**
 * 【单选模式】的一次询问：点哪一项回哪个 `value`，取消回 `null`。
 *
 * ★ 用途（owner 2026-09-25 拍板 A1）：**建空间那一刻**问「个人还是团队」——
 * 分类由入口决定，别让用户先建一个再回头去隐私面板里找下拉
 * （那条回路正是"未分类 ⇒ 闸门没管到它"的漏洞面）。
 */
export function chooseDialog(options: ChoiceOptions): Promise<string | null> {
  return useInputStore.getState().openChoice(options);
}
