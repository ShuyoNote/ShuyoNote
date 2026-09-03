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

  // NOTE: mermaid 已改为静态 import；且 inlineDynamicImports:true 强制把 mermaid 主库
  // 与它内部的 parser.core 等动态 chunk 全部内联进主 bundle(零独立 chunk)——否则
  // 桌面 Tauri app:// 下 mermaid-parser.core 这类独立 chunk 相对路径加载失败 → 解析/
  // 布局引擎缺失 → subgraph 叠成一整块(Web http 能加载 chunk 故好、桌面坏)。

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 强制内联所有动态 import（mermaid + parser.core 等进主 bundle，零独立 chunk）——
  // 根治桌面 Tauri app:// 下 chunk 加载失败。
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
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
