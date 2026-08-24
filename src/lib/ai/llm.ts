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
      const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
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
      if (!resp.ok) {
        throw new Error(`Ollama 请求失败 (${resp.status})，请确认本地模型服务已启动。`);
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
