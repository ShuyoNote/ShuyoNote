import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Serve under a subpath (web build is hosted at /app/ on shuyo.cn; likewise
  // Tauri serves the frontendDist at its origin root). Relative base lets the
  // app's /assets/, manifest and icons resolve against the actual document
  // location instead of the host root, so deploying under /app/ keeps working.
  base: "./",

  // NOTE: mermaid 已改为静态 import（并入主 bundle）；不设 manualChunks 拆分，
  // 避免任何独立 chunk 在 Tauri/Web 正式版下因相对路径加载失败 → 布局引擎缺失
  // 导致 subgraph 叠成一整块（开发版好、正式版坏）。

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
