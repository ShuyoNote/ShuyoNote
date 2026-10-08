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
    // ★ Android 侧的 WebView 是**系统组件**，可能很老，而 Vite 8 的默认目标是"现代基线"。
    //   真机实测（Xiaomi MIX 2 / Android 9）：系统 WebView 停在 **Chromium 80**，
    //   而产物里有 `??=` ×135 / `||=` ×518 / `&&=` ×88（逻辑赋值，要 **Chromium 85+**）
    //   ⇒ 表现是**整页在启动时挂掉**：`Uncaught SyntaxError: Unexpected token '='`
    //   （不是某个功能降级，是应用根本起不来；而 `minSdk = 24` 说明我们**声称**支持 Android 7+）。
    //   所以把目标钉到 **chrome80** —— 与"目前能实测到的最老设备"对齐。
    //   ⚠️ 这一档**不是最保守**：WebView < 80 的机器（Android 7/8 未更新过的那些）仍会挂。
    //      要不要再往下走（`es2017` 那一档）是一次**产品口径**决定，见交接文档 §6 的记录。
    target: "chrome80",
    rollupOptions: {
      output: {
        // ★ **2026-10-08 实验结论（owner 拍「先做实验」✓）：这一行必须留着 true** ✗→✓
        //   做法：注释掉它 ⇒ npx vite build ⇒ 主包 **10.39MB ⇒ 1.14MB（−89%）** ✓，
        //   懒加载块也都分出来了（白板 DrawingNode 0.17MB ✓／PDF 0.33 ✓／katex ✓／cytoscape ✓）。
        //   ⚠️ **但真桌面里应用直接起不来** ✗ —— 启动屏逐字：
        //      「启动错误 运行时错误：Uncaught ReferenceError: **Prism is not defined**」
        //   ⇒ 拆分改变了模块初始化顺序：某个高亮依赖要的**全局 Prism** 没被建好 ✗。
        //   ⇒ 所以内联不只是为了「chunk 路径」✓，还**顺带压住了这个初始化顺序问题** ✓。
        //   ⭐ 以后想拆包：先把 Prism 那条依赖理顺（显式 import Prism ／ 换 ESM 版 ✓）再关这一行 ✓；
        //      那次实验的**判据**＝真桌面能起来 ＋ 带 mermaid 的页图能画 ✓。
        // ★ **2026-10-08 两次拆包实验的结论：这一行必须留着 true** ✗→✓
        //   实验一（直接关掉）：主包 **10.39MB ⇒ 1.14MB（−89%）** ✓、懒加载块都分出来了 ✓、
        //     懒加载块也能从 `app://` 取到（`fetch` ⇒ 200 ✓）—— **但真桌面起不来** ✗，
        //     启动屏逐字：「启动错误 运行时错误：Uncaught ReferenceError: **Prism is not defined**」。
        //   实验二（把 `src/editor/prismSetup.ts` 提到入口 `main.tsx` 先装 `window.Prism` ✗ 也失败）：
        //     仍然同一个错 ✓、且 `typeof window.Prism === "undefined"` ✓。
        //   ⇒ ⭐ 根因**不在"谁先引入 Prism"**，而在**拆分后 `prismjs` 的模块互操作**：
        //     `import Prism from "prismjs"`（CJS→ESM 的 default interop）在**拆分产物**里拿到 `undefined` ✓，
        //     而 `prismjs/components/*` 那批侧效应组件的加载方式也随之变了 ✓。
        //   ⇒ 想拆包的正确起手式：**先把 prismjs 那摊理顺**（例如 `import * as Prism from "prismjs"` ／
        //     换成 ESM 版高亮器 ／ 用 `@lexical/code-prism` 自带的那条路 ✓），再关这一行 ✓；
        //     判据＝**真桌面能起 ＋ 带 mermaid 的页图能画 ＋ 冷启动 ms 前后对比** ✓。
        //   📌 现状（正式包实测）：冷启动 **1500ms**，其中**主包解析就占 560ms** ✓ ⇒ 这是那 1.5s 的主要来源 ✓。
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
