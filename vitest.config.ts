import { defineConfig } from "vitest/config";

// Isolated Vitest config so the app's Vite build configs (vite.config.ts for
// desktop, vite.web.config.ts for web) are untouched. Pure-function unit tests
// run in a Node environment (no DOM/React).
export default defineConfig({
  test: {
    // CI 满载并发转译时偶发「测试文件收集失败」（status:failed、message 空）——限并发降负载，
    // 不改任何测试内容/不改 baseline。本地仍用默认（更快）。
    // ⭐ 2026-10-31：`maxWorkers: 2` 下同一提交仍连续两次红（`2393bedf` / `4161743d`，
    //    日志里只剩「2 个测试文件收集失败」，没有 AbortError 之后仍复现）⇒ 再降到 **1**：
    //    runner 只有 2 vCPU；两个 worker 同时跑 happy-dom 文件时，模块收集阶段会因内存/CPU
    //    争抢被打断。代价是 CI 时长涨到 ~4 分钟，换来判据可信（比"重跑就好"便宜）。
    ...(process.env.CI ? { maxWorkers: 1 } : {}),
    environment: "happy-dom",
    // `.test.tsx` 与 `.test.ts` 都收：组件测试历史上写成 `.ts` + `React.createElement`
    // （如 `communitySaveDialog.test.ts`），2026-09-20 起新写的组件测试用 `.tsx`
    // （可以用 JSX 搭一个"父级"，真的把浮层卸下来再验定时器停没停）。
    // 两份写法都在跑，判定标准是文件名，不是写法。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    setupFiles: ["src/test/setup.ts"],
  },
});
