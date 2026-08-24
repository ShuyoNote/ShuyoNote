// Platform-routed AI transport. The store uses THIS path so every LLM call goes
// through the semantic `api.aiComplete`/`api.aiProbe` commands:
//   - Desktop (Tauri): `ai_complete`/`ai_probe` are handled by the Rust backend,
//     which does the outbound HTTP request — bypassing browser/WebView2 CORS for
//     cloud LLMs (DeepSeek/OpenAI/…).
//   - Web: the web platform handler reuses the pure HTTP logic in llm.ts, so a
//     local Ollama works; cloud origins are subject to CORS (accepted limitation).
// The pure fetch-based transports in llm.ts remain for that web handler and tests.

import { api } from "../api";
import { parseToolArgs, type LlmTransport, type ProviderConfig, type ProviderProbe } from "./llm";

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
