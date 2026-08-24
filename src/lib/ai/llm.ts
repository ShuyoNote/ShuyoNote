// LLM transport. This module is intentionally transport-only: it knows how to
// talk to a model endpoint and return the raw assistant message, and how to
// parse a canonical "tool call" block out of that message. The conversation
// loop + whitelist enforcement live in host.ts, so a smoke test can swap in a
// fake transport and never touch the network.

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

// ---- Ollama chat transport (default, local, model-of-your-choice) ----
export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:7b";
export const OLLAMA_DEFAULT_NUM_CTX = 8192;

export function createOllamaTransport(baseUrl = OLLAMA_DEFAULT_URL, model = OLLAMA_DEFAULT_MODEL): LlmTransport {
  return {
    async complete(messages, opts = {}) {
      let resp: Response;
      try {
        resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
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
        });
      } catch (e) {
        throw new Error(describeFetchError(e, baseUrl));
      }
      if (!resp.ok) {
        throw new Error(`Ollama 请求失败 (${resp.status})，请确认本地模型服务已启动、地址正确。`);
      }
      const data = await resp.json();
      const content = typeof data?.message?.content === "string" ? data.message.content : "";
      const nativeToolCalls = (data?.message?.tool_calls ?? [])
        .map((tc: any) => ({
          name: tc?.function?.name ?? tc?.name ?? "",
          arguments: tc?.function?.arguments ?? tc?.arguments ?? {},
        }))
        .filter((tc: any) => tc.name);
      return { content, nativeToolCalls: nativeToolCalls.length ? nativeToolCalls : undefined };
    },
  };
}

/** Human-readable message for a failed network fetch (down server / CORS). */
export function describeFetchError(e: unknown, baseUrl: string): string {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed")) {
    return `无法连接到 ${baseUrl}。请确认本地 Ollama 已运行（ollama serve），且地址正确。`;
  }
  if (msg.includes("cors") || msg.includes("origin")) {
    return `浏览器阻止了跨域请求（CORS）。请设置 OLLAMA_ORIGINS=* 后重启 Ollama，或使用应用同源的代理。`;
  }
  return `连接失败：${String((e as Error)?.message ?? e)}`;
}

// ---- Connection test (settings "测试连接" button) ----

export interface OllamaConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Ping the Ollama server (`/api/tags`) and report reachability + installed models.
 *  Used so the user can tell immediately whether the endpoint/model is usable —
 *  the most common reason "AI settings seem not to take effect". */
export async function testOllamaConnection(
  baseUrl = OLLAMA_DEFAULT_URL,
  model = OLLAMA_DEFAULT_MODEL,
  timeoutMs = 6000,
): Promise<OllamaConnectionResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  let resp: Response;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    resp = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    const timeout = String((e as Error)?.message ?? "").toLowerCase().includes("abort");
    return {
      ok: false,
      message: timeout
        ? `连接 ${baseUrl} 超时（${timeoutMs / 1000}s）。请确认本地 Ollama 已启动。`
        : describeFetchError(e, baseUrl),
    };
  }
  if (!resp.ok) {
    return { ok: false, message: `Ollama 服务响应异常 (${resp.status})。` };
  }
  try {
    const data = await resp.json();
    const models: string[] = (data?.models ?? []).map((m: any) => String(m?.name ?? "")).filter(Boolean);
    const installed = models.length > 0;
    const found = !model ? null : models.find((n) => n === model || n.startsWith(`${model}:`));
    const message = !installed
      ? `服务可达，但尚未安装任何模型。请在终端运行：ollama pull ${model}`
      : found
        ? `连接成功。模型「${model}」已安装（共 ${models.length} 个）。`
        : `连接成功（共 ${models.length} 个模型），但「${model}」不在其中。可用：${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`;
    return { ok: true, message, models };
  } catch {
    return { ok: false, message: "服务可达，但返回内容无法解析（可能不是 Ollama 端点）。" };
  }
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
