import { create } from "zustand";
import { runAiLoop } from "../lib/ai/host";
import { applyDraft as commitDraft } from "../lib/ai/apply";
import {
  createProviderTransport,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_URL,
  OPENAI_COMPAT_DEFAULT_BASE,
  OPENAI_COMPAT_DEFAULT_MODEL,
  type ProviderConfig,
} from "../lib/ai/llm";
import { createApiTransport } from "../lib/ai/transport";
import type { AiRunResult } from "../lib/ai/types";
import { useNotes } from "./notes";

const CFG_KEY = "shuyonote.ai.config";
const HISTORY_KEY = "shuyonote.ai.history";
// Web (browser) can stream cloud/local LLMs directly via fetch; desktop goes
// through the backend proxy (non-streaming) to bypass CORS.
const IS_WEB = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

export interface AiConfig {
  enabled: boolean;
  provider: "ollama" | "openai";
  baseUrl: string;
  model: string;
  apiKey: string;
}

const HISTORY_LIMIT = 16; // cap on stored turns (8 exchanges) to bound context.
// Monotonic token: a stop() or a newer run() invalidates an in-flight result.
let runSeq = 0;

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
  /** Prior user/assistant turns, so follow-ups keep context. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** Tool calls performed last run (for transparency). */
  activity: Array<{ tool: string; note: string }>;

  setOpen: (open: boolean) => void;
  update: (patch: Partial<AiConfig>) => void;
  run: (prompt: string) => Promise<void>;
  stop: () => void;
  confirm: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
  clearResult: () => void;
  resetError: () => void;
}

function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) {
      return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL, apiKey: "" };
    }
    const c = JSON.parse(raw);
    const provider: "ollama" | "openai" = c.provider === "openai" ? "openai" : "ollama";
    return {
      enabled: !!c.enabled,
      provider,
      baseUrl: String(c.baseUrl || (provider === "openai" ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL)),
      model: String(c.model || (provider === "openai" ? OPENAI_COMPAT_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL)),
      apiKey: String(c.apiKey ?? ""),
    };
  } catch {
    return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL, apiKey: "" };
  }
}

function saveConfig(c: AiConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
  } catch {
    // localStorage unavailable (privacy mode) — config just won't persist.
  }
}

function loadHistory(): Array<{ role: "user" | "assistant"; content: string }> {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(h: Array<{ role: "user" | "assistant"; content: string }>) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_LIMIT)));
  } catch {
    // ignore
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  config: loadConfig(),
  open: false,
  running: false,
  reply: "",
  drafts: [],
  error: null,
  history: loadHistory(),
  activity: [],

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
    const seq = ++runSeq;
    set({ running: true, error: null });

    // Live-stream window (throttled) so web replies appear token-by-token.
    let buffered = "";
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      if (buffered) {
        const chunk = buffered;
        buffered = "";
        set((s) => ({ reply: s.reply + chunk }));
      }
    };
    const onDelta = (t: string) => {
      buffered += t;
      if (timer === null) timer = window.setTimeout(flush, 40);
    };

    try {
      const transport = IS_WEB ? createProviderTransport(config as ProviderConfig) : createApiTransport(config as ProviderConfig);
      const result: AiRunResult = await runAiLoop(
        trimmed,
        allPages.map((p) => ({ id: p.id, title: p.title })),
        { currentPageId: notes.currentId, allPages },
        { transport, history: get().history, onDelta: IS_WEB ? onDelta : undefined },
      );
      // A newer run() or a stop() invalidates this result (stale discard).
      if (seq !== runSeq) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      buffered = "";
      // Keep existing drafts, replace reply/error with the fresh run; keep the
      // last assistant reply in history so follow-ups ("再详细点") stay in context.
      const history = [...get().history, { role: "user" as const, content: trimmed }];
      if (result.reply) history.push({ role: "assistant" as const, content: result.reply });
      const historyCapped = result.ok ? history.slice(-HISTORY_LIMIT) : get().history;
      saveHistory(historyCapped);
      set({
        running: false,
        reply: result.reply,
        drafts: result.drafts.length ? result.drafts : get().drafts,
        error: result.ok ? null : result.error ?? null,
        history: historyCapped,
        activity: result.activity ?? [],
      });
    } catch (e) {
      if (seq !== runSeq) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      buffered = "";
      set({ running: false, error: String((e as Error)?.message ?? e) });
    }
  },

  stop: () => {
    runSeq++;
    set({ running: false });
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

  clearResult: () => {
    saveHistory([]);
    set({ reply: "", drafts: [], error: null, history: [], activity: [] });
  },
  resetError: () => set({ error: null }),
}));
