import { create } from "zustand";
import { runAiLoop } from "../lib/ai/host";
import { applyDraft as commitDraft } from "../lib/ai/apply";
import { createOllamaTransport, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from "../lib/ai/llm";
import type { AiRunResult } from "../lib/ai/types";
import { useNotes } from "./notes";

const CFG_KEY = "shuyonote.ai.config";

export interface AiConfig {
  enabled: boolean;
  provider: "ollama";
  baseUrl: string;
  model: string;
}

interface AiState {
  config: AiConfig;
  open: boolean;
  running: boolean;
  /** Last completed run: the assistant's textual reply. */
  reply: string;
  /** Drafts awaiting explicit user confirmation. */
  drafts: Array<{ key: string; summary: string; payload: unknown }>;
  /** Transient error from the last run. */
  error: string | null;

  setOpen: (open: boolean) => void;
  update: (patch: Partial<AiConfig>) => void;
  run: (prompt: string) => Promise<void>;
  confirm: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
  clearResult: () => void;
  resetError: () => void;
}

function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL };
    const c = JSON.parse(raw);
    return {
      enabled: !!c.enabled,
      provider: c.provider === "ollama" ? "ollama" : "ollama",
      baseUrl: String(c.baseUrl || OLLAMA_DEFAULT_URL),
      model: String(c.model || OLLAMA_DEFAULT_MODEL),
    };
  } catch {
    return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL };
  }
}

function saveConfig(c: AiConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
  } catch {
    // localStorage unavailable (privacy mode) — config just won't persist.
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  config: loadConfig(),
  open: false,
  running: false,
  reply: "",
  drafts: [],
  error: null,

  setOpen: (open) => set({ open }),

  update: (patch) => {
    const config = { ...get().config, ...patch };
    saveConfig(config);
    set({ config });
  },

  run: async (prompt: string) => {
    const trimmed = (prompt ?? "").trim();
    if (!trimmed || get().running) return;
    const { config } = get();
    if (!config.enabled) {
      set({ error: "AI 功能未启用，请先在设置中开启并配置模型。", open: true });
      return;
    }
    const notes = useNotes.getState();
    const allPages = notes.pages.map((p) => ({ id: p.id, title: p.title, parent_id: p.parent_id }));
    set({ running: true, error: null });

    try {
      const transport = createOllamaTransport(config.baseUrl, config.model);
      const result: AiRunResult = await runAiLoop(
        trimmed,
        allPages.map((p) => ({ id: p.id, title: p.title })),
        { currentPageId: notes.currentId, allPages },
        { transport },
      );
      // Keep existing drafts, replace reply/error with the fresh run.
      set({
        running: false,
        reply: result.reply,
        drafts: result.drafts.length ? result.drafts : get().drafts,
        error: result.ok ? null : result.error ?? null,
      });
    } catch (e) {
      set({ running: false, error: String((e as Error)?.message ?? e) });
    }
  },

  confirm: async (key: string) => {
    const draft = get().drafts.find((d) => d.key === key);
    if (!draft) return;
    try {
      const res = await commitDraft(draft.payload);
      const notes = useNotes.getState();
      await notes.loadPages();
      // If the commit touched the currently-open page, refresh its in-memory detail
      // so the editor reflects the append; a freshly created page is opened so the
      // user lands on it.
      if (res.page) {
        if (res.page.id === notes.currentId) {
          notes.updateCurrent({ title: res.page.title, content_json: res.page.content_json, content_text: res.page.content_text });
        } else {
          await notes.openPage(res.page.id);
        }
      }
      // Only clear the confirmed draft; keep any others.
      set({ drafts: get().drafts.filter((d) => d.key !== key), error: res.ok ? null : res.message });
    } catch (e) {
      set({ error: String((e as Error)?.message ?? e) });
    }
  },

  dismiss: (key: string) => set({ drafts: get().drafts.filter((d) => d.key !== key) }),

  clearResult: () => set({ reply: "", drafts: [], error: null }),
  resetError: () => set({ error: null }),
}));
