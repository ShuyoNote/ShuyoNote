import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // prismjs is loaded as a plain global <script> in index.html (see that file);
  // mark it external so @lexical/code's `import "prismjs"` resolves to the
  // browser global `window.Prism` instead of being bundled into an ESM chunk
  // where its bare `Prism` references would be undefined at module eval.
  build: {
    rollupOptions: {
      external: ["prismjs", /prismjs\/components\/.*/],
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly: WebView2 connects via 127.0.0.1, and vite 7
    // defaults to IPv6 localhost (::1) which the WebView cannot reach.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
