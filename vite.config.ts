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

  // Mermaid 不拆分：动态 import("mermaid") 默认被打成 mermaid.core/parser 等多个
  // chunk，发布版(Tauri build)部分 chunk 加载不完整会让 diagram/布局引擎缺失 →
  // 图能出但 subgraph 布局乱（开发版完整正常）。改 manualChunks 把 mermaid 及其
  // 布局依赖(layout/dagre 等)归为单一 mermaid chunk，发布版完整加载、布局一致。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/mermaid/") ||
            id.includes("/node_modules/dagre") ||
            id.includes("/node_modules/dagre-d3") ||
            id.includes("/node_modules/@braintree/")
          ) {
            return "mermaid";
          }
        },
      },
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
