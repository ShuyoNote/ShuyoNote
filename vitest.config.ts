import { defineConfig } from "vitest/config";

// Isolated Vitest config so the app's Vite build configs (vite.config.ts for
// desktop, vite.web.config.ts for web) are untouched. Pure-function unit tests
// run in a Node environment (no DOM/React).
export default defineConfig({
  test: {
    // CI 满载并发转译时偶发「测试文件收集失败」（status:failed、message 空）——限并发降负载，
    // 不改任何测试内容/不改 baseline。本地仍用默认（更快）。
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
    environment: "happy-dom",
    // `.test.tsx` 与 `.test.ts` 都收：组件测试历史上写成 `.ts` + `React.createElement`
    // （如 `communitySaveDialog.test.ts`），2026-09-20 起新写的组件测试用 `.tsx`
    // （可以用 JSX 搭一个"父级"，真的把浮层卸下来再验定时器停没停）。
    // 两份写法都在跑，判定标准是文件名，不是写法。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    setupFiles: ["src/test/setup.ts"],
  },
});
