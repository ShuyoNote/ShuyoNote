// Platform-routed AI transport. The store uses THIS path so every LLM call goes
// through the semantic `api.aiComplete`/`api.aiProbe` commands:
//   - Desktop (Tauri): `ai_complete`/`ai_probe` are handled by the Rust backend,
//     which does the outbound HTTP request — bypassing browser/WebView2 CORS for
//     cloud LLMs (DeepSeek/OpenAI/…).
//   - Web: the web platform handler reuses the pure HTTP logic in llm.ts, so a
//     local Ollama works; cloud origins are subject to CORS (accepted limitation).
// The pure fetch-based transports in llm.ts remain for that web handler and tests.

import { api } from "../api";
import { platform } from "../platform";
import { parseToolArgs, type LlmTransport, type ProviderConfig, type ProviderProbe } from "./llm";

let streamSeq = 0;

export function createApiTransport(config: ProviderConfig): LlmTransport {
  return {
    async complete(messages, opts = {}) {
      const r = await api.aiComplete({
        provider: config.provider,
        base_url: config.baseUrl,
        model: config.model,
        api_key: config.apiKey || undefined,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      });
      return {
        content: r?.content ?? "",
        nativeToolCalls: r?.native_tool_calls
          ? r.native_tool_calls.map((tc) => ({ name: tc.name, arguments: parseToolArgs(tc.arguments) }))
          : undefined,
      };
    },
  };
}

export async function probeApi(config: ProviderConfig): Promise<ProviderProbe> {
  const r = await api.aiProbe({
    provider: config.provider,
    base_url: config.baseUrl,
    model: config.model,
    api_key: config.apiKey || undefined,
  });
  return { ok: r?.ok ?? false, message: r?.message ?? "（无返回）", models: r?.models ?? [] };
}

/** Desktop streaming transport: streams via the Rust `ai_complete_stream` command,
 *  which emits per-run events (`ai-stream:{runId}`) that we subscribe to. Falls
 *  back to non-streaming `api.aiComplete` when no onDelta is provided. */
export function createBackendStreamingTransport(config: ProviderConfig): LlmTransport {
  return {
    async complete(messages, opts = {}) {
      if (!opts.onDelta) return createApiTransport(config).complete(messages, opts);

      const runId = `run-${++streamSeq}-${Date.now()}`;
      const evtName = `ai-stream:${runId}`;
      let content = "";
      let error: string | undefined;
      let toolCalls: Array<{ name: string; arguments: string }> | undefined;
      let doneResolve: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        doneResolve = resolve;
      });
      const unlisten = await platform.event.listen<{ delta?: string; done?: boolean; error?: string; toolCalls?: Array<{ name: string; arguments: string }> }>(evtName, (e) => {
        const p = e.payload;
        if (p?.done) {
          if (typeof p.error === "string" && p.error) error = p.error;
          if (Array.isArray(p.toolCalls) && p.toolCalls.length) toolCalls = p.toolCalls;
          doneResolve();
        } else if (typeof p?.delta === "string" && p.delta) {
          content += p.delta;
          opts.onDelta?.(p.delta);
        }
      });
      try {
        const args = {
          provider: config.provider,
          base_url: config.baseUrl,
          model: config.model,
          api_key: config.apiKey || undefined,
          messages,
          tools: opts.tools,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        };
        // If the invoke itself rejects (serialization failure, backend panic),
        // surface it as an error instead of leaving the UI "运行中" forever.
        api.aiCompleteStream(args, runId).catch((e) => {
          error = String(e);
          doneResolve();
        });
        await done;
      } finally {
        unlisten();
      }
      if (error) throw new Error(error);
      return {
        content,
        nativeToolCalls: toolCalls
          ? toolCalls.map((tc) => ({ name: tc.name, arguments: parseToolArgs(tc.arguments) }))
          : undefined,
      };
    },
  };
}
