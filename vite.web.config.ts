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
  // NOTE: mermaid 已静态 import（并入主 bundle）；不设 manualChunks 拆分——避免
  // 独立 chunk 在正式版相对路径加载失败 → 布局引擎缺失 → subgraph 叠成一整块。
});
