// Restricted host loop. This is the thin-agent core: it runs the LLM against the
// ShuyoNote semantic command layer through the whitelisted tools, never exposing
// shell, arbitrary files, or general network. Writes are NEVER committed here —
// they surface as drafts the user must confirm.

import { buildSystemPrompt, aiTools, getAiTool } from "./tools";
import { extractToolCalls, toolResultsPrompt, toLlmMessages } from "./llm";
import type { LlmTransport } from "./llm";
import type { AiMessage, AiRunResult, AiTool, AiToolCall } from "./types";

export interface HostOptions {
  transport: LlmTransport;
  /** Cap on model turns per user prompt (avoids runaway loops). */
  maxSteps?: number;
  /** Cap on accumulated drafts before we force a stop. */
  maxDrafts?: number;
  /** Prior user/assistant turns to seed the conversation (multi-turn context). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_DRAFTS = 20;

/** Normalize a native tool call + validate against the whitelist. */
function whitelistCall(raw: { name: string; arguments: unknown }): AiToolCall | null {
  const name = String(raw?.name ?? "").trim();
  const tool = getAiTool(name);
  if (!tool) return null;
  const args = (raw?.arguments ?? {}) as Record<string, unknown>;
  return { id: `call-${Math.random().toString(36).slice(2, 10)}`, name, args };
}

/** Keep only args keys declared in the tool's argsSchema (prunes hallucinated keys). */
function filterArgs(args: Record<string, unknown>, tool: AiTool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (tool.argsSchema as any)?.properties ?? {};
  for (const k of Object.keys(props)) {
    if (k in args) out[k] = args[k];
  }
  return out;
}

function toolSchema(tool: AiTool): Record<string, unknown> {
  return { type: "function", function: { name: tool.id, description: tool.description, parameters: tool.argsSchema } };
}

export async function runAiLoop(
  userPrompt: string,
  pages: Array<{ id: string; title: string }>,
  ctx: { currentPageId: string | null; allPages: Array<{ id: string; title: string; parent_id: string | null }> },
  opts: HostOptions,
): Promise<AiRunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxDrafts = opts.maxDrafts ?? DEFAULT_MAX_DRAFTS;

  const messages: AiMessage[] = [{ role: "system", content: buildSystemPrompt({ pages }) }];
  // Seed prior conversation turns so follow-ups ("再详细点") have context.
  for (const h of opts.history ?? []) {
    messages.push({ role: h.role, content: h.content });
  }
  const drafts = new Map<string, { key: string; summary: string; payload: unknown }>();
  const errors: string[] = [];
  let assistantText = "";
  let prevToolResults: AiMessage[] = [];

  for (let step = 0; step < maxSteps; step++) {
    // 1. Ask the model (first turn = the real prompt; later = a continuation nudge
    //    that carries the prior tool results inline).
    if (step === 0) {
      messages.push({ role: "user", content: userPrompt });
    } else {
      const nudge =
        `继续。上一步工具结果如下：\n\n${toolResultsPrompt(prevToolResults)}\n\n` +
        `如需调用工具请输出 <tool_calls> 块；否则给出最终答复。`;
      messages.push({ role: "user", content: nudge });
    }

    // 2. Call the model.
    let llm: { content: string; nativeToolCalls?: Array<{ name: string; arguments: unknown }> };
    try {
      llm = await opts.transport.complete(toLlmMessages(messages), {
        tools: aiTools.map((t) => toolSchema(t)),
      });
    } catch (e) {
      errors.push(String((e as Error)?.message ?? e));
      break;
    }

    const content = String(llm?.content ?? "");
    if (content) assistantText = content;

    // 3. Resolve calls: prefer native tool-calling, else parse the text fence.
    const native = (llm?.nativeToolCalls ?? []).map(whitelistCall).filter(Boolean) as AiToolCall[];
    const textCalls = extractToolCalls(content).map(whitelistCall).filter(Boolean) as AiToolCall[];
    const calls = native.length ? native : textCalls;

    if (calls.length === 0) {
      break; // Final answer; nothing more to do.
    }

    // 4. Execute the calls. Reads run immediately; writes accumulate as drafts.
    const toolResults: AiMessage[] = [];
    let stopped = false;
    for (const call of calls) {
      const tool = getAiTool(call.name);
      if (!tool) {
        toolResults.push({ role: "tool", toolId: call.name, toolCallId: call.id, content: "未知工具", isError: true });
        continue;
      }
      const safeArgs = filterArgs(call.args, tool);
      let raw: unknown;
      try {
        raw = await tool.run(safeArgs, { currentPageId: ctx.currentPageId, pages: ctx.allPages });
      } catch (e) {
        raw = { ok: false, error: String((e as Error)?.message ?? e) };
      }

      if (tool.isWrite && raw && typeof raw === "object" && (raw as any).draft === true) {
        const d = raw as { key: string; summary: string; payload: unknown };
        if (!drafts.has(d.key)) drafts.set(d.key, { key: d.key, summary: d.summary, payload: d.payload });
        toolResults.push({
          role: "tool",
          toolId: tool.id,
          toolCallId: call.id,
          content: JSON.stringify({ drafted: true, summary: d.summary, pending_confirmation: true }),
        });
      } else {
        const isErr = typeof raw === "object" && !!raw ? (raw as any)?.ok === false : false;
        toolResults.push({ role: "tool", toolId: tool.id, toolCallId: call.id, content: JSON.stringify(raw), isError: isErr });
      }

      if (drafts.size >= maxDrafts) {
        stopped = true;
        break;
      }
    }

    messages.push({ role: "assistant", content });
    for (const r of toolResults) messages.push(r);
    prevToolResults = toolResults;

    if (stopped) break;
  }

  return {
    ok: errors.length === 0,
    reply: assistantText.trim(),
    drafts: Array.from(drafts.values()),
    error: errors[0],
  };
}
