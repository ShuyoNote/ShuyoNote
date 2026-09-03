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
  /** When set, the transport streams content deltas to this callback as they arrive. */
  onDelta?: (text: string) => void;
  /** When set, the transport streams model thinking/reasoning deltas as they arrive. */
  onThinking?: (text: string) => void;
}

export interface LlmResult {
  content: string;
  /** Vendor-native tool calls when the endpoint speaks a tool-calling protocol. */
  nativeToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Model "thinking" / reasoning chain (e.g. DeepSeek-R1 reasoning_content). */
  thinking?: string;
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

/** 预设服务商（缺省配置）。国产优先，尤其 DeepSeek。选预设自动填 地址/模型/协议/是否需 Key。 */
export interface AiPreset {
  id: string;
  name: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** 是否需要 API Key（Ollama 本地无需；云端需）。 */
  needsKey: boolean;
  /** 是否国产（用于排序/标记）。 */
  domestic?: boolean;
}
export const AI_PRESETS: AiPreset[] = [
  { id: "deepseek", name: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", needsKey: true, domestic: true },
  { id: "ollama", name: "Ollama（本地）", provider: "ollama", baseUrl: OLLAMA_DEFAULT_URL, model: OLLAMA_DEFAULT_MODEL, needsKey: false, domestic: true },
  { id: "zhipu", name: "智谱 GLM", provider: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", needsKey: true, domestic: true },
  { id: "qwen", name: "阿里 通义 Qwen", provider: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", needsKey: true, domestic: true },
  { id: "kimi", name: "月之暗面 Kimi", provider: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", needsKey: true, domestic: true },
  { id: "siliconflow", name: "硅基流动", provider: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", needsKey: true, domestic: true },
  { id: "openai", name: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true },
];

// Default max output tokens. Reasoning models (DeepSeek V3.1/R1-style) consume a
// large share of this budget on `reasoning_content` before emitting `content`; a
// too-small cap (e.g. 512) gets exhausted during thinking and the answer is
// truncated away. 8192 leaves room for reasoning + answer.
export const DEFAULT_MAX_TOKENS = 8192;

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

interface StreamChunk {
  content?: string;
  thinking?: string;
  toolCalls?: any[];
  finishReason?: string;
}

/** Extract content/thinking/tool_calls from EITHER a STREAMED delta chunk
 *  (`choices[0].delta`) OR a COMPLETED message JSON (`choices[0].message`), and
 *  from Ollama's `message.content`/`response` shape. This lets us tolerate
 *  endpoints that ignore `stream:true` and return a plain JSON completion, or
 *  stream bare NDJSON lines instead of SSE `data:` frames. */
function extractFromJson(j: any): StreamChunk {
  const choice = j?.choices?.[0] ?? {};
  const delta = choice?.delta ?? {};
  const msg = choice?.message ?? {};
  const content =
    typeof delta?.content === "string" ? delta.content :
    typeof msg?.content === "string" ? msg.content :
    typeof j?.message?.content === "string" ? j.message.content :
    typeof j?.content === "string" ? j.content :
    typeof j?.response === "string" ? j.response : "";
  const thinking =
    typeof delta?.reasoning_content === "string" ? delta.reasoning_content :
    typeof msg?.reasoning_content === "string" ? msg.reasoning_content :
    typeof j?.message?.reasoning_content === "string" ? j.message.reasoning_content :
    typeof j?.reasoning_content === "string" ? j.reasoning_content : "";
  const toolCalls =
    (Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined) ||
    (Array.isArray(msg?.tool_calls) ? msg.tool_calls : undefined) ||
    (Array.isArray(j?.message?.tool_calls) ? j.message.tool_calls : undefined) ||
    (Array.isArray(j?.tool_calls) ? j.tool_calls : undefined);
  const finishReason = choice?.finish_reason ?? j?.finish_reason ?? null;
  return { content, thinking, toolCalls, finishReason };
}

// Ollama /api/chat streams NDJSON or SSE: {"message":{"content":"token"}} … {"message":{"tool_calls":[...]},"done":true}.
function ollamaLineChunk(line: string): StreamChunk {
  let payload = line.trim();
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (!payload || payload === "[DONE]") return { content: "" };
  try {
    return extractFromJson(JSON.parse(payload));
  } catch {
    return { content: "" };
  }
}

// OpenAI-compatible SSE (`data: {...}`, `data: [DONE]`) or bare NDJSON frames.
// tool_calls arrive incrementally (delta.tool_calls[i].function.arguments concatenated).
function openaiLineChunk(line: string): StreamChunk {
  let payload = line.trim();
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (!payload || payload === "[DONE]") return { content: "" };
  try {
    return extractFromJson(JSON.parse(payload));
  } catch {
    return { content: "" };
  }
}

/** Read a streaming body, streaming content deltas to onDelta AND capturing any
 *  tool_calls so the host loop can still execute writes during streaming. Handles
 *  SSE (`data:`), bare NDJSON, and a single JSON completion with no newline. */
async function readBodyStream(
  resp: Response,
  chunk: (line: string) => StreamChunk,
  onDelta: (text: string) => void,
  onThinking?: (text: string) => void,
): Promise<{ content: string; nativeToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined; thinking: string }> {
  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  let raw = "";
  let content = "";
  let thinking = "";
  let lastFinishReason: string | undefined;
  // tool_calls arrive either as a full array (Ollama, final) or fragmented by
  // index (OpenAI, delta.tool_calls). Accumulate the OpenAI fragments by index.
  const tcByIdx: Record<number, { name: string; args: string }> = {};
  let direct: Array<{ name: string; arguments: unknown }> = [];

  const absorb = (toolCalls: any[]) => {
    if (toolCalls.length === 0) return;
    if (toolCalls[0]?.index !== undefined) {
      // OpenAI incremental fragments (delta.tool_calls[i])
      for (const tc of toolCalls) {
        const idx = tc.index ?? 0;
        const cur = tcByIdx[idx] ?? { name: "", args: "" };
        if (tc?.function?.name) cur.name = tc.function.name;
        if (typeof tc?.function?.arguments === "string") cur.args += tc.function.arguments;
        tcByIdx[idx] = cur;
      }
    } else {
      // Ollama full array (replace any accumulated fragments)
      direct = toolCalls
        .map((tc) => ({ name: tc?.function?.name ?? tc?.name ?? "", arguments: tc?.function?.arguments ?? tc?.arguments }))
        .filter((t) => t.name);
    }
  };

  // Idle-timeout each read so a stream that stalls after the headers can never
  // hold the AI in "running" forever — it surfaces an error instead.
  const READ_TIMEOUT_MS = 90000;
  const readOnce = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error("AI 响应超时（90 秒无数据）。请重试，或检查该模型端点是否支持流式。")), READ_TIMEOUT_MS);
    });
    return Promise.race([reader.read(), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

  for (;;) {
    const res = await readOnce();
    const { done, value } = res;
    if (done) break;
    const text = dec.decode(value, { stream: true });
    raw += text;
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const c = chunk(line);
      if (c.content) {
        content += c.content;
        onDelta(c.content);
      }
      if (c.thinking) {
        thinking += c.thinking;
        onThinking?.(c.thinking);
      }
      if (c.toolCalls) absorb(c.toolCalls);
      if (c.finishReason) lastFinishReason = c.finishReason;
    }
  }
  // A JSON completion sent WITHOUT a trailing newline stays in `buf`; parse it.
  if (buf.trim()) {
    const c = chunk(buf.trim());
    if (c.content) {
      content += c.content;
      onDelta(c.content);
    }
    if (c.thinking) {
      thinking += c.thinking;
      onThinking?.(c.thinking);
    }
    if (c.toolCalls) absorb(c.toolCalls);
    if (c.finishReason) lastFinishReason = c.finishReason;
  }
  // Some gateways return an error as HTTP 200 with an `error` field; others return
  // an empty completion. Either way, never return a silent empty (no-reply) result:
  // surface the raw response so the failure is diagnosable.
  let nativeToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined;
  if (direct.length) {
    nativeToolCalls = direct.map((t) => ({ name: t.name, arguments: parseToolArgs(t.arguments) }));
  } else {
    const frags = Object.values(tcByIdx).filter((t) => t.name).map((t) => ({ name: t.name, arguments: parseToolArgs(t.args) }));
    if (frags.length) nativeToolCalls = frags;
  }
  if (!content && !nativeToolCalls && raw.trim()) {
    const body = raw.trim();
    // Diagnostics: log the raw body (truncated) so the exact endpoint reply is
    // visible in the browser console for troubleshooting.
    console.warn("[ShuyoNote] AI 未返回内容，原始响应：", body.slice(0, 1200));
    try {
      const j = JSON.parse(body);
      if (j && j.error) {
        const msg = typeof j.error?.message === "string" ? j.error.message : JSON.stringify(j.error);
        throw new Error(`AI 接口返回错误：${msg}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("AI 接口返回错误")) throw e;
    }
    if (lastFinishReason === "length") {
      throw new Error("模型输出达到长度上限（max_tokens）时被截断，未产出最终回答。请调大模型的最大输出长度后重试。");
    }
    throw new Error(`模型未返回内容。响应片段：${body.slice(0, 400)}`);
  }
  return { content, nativeToolCalls, thinking };
}

function isStreaming(opts: LlmOptions): opts is LlmOptions & { onDelta: (text: string) => void } {
  return typeof opts?.onDelta === "function";
}

// ---- Ollama chat transport ----
export function createOllamaTransport(baseUrl = OLLAMA_DEFAULT_URL, model = OLLAMA_DEFAULT_MODEL): LlmTransport {
  return {
    async complete(messages, opts = {}) {
      const url = `${baseUrlOf(baseUrl)}/api/chat`;
      const streaming = isStreaming(opts);
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
              stream: streaming,
              tools: opts.tools as any[] | undefined,
              options: {
                num_ctx: OLLAMA_DEFAULT_NUM_CTX,
                temperature: opts.temperature ?? 0.7,
                num_predict: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
              },
            }),
          },
          120000,
        );
      } catch (e) {
        throw new Error(describeFetchError(e, baseUrl));
      }
      if (!resp.ok) throw new Error(`Ollama 请求失败 (${resp.status})，请确认本地模型服务已启动、地址正确。`);      if (streaming) {
        const { content, nativeToolCalls, thinking } = await readBodyStream(resp, ollamaLineChunk, opts.onDelta, opts.onThinking);
        return { content, nativeToolCalls, thinking };
      }
      const data = await resp.json();
      return {
        content: typeof data?.message?.content === "string" ? data.message.content : "",
        nativeToolCalls: toNativeToolCalls(data?.message?.tool_calls),
        thinking: typeof data?.message?.reasoning_content === "string" ? data.message.reasoning_content : undefined,
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
      const streaming = isStreaming(opts);
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
              stream: streaming,
              tools: opts.tools as any[] | undefined,
              temperature: opts.temperature ?? 0.7,
              max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
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
          const text = await resp.text();
          if (text) console.warn("[ShuyoNote] AI 请求失败响应体：", text.slice(0, 1200));
          const j = JSON.parse(text);
          detail = j?.error?.message ? `：${j.error.message}` : text ? `：${text.slice(0, 200)}` : "";
        } catch {
          /* ignore body parse */
        }
        throw new Error(`OpenAI 兼容接口请求失败 (${resp.status})${detail}`);
      }
      if (streaming) {
        const { content, nativeToolCalls, thinking } = await readBodyStream(resp, openaiLineChunk, opts.onDelta, opts.onThinking);
        return { content, nativeToolCalls, thinking };
      }
      const data = await resp.json();
      const msg = data?.choices?.[0]?.message ?? {};
      return {
        content: typeof msg?.content === "string" ? msg.content : "",
        nativeToolCalls: toNativeToolCalls(msg?.tool_calls),
        thinking: typeof msg?.reasoning_content === "string" ? msg.reasoning_content : undefined,
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
