// 统一网络层（跨域请求）：桌面用 @tauri-apps/plugin-http（native，绕开 WebView CORS），
// Web 用全局 fetch。签名与全局 fetch 一致，便于替换各跨域调用点。
// 注意：仅用于「跨域网络请求」；app 内相对/asset/blob 资源仍走全局 fetch。

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 懒加载插件，避免 Web 构建（不含 @tauri-apps/plugin-http）报未打包模块。
let cached: Promise<typeof fetch> | null = null;

export async function coreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktop()) return fetch(input, init);
  if (!cached) {
    cached = import("@tauri-apps/plugin-http").then((m) => m.fetch as unknown as typeof fetch);
  }
  const nativeFetch = await cached;
  return nativeFetch(input, init);
}
