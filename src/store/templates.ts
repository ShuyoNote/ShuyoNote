import { create } from "zustand";
import { api } from "../lib/api";
import { toast } from "./toast";
import type { TemplateMeta } from "../types";

// User-created templates ("我的模板", built_in=0), persisted in the DB.
// Built-in templates live in `src/templates/index.ts` and are merged at render.
interface TemplatesState {
  userTemplates: TemplateMeta[];
  load: () => Promise<void>;
  saveAs: (args: {
    name: string;
    content_json: string;
    content_text: string;
    cover?: string;
    icon?: string;
    category?: string;
    space_id?: string | null;
  }) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

export const useTemplates = create<TemplatesState>((set) => ({
  userTemplates: [],
  load: () =>
    api
      .listTemplates()
      .then((list) => set({ userTemplates: list }))
      .catch((e) => toast(`加载模板失败：${e}`, "error")),
  saveAs: async (args) => {
    try {
      const t = await api.saveAsTemplate({
        ...args,
        category: args.category ?? "我的模板",
        // 模板封面(题头图)：保存到模板，创建时应用到页面。
        cover: args.cover ?? "",
      });
      set((s) => ({ userTemplates: [...s.userTemplates, t] }));
      return true;
    } catch (e) {
      toast(`保存模板失败：${e}`, "error");
      return false;
    }
  },
  remove: async (id) => {
    try {
      await api.deleteTemplate(id);
      set((s) => ({ userTemplates: s.userTemplates.filter((x) => x.id !== id) }));
    } catch (e) {
      toast(`删除模板失败：${e}`, "error");
    }
  },
}));
