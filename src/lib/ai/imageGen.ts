// M-C — pure helpers for AI image generation (OpenAI-compatible /images/generations).
// Kept free of fetch/api/platform imports so the smoke harness can bundle them. The
// actual network call + attachment save live in the slash-menu action.

export interface ImageGenConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** OpenAI-compatible `/images/generations` endpoint URL. */
export function buildImageGenUrl(baseUrl: string): string {
  return String(baseUrl ?? "").replace(/\/+$/, "") + "/images/generations";
}

/** JSON request body for a text-to-image generation. */
export function buildImageGenBody(cfg: ImageGenConfig, prompt: string, size = "1024x1024"): string {
  return JSON.stringify({
    model: cfg.model,
    prompt: String(prompt ?? ""),
    n: 1,
    size,
    response_format: "b64_json",
  });
}

export type ImageGenPayload = { mime: string; b64: string } | { mime: string; url: string };

/** Parse a `/images/generations` response into a base64 image or a URL. */
export function parseImageGenResponse(text: string): ImageGenPayload | null {
  try {
    const j = JSON.parse(text || "{}");
    const item = Array.isArray(j?.data) ? j.data[0] : null;
    if (!item) return null;
    if (typeof item?.b64_json === "string" && item.b64_json) {
      return { mime: "image/png", b64: item.b64_json };
    }
    if (typeof item?.url === "string" && item.url) {
      return { mime: "image/png", url: item.url };
    }
    return null;
  } catch {
    return null;
  }
}

/** Decode a base64 string into bytes (browser-safe, no Buffer). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Turn bytes into a data-URL (display fallback for the image block). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
