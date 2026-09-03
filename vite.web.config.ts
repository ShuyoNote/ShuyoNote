import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated config for running the app in a plain browser (no Tauri backend).
// The Web platform (localStorage-backed mock) serves the ~60 backend commands,
// so `pnpm dev:web` works without the Rust/SQLite host. Uses its own port so it
// can run alongside the Tauri dev server (which uses 1420).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    open: true,
  },
  // 同 vite.config.ts：mermaid 不拆分（web 正式版也完整加载布局引擎，
  // 否则拆成 core/parser 部分缺失导致架构图 subgraph 布局乱）。
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
});
