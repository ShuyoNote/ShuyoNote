// M20.2+ — REAL vector-embedding semantic search (optional, local-first).
// Complements searchSemantic.ts (char-bigram fallback): when an embedding model is
// configured, caller embeds the query + candidates and adds a *bounded* vector
// bonus on top of the token-TF / char-bigram backbone. All network-failure paths
// fall back to the char-bigram ranking, so search never breaks.
//
// Everything here is pure & unit-testable except `embedText` (the single network
// call). Config is read straight from localStorage to avoid pulling the AI store
// into the platform layer (circular-import risk).

export interface EmbedConfig {
  provider: "ollama" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
}

const EMBED_CFG_KEY = "shuyonote.ai.config";

/** Read the persisted AI config and return embedding params, or null when the
 *  AI feature is disabled / no embedding model is set. */
export function readEmbedConfig(): EmbedConfig | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(EMBED_CFG_KEY) : null;
    if (!raw) return null;
    const c = JSON.parse(raw);
    const provider: "ollama" | "openai" = c.provider === "openai" ? "openai" : "ollama";
    const model = String(c.embeddingModel ?? "");
    if (!c.enabled || !model) return null;
    // 独立的 embedding 服务（支持 DeepSeek 对话 + Ollama 嵌入）：embedProvider /
    // embedBaseUrl 非空则用它；否则复用在对话配置上（兼容旧行为）。
    const ep = c.embedProvider;
    const eb = String(c.embedBaseUrl ?? "");
    const embedProvider: "ollama" | "openai" = ep === "openai" ? "openai" : ep === "ollama" ? "ollama" : provider;
    const baseUrl = eb || String(c.baseUrl ?? "");
    return {
      provider: embedProvider,
      baseUrl,
      apiKey: String(c.embedApiKey ?? c.apiKey ?? ""),
      model,
    };
  } catch {
    return null;
  }
}

/** L2-normalize a vector (cosine similarity == dot product on normalized vectors). */
export function normalizeVector(v: number[]): number[] {
  if (!Array.isArray(v) || v.length === 0) return [];
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

/** Cosine similarity (dot / (|a|·|b|)). 0 for empty or length-mismatched input. */
export function cosineSim(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm > 0 ? dot / norm : 0;
}

/** Rank docs by cosine similarity to a query vector (descending). Returns only
 *  positive-similarity hits with their score. */
export function vectorRank<T extends { id: string }>(
  queryVec: number[],
  docs: Array<{ id: T["id"]; vector: number[] }>,
): Array<{ id: T["id"]; score: number }> {
  if (!Array.isArray(queryVec) || queryVec.length === 0 || !Array.isArray(docs)) return [];
  return docs
    .map((d) => ({ id: d.id, score: cosineSim(queryVec, d.vector) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Embedding endpoint URL for a provider. */
export function embedUrl(baseUrl: string, provider: EmbedConfig["provider"]): string {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return "";
  return provider === "openai" ? `${base}/v1/embeddings` : `${base}/api/embed`;
}

/** Request body for an embedding call. */
export function embedBody(model: string, provider: EmbedConfig["provider"], input: string): Record<string, unknown> {
  const text = String(input ?? "");
  // Ollama /api/embed accepts a bare string; OpenAI /v1/embeddings wants an array.
  return provider === "openai" ? { model, input: [text] } : { model, input: text };
}

/** Parse the embedding vector out of a provider JSON response. Empty on failure. */
export function parseEmbedding(provider: EmbedConfig["provider"], json: unknown): number[] {
  const data = json as { data?: Array<{ embedding?: unknown }>; embeddings?: unknown };
  if (provider === "openai") {
    // { data: [{ embedding: number[], index }] }
    const first = Array.isArray(data?.data) ? data.data[0] : undefined;
    const vec = first?.embedding;
    return Array.isArray(vec) ? vec.map(Number) : [];
  }
  // Ollama /api/embed → { embeddings: number[][], model, ... }
  const list = Array.isArray(data?.embeddings) ? data.embeddings : undefined;
  const vec = Array.isArray(list) ? list[0] : undefined;
  return Array.isArray(vec) ? vec.map(Number) : [];
}

/** Embed one text via the provider. Returns null on any failure so the caller
 *  falls back to char-bigram ranking. */
export async function embedText(text: string, cfg: EmbedConfig): Promise<number[] | null> {
  try {
    const url = embedUrl(cfg.baseUrl, cfg.provider);
    if (!url) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(embedBody(cfg.model, cfg.provider, text)),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as unknown;
    const vec = parseEmbedding(cfg.provider, json);
    return vec.length > 0 ? vec : null;
  } catch {
    return null;
  }
}

/** Bounded bonus applied to a TF score for a positive embedding-hit. Kept small
 *  so the token-TF backbone stays dominant (mirrors SEMANTIC_BONUS in web.ts). */
export const VECTOR_BONUS = 3;

/** Max characters of content embedded for a page (keeps cache/cost bounded). */
export const EMBED_TEXT_CAP = 500;

/** The exact text sent to the embedding model for a page (title + capped content).
 *  Must match between cache-hash computation and the embed call, so a changed
 *  content produces a different hash and the cache invalidates. */
export function embeddingText(title: string, content: string): string {
  return `${String(title ?? "")} ${String(content ?? "").slice(0, EMBED_TEXT_CAP)}`;
}

/** Deterministic FNV-1a (32-bit) hash of a string, used to detect content drift
 *  so a changed page re-embeds once and then hits the cache. */
export function embedHash(text: string): string {
  const s = String(text ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
