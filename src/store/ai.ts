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
import { createBackendStreamingTransport } from "../lib/ai/transport";
import type { AiRunResult } from "../lib/ai/types";
import { useNotes } from "./notes";
import { useRightPanel } from "./rightPanel";
import { useEntitlements } from "./entitlements";
import { capLabel, type Aicap } from "../lib/ai/entitlements";

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
  /** Embedding model (e.g. nomic-embed-text / text-embedding-3-small). Empty = 语义检索走 char-bigram，不启用向量。 */
  embeddingModel: string;
  /** 独立的 embedding 服务地址协议/provider。为空则复用在对话配置上。
   *  支持「DeepSeek 对话 + Ollama 嵌入」：embedProvider/embedBaseUrl 指向嵌入服务。 */
  embedProvider?: "ollama" | "openai";
  embedBaseUrl?: string;
  embedApiKey?: string;
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
  /** In-flight user prompt (shown as a live bubble while running). */
  currentPrompt: string;
  /** Last run's model thinking / reasoning (collapsible "思考" block). */
  thinking: string;

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
      return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL, apiKey: "", embeddingModel: "", embedProvider: undefined, embedBaseUrl: "", embedApiKey: "" };
    }
    const c = JSON.parse(raw);
    const provider: "ollama" | "openai" = c.provider === "openai" ? "openai" : "ollama";
    return {
      enabled: !!c.enabled,
      provider,
      baseUrl: String(c.baseUrl || (provider === "openai" ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL)),
      model: String(c.model || (provider === "openai" ? OPENAI_COMPAT_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL)),
      apiKey: String(c.apiKey ?? ""),
      embeddingModel: String(c.embeddingModel ?? ""),
      embedProvider: c.embedProvider === "openai" ? "openai" : c.embedProvider === "ollama" ? "ollama" : undefined,
      embedBaseUrl: String(c.embedBaseUrl ?? ""),
      embedApiKey: String(c.embedApiKey ?? ""),
    };
  } catch {
    return { enabled: false, provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL, apiKey: "", embeddingModel: "", embedProvider: undefined, embedBaseUrl: "", embedApiKey: "" };
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
  currentPrompt: "",
  thinking: "",

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
      set({ error: "AI 功能未启用，请先在设置中开启并配置模型。" });
      useRightPanel.getState().openAi(true);
      return;
    }
    // 用量统计（不拦截）：AI 推理由用户自带的模型端点承担成本，我们不限制
    // 用户使用自己的密钥。将来若提供托管推理，再由 ENFORCE_QUOTA 打开门槛。
    if (!useEntitlements.getState().consume("draft" as Aicap)) {
      const label = capLabel("draft");
      set({ error: `${label}暂时不可用，请稍后再试。` });
      return;
    }
    const notes = useNotes.getState();
    const allPages = notes.pages.map((p) => ({ id: p.id, title: p.title, parent_id: p.parent_id }));
    const seq = ++runSeq;
    // Fresh thinking buffer at the start of every run.
    set({ running: true, error: null, currentPrompt: trimmed, thinking: "" });

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
    // Live-stream the model's thinking/reasoning the same way, so the "已深度思考"
    // block grows while the model is still thinking (not only after completion).
    let thinkBuf = "";
    let thinkTimer: number | null = null;
    const flushThinking = () => {
      thinkTimer = null;
      if (thinkBuf) {
        const chunk = thinkBuf;
        thinkBuf = "";
        set((s) => ({ thinking: s.thinking + chunk }));
      }
    };
    const onThinking = (t: string) => {
      thinkBuf += t;
      if (thinkTimer === null) thinkTimer = window.setTimeout(flushThinking, 40);
    };

    try {
      const transport = IS_WEB
        ? createProviderTransport(config as ProviderConfig)
        : createBackendStreamingTransport(config as ProviderConfig);
      const result: AiRunResult = await runAiLoop(
        trimmed,
        allPages.map((p) => ({ id: p.id, title: p.title })),
        { currentPageId: notes.currentId, allPages },
        { transport, history: get().history, onDelta, onThinking },
      );
      // A newer run() or a stop() invalidates this result (stale discard).
      if (seq !== runSeq) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      buffered = "";
      if (thinkTimer !== null) clearTimeout(thinkTimer);
      thinkTimer = null;
      thinkBuf = "";
      // Keep existing drafts, replace reply/error with the fresh run; keep the
      // last assistant reply in history so follow-ups ("再详细点") stay in context.
      const history = [...get().history, { role: "user" as const, content: trimmed }];
      if (result.reply) history.push({ role: "assistant" as const, content: result.reply });
      const historyCapped = result.ok ? history.slice(-HISTORY_LIMIT) : get().history;
      saveHistory(historyCapped);
      // A run that yields neither a reply nor a pending draft is a silent dead-end
      // (e.g. the endpoint ignored streaming / returned empty). Surface it so the
      // user isn't left staring at an unanswered bubble.
      const emptyReply = result.ok && !result.reply && result.drafts.length === 0;
      set({
        running: false,
        reply: result.reply,
        drafts: result.drafts.length ? result.drafts : get().drafts,
        error: result.ok
          ? emptyReply
            ? "模型没有返回内容。请确认模型名/服务地址正确（可在设置里点「测试连接」），或该端点是否支持你当前使用的接入方式。"
            : null
          : result.error ?? null,
        history: historyCapped,
        activity: result.activity ?? [],
        currentPrompt: "",
        // Prefer the transport's complete thinking; fall back to what we streamed.
        thinking: result.thinking || get().thinking,
      });
    } catch (e) {
      if (seq !== runSeq) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      buffered = "";
      set({ running: false, error: String((e as Error)?.message ?? e), currentPrompt: "" });
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
          // The live Lexical editor keeps its own state, so an externally-applied
          // change (e.g. AI append) wouldn't show on the current page. Bumping the
          // reload tick remounts the editor, re-parsing the updated content.
          notes.bumpReload();
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
    set({ reply: "", drafts: [], error: null, history: [], activity: [], currentPrompt: "", thinking: "" });
  },
  resetError: () => set({ error: null }),
}));
