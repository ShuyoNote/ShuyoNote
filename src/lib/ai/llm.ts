// LLM transport layer. Two vendor protocols are supported, both returning a
// neutral { content, nativeToolCalls? } so host.ts is provider-agnostic:
//   - Ollama           POST /api/chat        (GET /api/tags for the probe)
//   - OpenAI-compatible (DeepSeek/OpenAI/…)  POST {base}/v1/chat/completions
//                                              (GET {base}/v1/models for the probe)
// A settings "测试连接" probes the right endpoint, which is how a user tells
// whether a saved config actually works. This module is transport-only (mockable).

import type { AiMessage } from "./types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  /** Optional native tool-calling schema (vendor-specific); ignored by text fallback. */
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResult {
  content: string;
  /** Vendor-native tool calls when the endpoint speaks a tool-calling protocol. */
  nativeToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface LlmTransport {
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult>;
}

export type AiProvider = "ollama" | "openai";

export interface ProviderConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

// ---- Defaults ----
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:7b";
export const OLLAMA_DEFAULT_NUM_CTX = 8192;

export const OPENAI_COMPAT_DEFAULT_BASE = "https://api.deepseek.com";
export const OPENAI_COMPAT_DEFAULT_MODEL = "deepseek-chat";

// ---- small helpers ----
function baseUrlOf(u: string): string {
  return String(u ?? "").replace(/\/$/, "");
}

/** OpenAI-compatible endpoints are under /v1 unless the base already ends in it. */
function appendV1(base: string, path: string): string {
  const b = baseUrlOf(base);
  return b.endsWith("/v1") ? b + path : b + "/v1" + path;
}

/** Tool-call `arguments` may be an object (Ollama) or a JSON string (OpenAI). */
export function parseToolArgs(a: unknown): Record<string, unknown> {
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

function toNativeToolCalls(tcs: any[] | undefined): Array<{ name: string; arguments: Record<string, unknown> }> {
  return (tcs ?? [])
    .map((tc) => ({
      name: tc?.function?.name ?? tc?.name ?? "",
      arguments: parseToolArgs(tc?.function?.arguments ?? tc?.arguments),
    }))
    .filter((tc) => tc.name);
}

/** Human-readable message for a failed network fetch (down server / CORS). */
export function describeFetchError(e: unknown, baseUrl: string): string {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed")) {
    return `无法连接到 ${baseUrl}。请确认服务已启动且地址正确。`;
  }
  if (msg.includes("cors") || msg.includes("origin")) {
    return `浏览器或客户端拦截了跨域请求（CORS）。请将该服务加入允许来源，或使用同源代理。`;
  }
  return `连接失败：${String((e as Error)?.message ?? e)}`;
}

/** Wrap a fetch for a response, converting network errors to read Chinese messages. */
async function safeFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const timeout = String((e as Error)?.message ?? "").toLowerCase().includes("abort");
    if (timeout) throw new Error(`连接 ${url} 超时（${timeoutMs / 1000}s）。`);
    throw new Error(describeFetchError(e, url));
  } finally {
    clearTimeout(t);
  }
}

// ---- Ollama chat transport ----
export function createOllamaTransport(baseUrl = OLLAMA_DEFAULT_URL, model = OLLAMA_DEFAULT_MODEL): LlmTransport {
  return {
    async complete(messages, opts = {}) {
      const url = `${baseUrlOf(baseUrl)}/api/chat`;
      let resp: Response;
      try {
        resp = await safeFetch(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages,
              stream: false,
              options: {
                num_ctx: OLLAMA_DEFAULT_NUM_CTX,
                temperature: opts.temperature ?? 0.7,
                num_predict: opts.maxTokens ?? 512,
              },
            }),
          },
          120000,
        );
      } catch (e) {
        throw new Error(describeFetchError(e, baseUrl));
      }
      if (!resp.ok) throw new Error(`Ollama 请求失败 (${resp.status})，请确认本地模型服务已启动、地址正确。`);
      const data = await resp.json();
      return {
        content: typeof data?.message?.content === "string" ? data.message.content : "",
        nativeToolCalls: toNativeToolCalls(data?.message?.tool_calls),
      };
    },
  };
}

// ---- OpenAI-compatible chat transport (DeepSeek / OpenAI / …) ----
export function createOpenAICompatTransport(
  baseUrl = OPENAI_COMPAT_DEFAULT_BASE,
  model = OPENAI_COMPAT_DEFAULT_MODEL,
  apiKey?: string,
): LlmTransport {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return {
    async complete(messages, opts = {}) {
      const url = appendV1(baseUrl, "/chat/completions");
      let resp: Response;
      try {
        resp = await safeFetch(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages,
              stream: false,
              temperature: opts.temperature ?? 0.7,
              max_tokens: opts.maxTokens ?? 512,
            }),
          },
          120000,
        );
      } catch (e) {
        throw new Error(describeFetchError(e, baseUrl));
      }
      if (!resp.ok) {
        let detail = "";
        try {
          const j = await resp.json();
          detail = j?.error?.message ? `：${j.error.message}` : "";
        } catch {
          /* ignore body parse */
        }
        throw new Error(`OpenAI 兼容接口请求失败 (${resp.status})${detail}`);
      }
      const data = await resp.json();
      const msg = data?.choices?.[0]?.message ?? {};
      return {
        content: typeof msg?.content === "string" ? msg.content : "",
        nativeToolCalls: toNativeToolCalls(msg?.tool_calls),
      };
    },
  };
}

/** Build a transport from a provider config. */
export function createProviderTransport(config: ProviderConfig): LlmTransport {
  if (config.provider === "openai") {
    return createOpenAICompatTransport(config.baseUrl, config.model, config.apiKey);
  }
  return createOllamaTransport(config.baseUrl, config.model);
}

// ---- Canonical tool-call framing (text fallback for any model) ----

const TOOL_CALL_RE = /<tool_calls>([\s\S]*?)<\/tool_calls>/i;
const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Extract a tool-call block from assistant text. Supports either the explicit
 *  <tool_calls> fence or a ```json fenced block containing an array of calls. */
export function extractToolCalls(text: string): ParsedToolCall[] {
  if (!text) return [];
  let body: string | null = null;
  const fence = text.match(TOOL_CALL_RE);
  if (fence) {
    body = fence[1].trim();
  } else {
    const jb = text.match(JSON_BLOCK_RE);
    if (jb) body = jb[1].trim();
  }
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .map((c: any) => ({
        name: String(c?.name ?? c?.tool ?? ""),
        arguments: (c?.arguments ?? c?.args ?? {}) as Record<string, unknown>,
      }))
      .filter((c) => c.name);
  } catch {
    return [];
  }
}

/** Build the "tool results" block to feed back to the model. */
export function toolResultsPrompt(results: AiMessage[]): string {
  if (results.length === 0) return "(无工具结果)";
  return results.map((r) => `[${r.toolId ?? "tool"}]\n${r.content}`).join("\n\n");
}

/** Render a user-facing conversation message into an LlmMessage (drops tool
 *  metadata the transport cannot send). */
export function toLlmMessages(msgs: AiMessage[]): LlmMessage[] {
  return msgs
    .filter((m) => m.role !== "tool")
    .map((m) => ({ role: m.role as LlmMessage["role"], content: m.content }));
}

// ---- Connection probes (settings "测试连接") ----

export interface ProviderProbe {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Probe an Ollama server: GET /api/tags. */
export async function testOllamaConnection(
  baseUrl = OLLAMA_DEFAULT_URL,
  model = OLLAMA_DEFAULT_MODEL,
  timeoutMs = 6000,
): Promise<ProviderProbe> {
  let resp: Response;
  try {
    resp = await safeFetch(`${baseUrlOf(baseUrl)}/api/tags`, { method: "GET" }, timeoutMs);
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
  if (!resp.ok) return { ok: false, message: `Ollama 服务响应异常 (${resp.status})。` };
  try {
    const data = await resp.json();
    const models: string[] = (data?.models ?? []).map((m: any) => String(m?.name ?? "")).filter(Boolean);
    return ollamaProbeMessage(models, model, "Ollama");
  } catch {
    return { ok: false, message: "服务可达，但返回内容无法解析（可能不是 Ollama 端点）。" };
  }
}

/** Probe an OpenAI-compatible server: GET /v1/models with Bearer auth. */
export async function testOpenAICompatConnection(
  baseUrl = OPENAI_COMPAT_DEFAULT_BASE,
  model = OPENAI_COMPAT_DEFAULT_MODEL,
  apiKey?: string,
  timeoutMs = 6000,
): Promise<ProviderProbe> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  let resp: Response;
  try {
    resp = await safeFetch(appendV1(baseUrl, "/models"), { method: "GET", headers }, timeoutMs);
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, message: "鉴权失败（401/403）：请检查 API Key 是否正确。" };
  }
  if (!resp.ok) return { ok: false, message: `OpenAI 兼容接口响应异常 (${resp.status})。` };
  try {
    const data = await resp.json();
    const models: string[] = (data?.data ?? []).map((m: any) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
    return ollamaProbeMessage(models, model, "服务");
  } catch {
    return { ok: false, message: "服务可达，但返回内容无法解析（可能不是 OpenAI 兼容端点）。" };
  }
}

function ollamaProbeMessage(models: string[], model: string, label: string): ProviderProbe {
  const installed = models.length > 0;
  const found = !model ? null : models.find((n) => n === model || n.startsWith(`${model}`));
  const message = !installed
    ? `连接成功，但未发现任何可用模型。请${label === "Ollama" ? "先运行 ollama pull " + model : "确认真实模型名"}。`
    : found
      ? `连接成功。模型「${model}」已可用（共 ${models.length} 个）。`
      : `连接成功（共 ${models.length} 个模型），但「${model}」不在其中。可用：${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`;
  return { ok: true, message, models };
}

/** Probe whatever provider the config points at. */
export function testProviderConnection(config: ProviderConfig, timeoutMs = 6000): Promise<ProviderProbe> {
  if (config.provider === "openai") {
    return testOpenAICompatConnection(config.baseUrl, config.model, config.apiKey, timeoutMs);
  }
  return testOllamaConnection(config.baseUrl, config.model, timeoutMs);
}
