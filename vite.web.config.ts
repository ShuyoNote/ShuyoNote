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
  // 恢复代码分割（去掉 inlineDynamicImports）：此前把全部动态 import 内联进主 bundle
  // 导致首屏单 10MB。用 base:"./" 保证 chunk 相对路径在 /app/ 子路径下正确加载，
  // manualChunks 把大库拆成独立 vendor chunk（并行下载 + 缓存）。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("katex")) return "katex";
          if (id.includes("excalidraw")) return "excalidraw";
          if (id.includes("mermaid")) return "mermaid";
          if (id.includes("pdfjs-dist") || id.includes("/pdf.")) return "pdf";
          // react 单独成 chunk：与其它 third-party 分离，便于并行下载 + 长期缓存。
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-jsx-runtime") ||
            id.includes("/scheduler/") ||
            id.includes("/react-router") ||
            id.includes("/zustand/")
          ) {
            return "react";
          }
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
});
