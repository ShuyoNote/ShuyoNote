// Mobile WebView shell bridge (M16.5): a native WebView injects this on `window`
// (e.g. `window.__SHUYONOTE_MOBILE__`) to expose capabilities a plain browser
// lacks — opening external URLs in the OS app switcher, resolving asset paths,
// and reading real file bytes. When absent, `web.ts` falls back to browser-native
// equivalents, so the same bundle runs on a normal browser AND in the mobile shell.
//
// The bridge is best-effort and optional: the WebView shell provides it; a plain
// browser doesn't. Keep every method optional so the app degrades gracefully.

export interface MobileBridge {
  /** Open an external URL in the host OS (dedicated browser / app). */
  openUrl?(url: string): Promise<void>;
  /** Rewrite a content-addressed asset path to a URL the WebView can load. */
  convertFileSrc?(path: string): string;
  /** Read bytes of an attachment by its id/hash (returns base64). */
  readAttachmentBytes?(id: string): Promise<string>;
  /** Save bytes (base64) to the platform share/save dialog. Returns a path or null. */
  saveBytes?(fileName: string, base64: string): Promise<string | null>;
}

const BRIDGE_KEY = "__SHUYONOTE_MOBILE__";

/** Detect the mobile shell bridge if the host injected it. */
export function getMobileBridge(): MobileBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as Record<string, unknown>)[BRIDGE_KEY];
  return (b && typeof b === "object" ? b : null) as MobileBridge | null;
}
