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
  // mermaid 已静态 import；inlineDynamicImports:true 强制把 mermaid/parser 等
  // 动态 chunk 全部内联进主 bundle(零独立 chunk)——彻底规避正式版 chunk 加载失败。
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
