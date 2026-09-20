import { defineConfig } from "vitest/config";

// Isolated Vitest config so the app's Vite build configs (vite.config.ts for
// desktop, vite.web.config.ts for web) are untouched. Pure-function unit tests
// run in a Node environment (no DOM/React).
export default defineConfig({
  test: {
    environment: "happy-dom",
    // `.test.tsx` 与 `.test.ts` 都收：组件测试历史上写成 `.ts` + `React.createElement`
    // （如 `communitySaveDialog.test.ts`），2026-09-20 起新写的组件测试用 `.tsx`
    // （可以用 JSX 搭一个"父级"，真的把浮层卸下来再验定时器停没停）。
    // 两份写法都在跑，判定标准是文件名，不是写法。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    setupFiles: ["src/test/setup.ts"],
  },
});
