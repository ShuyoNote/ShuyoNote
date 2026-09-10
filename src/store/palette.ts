import { create } from "zustand";

/**
 * 命令面板的开关与预填查询。
 *
 * 为什么从组件内部 `useState` 提升到 store：编辑器 `/` 菜单里选到**带参数**的插件命令时，
 * 参数表单只在命令面板里有（宿主按 schema 渲染的唯一一份实现）。与其再实现一套对话框表单，
 * 不如把面板"用某个查询打开"这件事变成公共能力——顺便也让快捷键、帮助、其它入口都能这么做。
 */
interface PaletteState {
  open: boolean;
  /** 打开时预填的查询词（空串＝不预填）。 */
  query: string;
  setOpen: (open: boolean) => void;
  /** 用给定查询打开面板（用于把带参数的命令转交给参数表单）。 */
  seedQuery: (query: string) => void;
  /** 用户在面板里改了查询词。 */
  setQuery: (query: string) => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  query: "",
  setOpen: (open) => set(open ? { open: true } : { open: false, query: "" }),
  seedQuery: (query) => set({ open: true, query }),
  setQuery: (query) => set({ query }),
}));
