// Thin-AI layer public types. Everything here crosses the tool boundary between
// the LLM host loop and the ShuyoNote semantic command layer (`src/lib/api.ts`).

/** A tool the model may call. Read tools execute immediately; write tools return
 *  a DraftResult that the host must hold for explicit user confirmation. */
export interface AiTool {
  /** Stable identifier used in tool calls, e.g. "search_pages". */
  id: string;
  /** Short human/LLM-facing description (also fed to the model). */
  description: string;
  /** JSON Schema (subset) describing the call arguments. */
  argsSchema: Record<string, unknown>;
  /** Whether this tool mutates state (draft-gated). */
  isWrite: boolean;
  /** Execute the tool. Writes return a DraftResult (not yet committed). */
  run: (args: Record<string, unknown>, ctx: AiToolContext) => Promise<unknown>;
}

/** Context made available to every tool call. */
export interface AiToolContext {
  /** Current page id (from the editor) or null when on the home view. */
  currentPageId: string | null;
  /** All pages known to the running space (id → title). */
  pages: Array<{ id: string; title: string; parent_id: string | null }>;
}

/** Result of a write tool: a draft that must be confirmed before commit. */
export interface DraftResult {
  draft: true;
  /** Human-readable description of the pending mutation. */
  summary: string;
  /** A deterministic "accept" key so confirm only applies this draft. */
  key: string;
  /** Payload the consumer (apply layer) needs to commit the mutation. */
  payload: unknown;
}

/** The kind of message inside an assistant/LLM exchange. */
export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiMessage {
  role: AiRole;
  content: string;
  /** When role === "tool": the tool id this result belongs to. */
  toolId?: string;
  /** Tool call metadata echoed for the assistant to see a compact view. */
  toolCallId?: string;
  /** For read results: whether the result was an error. */
  isError?: boolean;
}

/** A tool invocation requested by the model. */
export interface AiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The one-shot result of running the host loop for a user prompt. */
export interface AiRunResult {
  ok: boolean;
  /** Final assistant text (may be empty if it ended on tool actions). */
  reply: string;
  /** Pending drafted writes that await user confirmation, empty if none. */
  drafts: Array<{ key: string; summary: string; payload: unknown }>;
  /** Any hard error surfaced to the UI. */
  error?: string;
  /** Tool calls performed this run (for transparency in the UI). */
  activity?: Array<{ tool: string; note: string }>;
  /** Model thinking / reasoning chain (e.g. DeepSeek-R1). */
  thinking?: string;
}
