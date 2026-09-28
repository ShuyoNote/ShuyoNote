// Thin-AI layer public types. Everything here crosses the tool boundary between
// the LLM host loop and the ShuyoNote semantic command layer (`src/lib/api.ts`).

// ⚠️ **只 import type**：`coverageReport` 是纯模块，但这里是"类型只在编译期存在"的位置 ——
//    用 `import type` 才能保证它**不进 AI 核心包**（那个包只装纯逻辑，见 `AiToolContext` 的注释）。
import type { CoverageStores } from "../extract/coverageReport";

/** A tool the model may call. Read tools execute immediately; write tools return
 *  a DraftResult that the host must hold for explicit user confirmation. */
export interface AiTool {
  /** Stable identifier used in tool calls —— 就是能力 id，例如 "pages.search"。 */
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
  /**
   * 派生层的那对 store（覆盖报告这类"要读全库派生层"的工具才需要）。
   *
   * ⚠️ **为什么是注入的、而不是工具自己去 `import { platform }`**：这一层（`ai/host` → `ai/tools`
   * → `capabilities/frontend`）会被 `smoke-web` 的 **AI 核心包**静态打包，而那个包**只装纯逻辑** ——
   * 一旦 import 平台门面，就会把 `platform/web.ts`（要 `sql.js` 的 `.wasm?url`）拖进去，
   * esbuild 在 node 侧打不出来（2026-09-18 在 `ai/lexical` 上踩过一次同样的坑，见 `scripts/smoke-web.mjs` 的注释）。
   * ⇒ 由**有平台的那一层**（`store/ai.ts`）传进来；没传 ⇒ 工具如实回"这个平台没有派生层存储"。
   */
  derivedStores?: () => Promise<CoverageStores>;
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
